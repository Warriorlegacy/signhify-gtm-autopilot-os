import { NextRequest, NextResponse } from "next/server";
import type { Fact, IcpDraft } from "@/lib/intake";
import { generateTopics } from "@/lib/llm";
import {
  scoreTopics,
  TOPICS_PROMPT_VERSION,
  type TopicCandidate,
  type TopicSourceProfile,
} from "@/lib/topics";
import { DEFAULT_WORKSPACE_SLUG, getStore, type StoredTopic } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;

/** Validate an inline profile payload into a TopicSourceProfile, or throw. */
function coerceInlineProfile(raw: unknown): TopicSourceProfile {
  const obj = (raw ?? {}) as { url?: unknown; facts?: unknown; icp_draft?: unknown };
  if (!Array.isArray(obj.facts)) {
    throw new Error("Inline 'profile' must include a 'facts' array from an intake result.");
  }
  const facts: Fact[] = [];
  for (const item of obj.facts) {
    const f = (item ?? {}) as Partial<Fact>;
    if (typeof f.id !== "string" || typeof f.text !== "string" || typeof f.kind !== "string") {
      throw new Error("Every inline fact needs string 'id', 'kind' and 'text'.");
    }
    facts.push({ id: f.id, kind: f.kind as Fact["kind"], text: f.text });
  }
  const draft = (obj.icp_draft ?? {}) as Partial<IcpDraft>;
  if (!Array.isArray(draft.audiences)) {
    throw new Error("Inline 'profile' must include an 'icp_draft' with an 'audiences' array.");
  }
  return {
    url: typeof obj.url === "string" ? obj.url : undefined,
    facts,
    icp_draft: draft as IcpDraft,
  };
}

/** Validate an explicitly supplied candidate list, or throw. */
function coerceCandidates(raw: unknown): TopicCandidate[] {
  if (!Array.isArray(raw)) {
    throw new Error("'candidates' must be an array of { title, angle } objects.");
  }
  const candidates: TopicCandidate[] = [];
  for (const item of raw) {
    const c = (item ?? {}) as Partial<TopicCandidate>;
    if (typeof c.title !== "string" || !c.title.trim()) {
      throw new Error("Every candidate needs a non-empty string 'title'.");
    }
    candidates.push({
      title: c.title.trim(),
      angle: typeof c.angle === "string" ? c.angle : "",
    });
  }
  if (candidates.length === 0) {
    throw new Error("'candidates' must contain at least one topic.");
  }
  return candidates;
}

/**
 * POST /api/topics:score
 *   { "product_profile_id": "<id from POST /api/intake>" }
 *   { "profile": { url?, facts, icp_draft } }            (inline profile)
 * Either shape may add "candidates": [{ title, angle }] to score a
 * supplied list instead of generating one, and "count" (default 10) for
 * how many candidates to generate.
 * → { profile_id, provider, prompt_version, topics, dropped_duplicates,
 *     warnings }
 *
 * The topic engine step: candidates are deduped against the profile's
 * stored topics (anti-repetition memory), scored on utility + novelty,
 * and ranked. For a stored profile the kept topics are persisted as
 * candidates and the run is logged with stage "topics" — mirroring how
 * intake persists. As with intake, a persistence failure degrades to a
 * warning rather than failing the scoring.
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  let body: {
    product_profile_id?: unknown;
    profile?: unknown;
    candidates?: unknown;
    count?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const count =
    typeof body?.count === "number" && Number.isFinite(body.count)
      ? Math.min(MAX_COUNT, Math.max(1, Math.floor(body.count)))
      : DEFAULT_COUNT;

  const store = getStore();
  let profileId: string | null = null;
  let source: TopicSourceProfile;
  try {
    if (typeof body?.product_profile_id === "string" && body.product_profile_id.trim()) {
      profileId = body.product_profile_id.trim();
      const stored = await store.getProductProfile(profileId);
      if (!stored) {
        return NextResponse.json(
          { error: `No stored product profile with id ${profileId}.` },
          { status: 404 },
        );
      }
      source = { url: stored.url, facts: stored.facts, icp_draft: stored.icp_draft };
    } else if (body?.profile !== undefined) {
      source = coerceInlineProfile(body.profile);
    } else {
      return NextResponse.json(
        { error: "Body must include 'product_profile_id' or an inline 'profile'." },
        { status: 400 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request." },
      { status: 400 },
    );
  }

  // Anti-repetition memory: titles this profile has already scored.
  let memoryTitles: string[] = [];
  if (profileId) {
    try {
      memoryTitles = (await store.listTopicsForProfile(profileId)).map((t) => t.title);
    } catch {
      memoryTitles = []; // memory is an optimisation; scoring must not fail over it
    }
  }

  let candidates: TopicCandidate[];
  let provider: string;
  try {
    if (body?.candidates !== undefined) {
      candidates = coerceCandidates(body.candidates);
      provider = "provided";
    } else {
      const generated = await generateTopics(source, count);
      candidates = generated.candidates;
      provider = generated.provider;
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid candidates." },
      { status: 400 },
    );
  }

  const { topics, dropped } = scoreTopics(candidates, source, memoryTitles);

  const warnings: string[] = [];
  let storedByIndex: StoredTopic[] = [];
  try {
    if (profileId) {
      storedByIndex = await store.saveTopics(
        DEFAULT_WORKSPACE_SLUG,
        profileId,
        topics.map((topic) => ({
          title: topic.title,
          angle: topic.angle || null,
          score_utility: topic.score_utility,
          score_novelty: topic.score_novelty,
          score_total: topic.score_total,
          source_packet: {
            provider,
            prompt_version: TOPICS_PROMPT_VERSION,
            matched_fact_ids: topic.matched_fact_ids,
            memory_topics_considered: memoryTitles.length,
          },
          prompt_version: TOPICS_PROMPT_VERSION,
          provider,
        })),
      );
    }
    await store.logPipelineRun({
      workspaceSlug: DEFAULT_WORKSPACE_SLUG,
      stage: "topics",
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      provider,
      profileId: profileId ?? undefined,
    });
  } catch (err) {
    warnings.push(
      `These topics could not be saved to the local store (${err instanceof Error ? err.message : "unknown error"}), so they will not join the profile's anti-repetition memory.`,
    );
  }

  return NextResponse.json({
    profile_id: profileId,
    provider,
    prompt_version: TOPICS_PROMPT_VERSION,
    topics: topics.map((topic, i) => ({
      id: storedByIndex[i]?.id ?? null,
      title: topic.title,
      angle: topic.angle,
      score_utility: topic.score_utility,
      score_novelty: topic.score_novelty,
      score_total: topic.score_total,
      matched_fact_ids: topic.matched_fact_ids,
      status: "candidate",
    })),
    dropped_duplicates: dropped,
    warnings,
  });
}

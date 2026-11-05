import { NextRequest, NextResponse } from "next/server";
import type { Fact } from "@/lib/intake";
import {
  evaluatePackGate,
  QUALITY_GATE_THRESHOLD,
  QUALITY_PROMPT_VERSION,
  type PackDraft,
} from "@/lib/quality";
import { DEFAULT_WORKSPACE_SLUG, getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validate an inline facts payload, or throw. */
function coerceFacts(raw: unknown): Fact[] {
  if (!Array.isArray(raw)) {
    throw new Error("'facts' must be an array of intake facts.");
  }
  const facts: Fact[] = [];
  for (const item of raw) {
    const f = (item ?? {}) as Partial<Fact>;
    if (typeof f.id !== "string" || typeof f.text !== "string" || typeof f.kind !== "string") {
      throw new Error("Every fact needs string 'id', 'kind' and 'text'.");
    }
    facts.push({ id: f.id, kind: f.kind as Fact["kind"], text: f.text });
  }
  return facts;
}

/**
 * POST /api/packs:gate
 *   { "pack": { "format"?, "narrative"?, "caption"? },
 *     "product_profile_id": "<id from POST /api/intake>" }
 *   — or — "facts": [ …intake facts… ] (or "profile": { "facts": […] })
 * → { quality_score, fact_check, approval_allowed, gate_reasons,
 *     threshold, prompt_version }
 *
 * Evaluates a pack draft against the product's verified facts (from the
 * intake record) and answers the one question the approval flow asks:
 * may this pack be approved? The decision itself lives in
 * lib/quality.ts (canApprovePack) — this route only resolves inputs and
 * reports. The evaluation is logged as a pipeline run with stage
 * "packs"; that bookkeeping is best-effort and never fails an evaluation.
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  let body: {
    pack?: unknown;
    product_profile_id?: unknown;
    facts?: unknown;
    profile?: { facts?: unknown };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const pack = (body?.pack ?? {}) as PackDraft;
  const hasNarrative =
    pack.narrative !== undefined && pack.narrative !== null && pack.narrative !== "";
  const hasCaption = typeof pack.caption === "string" && pack.caption.trim().length > 0;
  if (!body?.pack || typeof body.pack !== "object" || (!hasNarrative && !hasCaption)) {
    return NextResponse.json(
      { error: "Body must include a 'pack' with a 'narrative' and/or a 'caption'." },
      { status: 400 },
    );
  }

  const store = getStore();
  let profileId: string | null = null;
  let facts: Fact[];
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
      facts = stored.facts;
    } else if (body?.facts !== undefined) {
      facts = coerceFacts(body.facts);
    } else if (body?.profile?.facts !== undefined) {
      facts = coerceFacts(body.profile.facts);
    } else {
      return NextResponse.json(
        { error: "Body must include 'product_profile_id', 'facts', or a 'profile' with facts." },
        { status: 400 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request." },
      { status: 400 },
    );
  }

  const evaluation = evaluatePackGate(pack, facts);

  try {
    await store.logPipelineRun({
      workspaceSlug: DEFAULT_WORKSPACE_SLUG,
      stage: "packs",
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      provider: "deterministic-baseline",
      profileId: profileId ?? undefined,
    });
  } catch {
    // Bookkeeping only — an evaluation must not fail over a log write.
  }

  return NextResponse.json({
    profile_id: profileId,
    quality_score: evaluation.quality_score,
    fact_check: evaluation.fact_check,
    approval_allowed: evaluation.approval_allowed,
    gate_reasons: evaluation.gate_reasons,
    threshold: QUALITY_GATE_THRESHOLD,
    prompt_version: QUALITY_PROMPT_VERSION,
  });
}

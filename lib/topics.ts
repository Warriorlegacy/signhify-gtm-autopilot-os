/**
 * lib/topics.ts — the topic engine: candidate generation (deterministic
 * baseline), dedupe and scoring. Ported from Autogram's topic-scoring
 * design into pure functions (no network, no env access) so they are
 * unit-testable, exactly like lib/intake.ts.
 *
 * Pipeline: candidates → dedupe (against this batch AND the profile's
 * stored topics — the anti-repetition memory) → score → rank.
 *
 * Scoring rubric (all dimensions 0–100, documented here so a score can
 * always be explained after the fact):
 *
 *  score_utility — is this topic worth publishing for THIS product?
 *    20 base
 *    + up to 40 × (share of the topic's content tokens that appear in the
 *      ICP draft's audience names / pain texts — the topic speaks to a
 *      named audience pain)
 *    + up to 25 × (share of the topic's content tokens that appear in the
 *      extracted page facts — the topic is about what the product
 *      actually does, not generic content)
 *    + up to 15 for a specific angle: 10 when the angle is a real sentence
 *      (≥ 8 words), 5 when it is short (≥ 4 words), + 5 when it carries a
 *      format cue (guide, checklist, how, mistakes, teardown, …)
 *
 *  score_novelty — the anti-repetition dimension:
 *    100 × (1 − highest title similarity to any remembered topic — the
 *    profile's stored topics plus the other kept candidates in this
 *    batch). A repeat of a stored topic scores 0.
 *
 *  score_total = round(0.6 × utility + 0.4 × novelty).
 *
 * Dedupe: a candidate is dropped when its normalised title matches a
 * remembered/kept title exactly, or its title-token Jaccard similarity to
 * one reaches DEDUPE_SIMILARITY_THRESHOLD. Drops are reported, never
 * silently swallowed.
 */

import type { Fact, IcpDraft } from "./intake";

export const TOPICS_PROMPT_VERSION = "topics-baseline-v1";

/** Title-token Jaccard at or above this counts as the same topic. */
export const DEDUPE_SIMILARITY_THRESHOLD = 0.6;

export interface TopicCandidate {
  title: string;
  angle: string;
}

/** The slice of a product profile the topic engine reads. */
export interface TopicSourceProfile {
  url?: string;
  facts: Fact[];
  icp_draft: IcpDraft;
}

export interface ScoredTopic extends TopicCandidate {
  score_utility: number;
  score_novelty: number;
  score_total: number;
  /** Page facts this topic's wording actually draws on (traceability). */
  matched_fact_ids: string[];
}

export interface DroppedDuplicate {
  title: string;
  angle: string;
  /** Title of the topic it duplicates. */
  duplicate_of: string;
  similarity: number;
  /** "memory" = a previously stored topic; "batch" = a kept candidate. */
  against: "memory" | "batch";
}

export interface TopicScoringResult {
  topics: ScoredTopic[];
  dropped: DroppedDuplicate[];
}

/* ------------------------------------------------------------------ */
/* Text normalisation + similarity                                     */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "your", "you", "our", "their", "its", "it", "is", "are", "be", "how",
  "why", "what", "when", "that", "this", "from", "into", "without",
  "about", "can", "get", "got", "every", "any", "all", "more", "most",
]);

/** Content tokens: lowercase alphanumeric words minus stopwords. */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/** Normalised title key: case, whitespace, surrounding quotes, trailing stops. */
export function normaliseTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\.+$/, "")
    .trim();
}

/** Jaccard similarity of two token sets (0 when either is empty). */
export function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Title similarity: exact normalised match is 1, else title-token Jaccard. */
export function titleSimilarity(a: string, b: string): number {
  if (normaliseTitleKey(a) === normaliseTitleKey(b)) return 1;
  return tokenSimilarity(contentTokens(a), contentTokens(b));
}

/* ------------------------------------------------------------------ */
/* Dedupe (anti-repetition)                                            */
/* ------------------------------------------------------------------ */

interface Remembered {
  title: string;
  key: string;
  tokens: Set<string>;
  against: "memory" | "batch";
}

function remember(title: string, against: "memory" | "batch"): Remembered {
  return { title, key: normaliseTitleKey(title), tokens: contentTokens(title), against };
}

/**
 * Drop candidates that repeat a stored topic (memory) or each other
 * (batch). First occurrence wins; drops carry the winning title and the
 * similarity that condemned them.
 */
export function dedupeTopics(
  candidates: TopicCandidate[],
  memoryTitles: string[],
): { kept: TopicCandidate[]; dropped: DroppedDuplicate[] } {
  const remembered: Remembered[] = memoryTitles.map((t) => remember(t, "memory"));
  const kept: TopicCandidate[] = [];
  const dropped: DroppedDuplicate[] = [];

  for (const candidate of candidates) {
    const title = candidate.title.trim();
    if (!title) continue;
    const key = normaliseTitleKey(title);
    const tokens = contentTokens(title);

    let worst: { of: Remembered; similarity: number } | null = null;
    for (const other of remembered) {
      const similarity =
        other.key === key ? 1 : tokenSimilarity(tokens, other.tokens);
      if (similarity >= DEDUPE_SIMILARITY_THRESHOLD && (!worst || similarity > worst.similarity)) {
        worst = { of: other, similarity };
      }
    }
    if (worst) {
      dropped.push({
        title,
        angle: candidate.angle,
        duplicate_of: worst.of.title,
        similarity: Math.round(worst.similarity * 100) / 100,
        against: worst.of.against,
      });
      continue;
    }
    kept.push({ title, angle: candidate.angle });
    remembered.push(remember(title, "batch"));
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

const FORMAT_CUES = [
  "guide", "checklist", "how to", "mistakes", "teardown", "playbook",
  "template", "examples", "walkthrough", "breakdown", "workflow",
];

function angleSpecificity(angle: string): number {
  const words = angle.trim().split(/\s+/).filter(Boolean).length;
  let score = words >= 8 ? 10 : words >= 4 ? 5 : 0;
  const lower = angle.toLowerCase();
  if (FORMAT_CUES.some((cue) => lower.includes(cue))) score += 5;
  return score; // max 15
}

function overlapRatio(topicTokens: Set<string>, corpus: Set<string>): number {
  if (topicTokens.size === 0) return 0;
  let hits = 0;
  for (const token of topicTokens) if (corpus.has(token)) hits += 1;
  return hits / topicTokens.size;
}

/** Score one topic's utility against the profile, per the rubric above. */
export function scoreUtility(
  topic: TopicCandidate,
  profile: TopicSourceProfile,
): { score: number; matchedFactIds: string[] } {
  const topicTokens = contentTokens(`${topic.title} ${topic.angle}`);

  const factCorpus = new Set<string>();
  const matchedFactIds: string[] = [];
  for (const fact of profile.facts) {
    const factTokens = contentTokens(fact.text);
    for (const token of factTokens) factCorpus.add(token);
    // A fact counts as drawn-on when the topic shares at least two of its
    // content tokens (one shared word is coincidence, not grounding).
    let shared = 0;
    for (const token of factTokens) if (topicTokens.has(token)) shared += 1;
    if (shared >= 2) matchedFactIds.push(fact.id);
  }

  const painCorpus = new Set<string>();
  for (const audience of profile.icp_draft.audiences) {
    for (const token of contentTokens(audience.name)) painCorpus.add(token);
    for (const pain of audience.pains) {
      for (const token of contentTokens(pain.text)) painCorpus.add(token);
    }
  }

  const score =
    20 +
    40 * overlapRatio(topicTokens, painCorpus) +
    25 * overlapRatio(topicTokens, factCorpus) +
    angleSpecificity(topic.angle);
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    matchedFactIds,
  };
}

/** Novelty of one topic against remembered titles (stored + batch-kept). */
export function scoreNovelty(topic: TopicCandidate, rememberedTitles: string[]): number {
  let maxSimilarity = 0;
  for (const title of rememberedTitles) {
    maxSimilarity = Math.max(maxSimilarity, titleSimilarity(topic.title, title));
  }
  return Math.round(100 * (1 - maxSimilarity));
}

/**
 * Full pipeline: dedupe, score, rank. Ranking is by score_total
 * descending with a title tiebreak, so the output order is deterministic
 * for identical inputs.
 */
export function scoreTopics(
  candidates: TopicCandidate[],
  profile: TopicSourceProfile,
  memoryTitles: string[],
): TopicScoringResult {
  const { kept, dropped } = dedupeTopics(candidates, memoryTitles);
  const keptTitles = kept.map((t) => t.title);

  const topics: ScoredTopic[] = kept.map((topic) => {
    const { score, matchedFactIds } = scoreUtility(topic, profile);
    const novelty = scoreNovelty(topic, [
      ...memoryTitles,
      ...keptTitles.filter((t) => t !== topic.title),
    ]);
    return {
      ...topic,
      score_utility: score,
      score_novelty: novelty,
      score_total: Math.round(0.6 * score + 0.4 * novelty),
      matched_fact_ids: matchedFactIds,
    };
  });

  topics.sort(
    (a, b) => b.score_total - a.score_total || a.title.localeCompare(b.title),
  );
  return { topics, dropped };
}

/* ------------------------------------------------------------------ */
/* Deterministic baseline candidate builder                            */
/* ------------------------------------------------------------------ */

const MAX_CANDIDATES = 10;
const MAX_PAINS_PER_AUDIENCE = 2;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build topic candidates from the ICP draft — deterministic, no LLM.
 * Every candidate is anchored to an audience pain or a page fact from the
 * profile itself, so the baseline never invents a subject the product
 * page did not raise. (The LLM providers in lib/llm.ts write freer
 * candidates; they pass through the same dedupe + scoring.)
 */
export function buildTopicCandidates(
  profile: TopicSourceProfile,
  count: number = MAX_CANDIDATES,
): TopicCandidate[] {
  const candidates: TopicCandidate[] = [];
  const draft = profile.icp_draft;

  for (const audience of draft.audiences) {
    candidates.push({
      title: `A field guide for ${audience.name}`,
      angle: `A practical guide for ${audience.name}: the pains named in the ICP draft, worked through one by one with the product's own workflow as the fix.`,
    });
    for (const pain of audience.pains.slice(0, MAX_PAINS_PER_AUDIENCE)) {
      candidates.push({
        title: truncate(pain.text.replace(/\.+$/, ""), 140),
        angle: `Problem breakdown for ${audience.name}: why this happens, what it costs, and the workflow that replaces it.`,
      });
    }
  }

  const anchor =
    profile.facts.find((f) => f.kind === "description") ??
    profile.facts.find((f) => f.kind === "title");
  if (anchor) {
    candidates.push({
      title: `Positioning, in their own words: ${truncate(anchor.text, 90)}`,
      angle:
        "Teardown of the product's own positioning statement: what it promises, who it is really for, and where the proof lives on the page.",
    });
  }

  for (const fact of profile.facts.filter((f) => f.kind === "heading").slice(0, 2)) {
    candidates.push({
      title: truncate(fact.text.replace(/\.+$/, ""), 140),
      angle:
        "Walkthrough built on a headline claim from the product's own page: what it means in practice, with examples.",
    });
  }

  return candidates.slice(0, Math.max(1, count));
}

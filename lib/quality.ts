/**
 * lib/quality.ts — fact-check + quality gate for content packs.
 *
 * The Day 4 half of the pipeline: a pack draft (structured narrative +
 * caption) is checked against the product profile's VERIFIED facts — the
 * facts intake extracted from the product's own page, carried in the
 * intake record's source_packet. Pure functions, deterministic baseline:
 * no LLM is required for a verdict. (The gateway in lib/llm.ts may enrich
 * wording later; the gate never depends on it.)
 *
 * How a verdict is reached (baseline heuristics, deliberately auditable):
 *  1. The pack's text is split into sentences. A sentence is a CHECKABLE
 *     CLAIM when it carries a number/statistic, a strong-claim marker
 *     (best, only, guaranteed, proven, …), or a concrete named entity
 *     mid-sentence ("integrates with Slack and Google Drive" — an
 *     integration claim is falsifiable even without a figure). Pure
 *     framing and CTAs are not claims and are never verdicted.
 *  2. Each claim is matched to its closest fact by content-token overlap.
 *  3. Verdicts:
 *     - supported: every number in the claim appears in the matched fact
 *       (or some fact), or — for number-free claims — the matched fact
 *       overlaps strongly with no negation flip.
 *     - contradicted: the closest fact is clearly about the same
 *       statement (overlap ≥ 0.5) but states different figures, or the
 *       claim negates what the fact says ("no free plan" vs a fact that
 *       states a free plan).
 *     - unsupported: no fact backs the claim. Not proven false — just not
 *       something the product's own page ever said.
 *
 * Quality score (0–100, stored on content_packs.quality_score):
 *   100 − 40 per contradicted claim − 15 per unsupported claim
 *       − 5 for a missing caption − 20 for an empty narrative,
 *   and a pack with ZERO checkable claims is capped at 60: structure
 *   alone can never clear the gate, because there is nothing to verify.
 *
 * The gate (schema: content_packs): a pack may move to status 'approved'
 * only when quality_score ≥ QUALITY_GATE_THRESHOLD and no claim is
 * contradicted. canApprovePack is the single function that decides; the
 * route and any future UI must go through it.
 */

import type { Fact } from "./intake";
import { contentTokens } from "./topics";

export const QUALITY_PROMPT_VERSION = "quality-baseline-v1";

/** Minimum quality_score for a pack to be approvable (PRD gate). */
export const QUALITY_GATE_THRESHOLD = 70;

/** A pack with no checkable claims can score at most this — below the gate. */
const NO_CLAIMS_SCORE_CAP = 60;

/** Overlap at/above which a fact is clearly "about" the claim's statement. */
const SAME_STATEMENT_OVERLAP = 0.5;
/** Overlap at/above which a number-free claim counts as backed by a fact. */
const SUPPORT_OVERLAP = 0.45;

/* ------------------------------ types ------------------------------- */

export interface PackDraft {
  format?: string;
  /** Structured narrative JSON (slides, script beats, …) — walked for text. */
  narrative?: unknown;
  caption?: string;
}

export type ClaimVerdict = "supported" | "unsupported" | "contradicted";

export interface ClaimCheck {
  text: string;
  verdict: ClaimVerdict;
  /** The fact the verdict rests on (null when no fact came close). */
  evidence_fact_id: string | null;
  /** The evidence fact's text, quoted verbatim. */
  evidence: string | null;
  reason: string;
}

/** The shape stored in content_packs.fact_check. */
export interface FactCheck {
  version: string;
  claims: ClaimCheck[];
  summary: { total: number; supported: number; unsupported: number; contradicted: number };
}

export interface PackEvaluation {
  fact_check: FactCheck;
  quality_score: number;
  approval_allowed: boolean;
  gate_reasons: string[];
}

/* --------------------------- text handling -------------------------- */

/** Collect every string out of a structured narrative, in order. */
export function extractPackText(narrative: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim()) parts.push(value.trim());
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(narrative);
  return parts.join("\n");
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const STRONG_CLAIM_MARKERS = [
  "best", "fastest", "slowest", "first", "only", "guarantee", "guaranteed",
  "guarantees", "proven", "leading", "largest", "cheapest", "unlimited",
  "#1", "zero", "award-winning", "award winning",
];

/** A sentence is checkable when it states something falsifiable. */
export function isCheckableClaim(sentence: string): boolean {
  if (/\d/.test(sentence)) return true;
  const lower = ` ${sentence.toLowerCase()} `;
  if (
    STRONG_CLAIM_MARKERS.some(
      (marker) => lower.includes(` ${marker}`) || lower.includes(`${marker} `),
    )
  ) {
    return true;
  }
  // A capitalised name after the first word (Slack, Google Drive) is a
  // concrete reference the product page either backs or does not.
  const afterFirstWord = sentence.replace(/^\S+\s+/, "");
  return /\b[A-Z][a-z]{2,}\b/.test(afterFirstWord) || /\b[A-Z]{2,}\b/.test(afterFirstWord);
}

/** The checkable claims in a pack draft (narrative first, then caption). */
export function extractClaims(pack: PackDraft): string[] {
  const text = [extractPackText(pack.narrative), pack.caption ?? ""]
    .filter((part) => part.trim())
    .join("\n");
  return splitSentences(text).filter(isCheckableClaim);
}

/**
 * Numbers in a text, normalised for comparison: thousands separators
 * removed, trailing decimal zeros dropped ("2,000" → "2000", "12.0" → "12",
 * "99.9" stays "99.9").
 */
export function extractNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    let n = match[0].replace(/,/g, "");
    if (n.includes(".")) n = n.replace(/\.?0+$/, "");
    if (n) found.add(n);
  }
  return [...found];
}

/* ----------------------------- verdicts ----------------------------- */

interface FactMatch {
  fact: Fact;
  /** Share of the claim's content tokens that appear in the fact. */
  overlap: number;
  numbers: string[];
}

function matchFacts(claimTokens: Set<string>, facts: Fact[]): FactMatch[] {
  return facts
    .map((fact) => {
      const factTokens = contentTokens(fact.text);
      let shared = 0;
      for (const token of claimTokens) if (factTokens.has(token)) shared += 1;
      return {
        fact,
        overlap: claimTokens.size === 0 ? 0 : shared / claimTokens.size,
        numbers: extractNumbers(fact.text),
      };
    })
    .sort((a, b) => b.overlap - a.overlap);
}

const NEGATION = /\b(no|not|never|without|isn't|aren't|don't|doesn't|cannot|can't|won't)\b/i;

/** Verdict one claim against the verified facts. */
export function checkClaim(claim: string, facts: Fact[]): ClaimCheck {
  const claimNumbers = extractNumbers(claim);
  const matches = matchFacts(contentTokens(claim), facts);
  const best = matches[0];

  const base = { text: claim, evidence_fact_id: null as string | null, evidence: null as string | null };
  const withEvidence = (match: FactMatch) => ({
    evidence_fact_id: match.fact.id,
    evidence: match.fact.text,
  });

  if (claimNumbers.length > 0) {
    if (best && claimNumbers.every((n) => best.numbers.includes(n))) {
      return {
        ...base,
        ...withEvidence(best),
        verdict: "supported",
        reason: "Every figure in the claim appears in the matched fact.",
      };
    }
    const anyMatch = matches.find((m) => claimNumbers.every((n) => m.numbers.includes(n)));
    if (anyMatch) {
      return {
        ...base,
        ...withEvidence(anyMatch),
        verdict: "supported",
        reason: "Every figure in the claim appears in a verified fact.",
      };
    }
    if (best && best.overlap >= SAME_STATEMENT_OVERLAP && best.numbers.length > 0) {
      return {
        ...base,
        ...withEvidence(best),
        verdict: "contradicted",
        reason:
          "The closest verified fact is about the same statement but states different figures.",
      };
    }
    return {
      ...base,
      verdict: "unsupported",
      reason: "No verified fact contains the figures this claim states.",
    };
  }

  if (best && best.overlap >= SUPPORT_OVERLAP) {
    const claimNegates = NEGATION.test(claim);
    const factNegates = NEGATION.test(best.fact.text);
    if (claimNegates !== factNegates) {
      return {
        ...base,
        ...withEvidence(best),
        verdict: "contradicted",
        reason: "The claim negates what the closest verified fact states.",
      };
    }
    return {
      ...base,
      ...withEvidence(best),
      verdict: "supported",
      reason: "The claim closely matches a verified fact.",
    };
  }

  return {
    ...base,
    verdict: "unsupported",
    reason: "No verified fact backs this claim.",
  };
}

/** Fact-check every checkable claim in a pack against the verified facts. */
export function checkPack(pack: PackDraft, facts: Fact[]): FactCheck {
  const claims = extractClaims(pack).map((claim) => checkClaim(claim, facts));
  return {
    version: QUALITY_PROMPT_VERSION,
    claims,
    summary: {
      total: claims.length,
      supported: claims.filter((c) => c.verdict === "supported").length,
      unsupported: claims.filter((c) => c.verdict === "unsupported").length,
      contradicted: claims.filter((c) => c.verdict === "contradicted").length,
    },
  };
}

/* ------------------------- score + the gate ------------------------- */

/** The 0–100 quality score, per the rubric in the header. */
export function scoreQuality(pack: PackDraft, factCheck: FactCheck): number {
  let score = 100;
  score -= 40 * factCheck.summary.contradicted;
  score -= 15 * factCheck.summary.unsupported;
  if (!pack.caption?.trim()) score -= 5;
  if (!extractPackText(pack.narrative).trim()) score -= 20;
  if (factCheck.summary.total === 0) score = Math.min(score, NO_CLAIMS_SCORE_CAP);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * THE gate: may this pack move to status 'approved'? Decided in exactly
 * one place so the route, a future UI and the scheduler can never drift
 * apart: quality_score must clear the threshold AND no claim may be
 * contradicted by the product's verified facts.
 */
export function canApprovePack(pack: {
  quality_score: number;
  fact_check: FactCheck;
}): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (pack.fact_check.summary.contradicted > 0) {
    reasons.push(
      `${pack.fact_check.summary.contradicted} claim(s) are contradicted by the product's verified facts.`,
    );
  }
  if (pack.quality_score < QUALITY_GATE_THRESHOLD) {
    reasons.push(
      `Quality score ${pack.quality_score} is below the ${QUALITY_GATE_THRESHOLD} approval threshold.`,
    );
  }
  return { allowed: reasons.length === 0, reasons };
}

/** Full evaluation: fact-check → score → gate decision. */
export function evaluatePackGate(pack: PackDraft, facts: Fact[]): PackEvaluation {
  const fact_check = checkPack(pack, facts);
  const quality_score = scoreQuality(pack, fact_check);
  const gate = canApprovePack({ quality_score, fact_check });
  return {
    fact_check,
    quality_score,
    approval_allowed: gate.allowed,
    gate_reasons: gate.reasons,
  };
}

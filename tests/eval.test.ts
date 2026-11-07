import { describe, expect, it } from "vitest";
import type { Fact } from "@/lib/intake";
import {
  evaluatePackGate,
  QUALITY_GATE_THRESHOLD,
  type PackDraft,
} from "@/lib/quality";
import {
  buildTopicCandidates,
  scoreTopics,
  type TopicCandidate,
  type TopicSourceProfile,
} from "@/lib/topics";
import goldenProfile from "./fixtures/golden-profile.json";
import goldenPackClean from "./fixtures/golden-pack-clean.json";
import goldenPackPlanted from "./fixtures/golden-pack-planted.json";
import goldenPackLowQuality from "./fixtures/golden-pack-low-quality.json";
import goldenPackBorderline from "./fixtures/golden-pack-borderline.json";

/**
 * Golden-pack eval harness (Day 5).
 *
 * Every golden pack runs through BOTH real pipeline stages:
 *  1. topic scoring (lib/topics.ts) — the pack's topic must survive
 *     dedupe and clear its minimum total score, and
 *  2. the quality gate (lib/quality.ts) — the pack's approval decision,
 *     quality score and claim summary must match the expected verdict
 *     recorded next to the fixture.
 * CI runs this suite on every push (npm test and npm run eval).
 */

const facts = goldenProfile.facts as Fact[];
const profile = goldenProfile as unknown as TopicSourceProfile;

interface GoldenCase {
  name: string;
  pack: PackDraft;
  topic: TopicCandidate;
  expected: {
    approval_allowed: boolean;
    quality_score: number;
    supported: number;
    unsupported: number;
    contradicted: number;
    topic_min_total: number;
  };
}

const GROUNDED_TOPIC: TopicCandidate = {
  title: "Approvals without the email chase",
  angle:
    "A practical guide for small agencies: approvals and follow-ups without scattered email threads, using the product's own workflow as the fix.",
};

const CASES: GoldenCase[] = [
  {
    name: "clean pack passes the gate",
    pack: goldenPackClean as PackDraft,
    topic: GROUNDED_TOPIC,
    expected: {
      approval_allowed: true,
      quality_score: 100,
      supported: 4,
      unsupported: 0,
      contradicted: 0,
      topic_min_total: 50,
    },
  },
  {
    name: "planted contradicted claims are blocked",
    pack: goldenPackPlanted as PackDraft,
    topic: GROUNDED_TOPIC,
    expected: {
      approval_allowed: false,
      quality_score: 30,
      supported: 0,
      unsupported: 2,
      contradicted: 1,
      topic_min_total: 50,
    },
  },
  {
    name: "low-quality pack below the threshold is blocked",
    pack: goldenPackLowQuality as PackDraft,
    topic: GROUNDED_TOPIC,
    expected: {
      approval_allowed: false,
      quality_score: 55,
      supported: 0,
      unsupported: 3,
      contradicted: 0,
      topic_min_total: 50,
    },
  },
  {
    name: "borderline pack at exactly the threshold passes",
    pack: goldenPackBorderline as PackDraft,
    topic: GROUNDED_TOPIC,
    expected: {
      approval_allowed: true,
      quality_score: QUALITY_GATE_THRESHOLD,
      supported: 4,
      unsupported: 2,
      contradicted: 0,
      topic_min_total: 50,
    },
  },
];

describe("golden-pack eval", () => {
  for (const golden of CASES) {
    it(golden.name, () => {
      // Stage 1: topic scoring.
      const scored = scoreTopics([golden.topic], profile, []);
      expect(scored.dropped).toEqual([]);
      expect(scored.topics).toHaveLength(1);
      expect(scored.topics[0].score_total).toBeGreaterThanOrEqual(golden.expected.topic_min_total);
      expect(scored.topics[0].matched_fact_ids.length).toBeGreaterThan(0);

      // Stage 2: fact-check + quality gate.
      const evaluation = evaluatePackGate(golden.pack, facts);
      expect(evaluation.fact_check.summary.supported).toBe(golden.expected.supported);
      expect(evaluation.fact_check.summary.unsupported).toBe(golden.expected.unsupported);
      expect(evaluation.fact_check.summary.contradicted).toBe(golden.expected.contradicted);
      expect(evaluation.quality_score).toBe(golden.expected.quality_score);
      expect(evaluation.approval_allowed).toBe(golden.expected.approval_allowed);
      if (golden.expected.approval_allowed) {
        expect(evaluation.gate_reasons).toEqual([]);
      } else {
        expect(evaluation.gate_reasons.length).toBeGreaterThan(0);
      }
    });
  }

  it("the full baseline pipeline stays deterministic: candidates score and rank", () => {
    const candidates = buildTopicCandidates(profile);
    expect(candidates.length).toBeGreaterThan(0);
    const first = scoreTopics(candidates, profile, []);
    const second = scoreTopics(candidates, profile, []);
    expect(first.topics.map((t) => t.title)).toEqual(second.topics.map((t) => t.title));
    const totals = first.topics.map((t) => t.score_total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });
});

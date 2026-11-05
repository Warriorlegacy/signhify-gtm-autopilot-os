import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { Fact } from "@/lib/intake";
import {
  canApprovePack,
  checkClaim,
  evaluatePackGate,
  extractClaims,
  extractNumbers,
  QUALITY_GATE_THRESHOLD,
} from "@/lib/quality";
import goldenProfile from "./fixtures/golden-profile.json";
import goldenPackClean from "./fixtures/golden-pack-clean.json";
import goldenPackPlanted from "./fixtures/golden-pack-planted.json";

const facts = goldenProfile.facts as Fact[];

describe("extractNumbers / extractClaims", () => {
  it("normalises figures for comparison", () => {
    expect(extractNumbers("Join 2,000+ teams at $12.0 per seat, 99.9% uptime")).toEqual([
      "2000",
      "12",
      "99.9",
    ]);
  });

  it("only treats falsifiable sentences as claims", () => {
    const claims = extractClaims({
      narrative: { slides: [{ headline: "Security covered", body: "Hello and welcome." }] },
      caption: "FlowBoard is the best board tool for agencies.",
    });
    expect(claims).toEqual(["FlowBoard is the best board tool for agencies."]);
  });
});

describe("checkClaim verdicts", () => {
  it("supports a claim whose figures match a fact", () => {
    const check = checkClaim("FlowBoard plans start at $12 per user per month.", facts);
    expect(check.verdict).toBe("supported");
    expect(check.evidence_fact_id).toBe("f2");
    expect(check.evidence).toContain("$12");
  });

  it("contradicts a claim whose figures fight the closest fact", () => {
    const check = checkClaim("FlowBoard costs just $5 per user per month.", facts);
    expect(check.verdict).toBe("contradicted");
    expect(check.evidence_fact_id).toBe("f2");
  });

  it("contradicts a claim that negates a fact", () => {
    const check = checkClaim("FlowBoard has no free plan.", facts);
    expect(check.verdict).toBe("contradicted");
  });

  it("marks an invented figure as unsupported, not contradicted", () => {
    const check = checkClaim("FlowBoard guarantees 99.9% uptime for every workspace.", facts);
    expect(check.verdict).toBe("unsupported");
    expect(check.evidence_fact_id).toBeNull();
  });
});

describe("golden-pack eval", () => {
  it("approves the clean pack: every claim supported, score at the top", () => {
    const evaluation = evaluatePackGate(goldenPackClean, facts);
    expect(evaluation.fact_check.summary).toEqual({
      total: 4,
      supported: 4,
      unsupported: 0,
      contradicted: 0,
    });
    for (const claim of evaluation.fact_check.claims) {
      expect(claim.verdict).toBe("supported");
      expect(claim.evidence).toBeTruthy();
    }
    expect(evaluation.quality_score).toBe(100);
    expect(evaluation.quality_score).toBeGreaterThanOrEqual(QUALITY_GATE_THRESHOLD);
    expect(evaluation.approval_allowed).toBe(true);
    expect(evaluation.gate_reasons).toEqual([]);
  });

  it("blocks the planted pack: contradicted price, invented claims", () => {
    const evaluation = evaluatePackGate(goldenPackPlanted, facts);
    const byText = new Map(evaluation.fact_check.claims.map((c) => [c.text, c.verdict]));
    expect(byText.get("FlowBoard costs just $5 per user per month.")).toBe("contradicted");
    expect(byText.get("FlowBoard guarantees 99.9% uptime for every workspace.")).toBe(
      "unsupported",
    );
    expect(
      byText.get("FlowBoard is the only project tool with a built-in video editor."),
    ).toBe("unsupported");
    expect(evaluation.fact_check.summary.contradicted).toBe(1);
    expect(evaluation.quality_score).toBeLessThan(QUALITY_GATE_THRESHOLD);
    expect(evaluation.approval_allowed).toBe(false);
    expect(evaluation.gate_reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("canApprovePack is the single gate: a high score cannot rescue a contradiction", () => {
    const fact_check = {
      version: "quality-baseline-v1",
      claims: [],
      summary: { total: 1, supported: 0, unsupported: 0, contradicted: 1 },
    };
    expect(canApprovePack({ quality_score: 95, fact_check }).allowed).toBe(false);
    expect(
      canApprovePack({
        quality_score: QUALITY_GATE_THRESHOLD,
        fact_check: {
          ...fact_check,
          summary: { total: 1, supported: 1, unsupported: 0, contradicted: 0 },
        },
      }).allowed,
    ).toBe(true);
  });
});

describe("POST /api/packs:gate", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gtm-gate-route-"));
    process.env.GTM_DATA_DIR = dir;
    ({ POST } = await import("@/app/api/packs/gate/route"));
  });

  function post(body: unknown): Promise<Response> {
    return POST(
      new NextRequest("http://localhost/api/packs/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("evaluates a pack against inline facts", async () => {
    const res = await post({ pack: goldenPackClean, facts });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      quality_score: number;
      approval_allowed: boolean;
      threshold: number;
      fact_check: { summary: { supported: number } };
    };
    expect(data.approval_allowed).toBe(true);
    expect(data.quality_score).toBe(100);
    expect(data.threshold).toBe(QUALITY_GATE_THRESHOLD);
    expect(data.fact_check.summary.supported).toBe(4);
  });

  it("blocks the planted pack through the route too", async () => {
    const res = await post({ pack: goldenPackPlanted, facts });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { approval_allowed: boolean; gate_reasons: string[] };
    expect(data.approval_allowed).toBe(false);
    expect(data.gate_reasons.length).toBeGreaterThan(0);
  });

  it("400s without a pack or without any fact source", async () => {
    expect((await post({ facts })).status).toBe(400);
    expect((await post({ pack: goldenPackClean })).status).toBe(400);
  });

  it("404s an unknown product_profile_id", async () => {
    const res = await post({ pack: goldenPackClean, product_profile_id: "no-such-profile" });
    expect(res.status).toBe(404);
  });
});

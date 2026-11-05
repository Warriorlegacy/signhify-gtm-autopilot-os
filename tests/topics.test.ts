import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { buildIcpDraft, extractFacts, type Fact, type IcpDraft } from "@/lib/intake";
import { LocalStore } from "@/lib/store";
import {
  buildTopicCandidates,
  dedupeTopics,
  scoreNovelty,
  scoreTopics,
  scoreUtility,
  titleSimilarity,
  type TopicSourceProfile,
} from "@/lib/topics";

const fixtureHtml = readFileSync(
  path.join(__dirname, "fixtures", "product-page.html"),
  "utf8",
);

function fixtureProfile(): TopicSourceProfile {
  const facts = extractFacts(fixtureHtml);
  return { url: "https://flowboard.example/", facts, icp_draft: buildIcpDraft(facts) };
}

const manualFacts: Fact[] = [
  { id: "f1", kind: "title", text: "FlowBoard — project boards for small agencies" },
  {
    id: "f2",
    kind: "description",
    text: "FlowBoard helps small agencies run client approvals and follow-ups in one place.",
  },
];

const manualDraft: IcpDraft = {
  positioning: "Positioning as stated on the page itself.",
  claims_cited: true,
  prompt_version: "icp-baseline-v1",
  audiences: [
    {
      name: "Small agencies (2–10 people)",
      evidence: ["f2"],
      pains: [
        {
          text: "Approvals and follow-ups live in scattered threads, so leads go cold.",
          evidence: ["f2"],
        },
      ],
    },
  ],
};

const manualProfile: TopicSourceProfile = {
  url: "https://flowboard.example/",
  facts: manualFacts,
  icp_draft: manualDraft,
};

describe("titleSimilarity / dedupeTopics", () => {
  it("treats punctuation and case variants of a title as the same topic", () => {
    expect(titleSimilarity("Fix your approvals!", "fix your approvals")).toBe(1);
    expect(
      titleSimilarity(
        "Approvals and follow-ups live in scattered threads",
        "Approvals and follow-ups live in scattered threads, so leads go cold",
      ),
    ).toBeGreaterThanOrEqual(0.6);
    expect(titleSimilarity("Fix your approvals", "Best hiking trails in June")).toBe(0);
  });

  it("collapses near-duplicate titles inside one batch, keeping the first", () => {
    const { kept, dropped } = dedupeTopics(
      [
        { title: "Approvals and follow-ups live in scattered threads", angle: "one" },
        { title: "Approvals and follow-ups live in scattered threads!", angle: "two" },
        { title: "A completely different subject", angle: "three" },
      ],
      [],
    );
    expect(kept.map((t) => t.title)).toEqual([
      "Approvals and follow-ups live in scattered threads",
      "A completely different subject",
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      duplicate_of: "Approvals and follow-ups live in scattered threads",
      against: "batch",
      similarity: 1,
    });
  });

  it("drops candidates that repeat the profile's stored topics (memory)", () => {
    const { kept, dropped } = dedupeTopics(
      [{ title: "A field guide for small agencies", angle: "again" }],
      ["A field guide for small agencies"],
    );
    expect(kept).toEqual([]);
    expect(dropped[0]).toMatchObject({ against: "memory", similarity: 1 });
  });
});

describe("scoring rubric", () => {
  const onTopic = {
    title: "Approvals in scattered threads are costing your agency leads",
    angle:
      "A practical guide and workflow breakdown for small agencies on fixing approvals and follow-ups.",
  };
  const offTopic = {
    title: "Ten vacation photos from our team retreat",
    angle: "Fun pictures.",
  };

  it("scores a pain-grounded topic far above an unrelated one", () => {
    const on = scoreUtility(onTopic, manualProfile);
    const off = scoreUtility(offTopic, manualProfile);
    expect(on.score).toBeGreaterThan(off.score);
    expect(on.score).toBeGreaterThanOrEqual(60);
    expect(off.score).toBeLessThanOrEqual(35);
    for (const s of [on.score, off.score]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
    // The grounded topic visibly draws on the page facts; the other doesn't.
    expect(on.matchedFactIds).toContain("f2");
    expect(off.matchedFactIds).toEqual([]);
  });

  it("novelty is 0 for a repeat of a stored topic and 100 against empty memory", () => {
    expect(scoreNovelty(onTopic, [onTopic.title])).toBe(0);
    expect(scoreNovelty(onTopic, [])).toBe(100);
  });

  it("ranks by score_total descending, deterministically", () => {
    const candidates = buildTopicCandidates(fixtureProfile());
    expect(candidates.length).toBeGreaterThan(2);
    const first = scoreTopics(candidates, fixtureProfile(), []);
    const second = scoreTopics(candidates, fixtureProfile(), []);
    expect(first.topics.map((t) => t.title)).toEqual(second.topics.map((t) => t.title));
    const totals = first.topics.map((t) => t.score_total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    for (const topic of first.topics) {
      expect(topic.score_total).toBe(
        Math.round(0.6 * topic.score_utility + 0.4 * topic.score_novelty),
      );
    }
  });
});

describe("LocalStore topics persistence", () => {
  it("round-trips topics per profile and finds profiles by id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gtm-topics-store-"));
    const store = new LocalStore(dir);
    const profile = await store.saveProductProfile("default", {
      url: manualProfile.url!,
      fetched_at: "2026-11-05T00:00:00.000Z",
      facts: manualFacts,
      icp_draft: manualDraft,
      provider: "deterministic-baseline",
      extraction_quality: "ok",
      warnings: [],
    });
    expect((await store.getProductProfile(profile.id))?.id).toBe(profile.id);
    expect(await store.getProductProfile("no-such-id")).toBeNull();

    const saved = await store.saveTopics("default", profile.id, [
      {
        title: "A field guide for small agencies",
        angle: "Guide.",
        score_utility: 80,
        score_novelty: 90,
        score_total: 84,
        source_packet: { provider: "deterministic-baseline" },
        prompt_version: "topics-baseline-v1",
        provider: "deterministic-baseline",
      },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: "candidate", product_profile_id: profile.id });

    const reopened = new LocalStore(dir);
    const listed = await reopened.listTopicsForProfile(profile.id);
    expect(listed.map((t) => t.title)).toEqual(["A field guide for small agencies"]);
    expect(await reopened.listTopicsForProfile("another-profile")).toEqual([]);
  });
});

describe("POST /api/topics:score", () => {
  let POST: (req: NextRequest) => Promise<Response>;
  let store: LocalStore;
  let profileId: string;

  beforeAll(async () => {
    // Route persistence must land in a throwaway dir, and generation must
    // use the deterministic baseline regardless of the host's env.
    const dir = await mkdtemp(path.join(tmpdir(), "gtm-topics-route-"));
    process.env.GTM_DATA_DIR = dir;
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    ({ POST } = await import("@/app/api/topics/score/route"));
    store = new LocalStore(dir);
    const profile = await store.saveProductProfile("default", {
      url: "https://flowboard.example/",
      fetched_at: "2026-11-05T00:00:00.000Z",
      facts: extractFacts(fixtureHtml),
      icp_draft: buildIcpDraft(extractFacts(fixtureHtml)),
      provider: "deterministic-baseline",
      extraction_quality: "ok",
      warnings: [],
    });
    profileId = profile.id;
  });

  function post(body: unknown): Promise<Response> {
    return POST(
      new NextRequest("http://localhost/api/topics/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("scores, ranks and persists topics for a stored profile", async () => {
    const res = await post({ product_profile_id: profileId });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      profile_id: string;
      provider: string;
      topics: Array<{ id: string | null; title: string; score_total: number; status: string }>;
      dropped_duplicates: unknown[];
    };
    expect(data.profile_id).toBe(profileId);
    expect(data.provider).toBe("deterministic-baseline");
    expect(data.topics.length).toBeGreaterThan(2);
    expect(data.topics.every((t) => t.id !== null && t.status === "candidate")).toBe(true);
    const totals = data.topics.map((t) => t.score_total);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));

    // Persisted: the store now holds exactly the returned topics as memory.
    const stored = await store.listTopicsForProfile(profileId);
    expect(stored.map((t) => t.title).sort()).toEqual(
      data.topics.map((t) => t.title).sort(),
    );
  });

  it("dedupes a repeat run against the topics stored by the first run", async () => {
    const res = await post({ product_profile_id: profileId });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      topics: unknown[];
      dropped_duplicates: Array<{ against: string }>;
    };
    expect(data.topics).toEqual([]);
    expect(data.dropped_duplicates.length).toBeGreaterThan(2);
    expect(data.dropped_duplicates.every((d) => d.against === "memory")).toBe(true);
  });

  it("scores an inline profile without persisting it", async () => {
    const res = await post({
      profile: { url: manualProfile.url, facts: manualFacts, icp_draft: manualDraft },
      candidates: [
        {
          title: "Approvals in scattered threads are costing your agency leads",
          angle:
            "A practical guide and workflow breakdown for small agencies on fixing approvals and follow-ups.",
        },
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      profile_id: string | null;
      provider: string;
      topics: Array<{ id: string | null; title: string }>;
    };
    expect(data.profile_id).toBeNull();
    expect(data.provider).toBe("provided");
    expect(data.topics).toHaveLength(1);
    expect(data.topics[0]?.id).toBeNull();
  });

  it("rejects a body with neither profile id nor inline profile", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it("404s an unknown product_profile_id", async () => {
    const res = await post({ product_profile_id: "no-such-profile" });
    expect(res.status).toBe(404);
  });
});

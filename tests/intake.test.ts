import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPublicUrl,
  buildIcpDraft,
  enforceCitations,
  extractFacts,
  type IcpDraft,
} from "@/lib/intake";
import { DeterministicBaselineProvider, generateIcp } from "@/lib/llm";

const fixtureHtml = readFileSync(
  path.join(__dirname, "fixtures", "product-page.html"),
  "utf8",
);

describe("extractFacts", () => {
  it("extracts title, description, headings and text with sequential ids", () => {
    const facts = extractFacts(fixtureHtml);
    expect(facts.length).toBeGreaterThanOrEqual(5);
    expect(facts[0]?.id).toBe("f1");
    facts.forEach((fact, i) => expect(fact.id).toBe(`f${i + 1}`));

    const title = facts.find((f) => f.kind === "title");
    expect(title?.text).toContain("FlowBoard");

    const description = facts.find((f) => f.kind === "description");
    expect(description?.text).toContain("small agencies");

    const headings = facts.filter((f) => f.kind === "heading");
    expect(headings.length).toBeGreaterThanOrEqual(2);

    const texts = facts.filter((f) => f.kind === "text");
    expect(texts.length).toBeGreaterThanOrEqual(2);
  });

  it("returns no facts for an empty document", () => {
    expect(extractFacts("<html><head></head><body></body></html>")).toEqual([]);
  });
});

describe("buildIcpDraft / citation enforcement", () => {
  it("produces an ICP draft whose pains are all cited", () => {
    const facts = extractFacts(fixtureHtml);
    const draft = buildIcpDraft(facts);
    expect(draft.claims_cited).toBe(true);
    expect(draft.audiences.length).toBeGreaterThan(0);
    const known = new Set(facts.map((f) => f.id));
    for (const audience of draft.audiences) {
      expect(audience.evidence.length).toBeGreaterThan(0);
      for (const pain of audience.pains) {
        expect(pain.evidence.length).toBeGreaterThan(0);
        for (const id of pain.evidence) expect(known.has(id)).toBe(true);
      }
    }
  });

  it("drops uncited pains and audiences via enforceCitations", () => {
    const facts = extractFacts(fixtureHtml);
    const dirty: IcpDraft = {
      positioning: "test",
      claims_cited: true,
      prompt_version: "test",
      audiences: [
        {
          name: "Mixed",
          evidence: [],
          pains: [
            { text: "cited pain", evidence: [facts[0]!.id] },
            { text: "uncited pain", evidence: [] },
            { text: "pain citing a made-up fact", evidence: ["f999"] },
          ],
        },
        {
          name: "Fully uncited",
          evidence: [],
          pains: [{ text: "nothing supports this", evidence: [] }],
        },
      ],
    };
    const clean = enforceCitations(dirty, facts);
    expect(clean.audiences).toHaveLength(1);
    expect(clean.audiences[0]?.pains).toHaveLength(1);
    expect(clean.audiences[0]?.pains[0]?.text).toBe("cited pain");
  });
});

describe("assertPublicUrl (SSRF guard)", () => {
  it.each([
    "http://localhost:3000/admin",
    "http://127.0.0.1/secret",
    "http://127.1/x",
    "http://0.0.0.0/x",
    "http://10.0.0.5/internal",
    "http://172.16.4.4/internal",
    "http://172.31.255.255/internal",
    "http://192.168.1.10/router",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/admin",
    "http://[fe80::1]/admin",
    "http://[fd00::1]/admin",
    "http://printer.local/status",
    "https://user:pass@example.com/",
    "ftp://example.com/file",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", (raw) => {
    expect(() => assertPublicUrl(raw)).toThrow();
  });

  it.each([
    "https://signhify.dpdns.org",
    "https://example.com/page?q=1",
    "http://172.32.0.1/public", // outside 172.16.0.0/12
    "https://sub.domain.example.co.uk/path",
  ])("accepts %s", (raw) => {
    const url = assertPublicUrl(raw);
    expect(url.hostname.length).toBeGreaterThan(0);
  });
});

describe("LLM gateway (deterministic baseline, no network)", () => {
  it("baseline provider is always configured and labels itself", async () => {
    const baseline = new DeterministicBaselineProvider();
    expect(baseline.isConfigured()).toBe(true);
    expect(baseline.name).toBe("deterministic-baseline");
    const facts = extractFacts(fixtureHtml);
    const draft = await baseline.draftIcp(facts);
    expect(draft.audiences.length).toBeGreaterThan(0);
  });

  it("generateIcp returns cited output labelled with its provider", async () => {
    // Test env has no GROQ_API_KEY/GEMINI_API_KEY (CI never sets them), so the
    // gateway must resolve to the deterministic baseline without any network.
    const facts = extractFacts(fixtureHtml);
    const { draft, provider } = await generateIcp(facts);
    expect(typeof provider).toBe("string");
    expect(provider.length).toBeGreaterThan(0);
    expect(draft.claims_cited).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fact } from "@/lib/intake";
import {
  BASELINE_PROVIDER,
  DEFAULT_LLM_DAILY_CAP,
  generateIcp,
  generateTopics,
  llmDailyCap,
  llmUsageToday,
  resetLlmUsage,
} from "@/lib/llm";
import type { TopicSourceProfile } from "@/lib/topics";
import goldenProfile from "./fixtures/golden-profile.json";

const facts = goldenProfile.facts as Fact[];
const profile = goldenProfile as unknown as TopicSourceProfile;

const ICP_JSON = JSON.stringify({
  positioning: "Boards for small agencies.",
  audiences: [
    {
      name: "Small agencies (2-10 people)",
      pains: [{ text: "Approvals live in scattered email threads.", evidence: ["f4"] }],
    },
  ],
});
const TOPICS_JSON = JSON.stringify({
  topics: [{ title: "Approvals without the email chase", angle: "A guide to client approvals." }],
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
const groqOk = () => jsonResponse({ choices: [{ message: { content: ICP_JSON } }] });
const groqTopicsOk = () => jsonResponse({ choices: [{ message: { content: TOPICS_JSON } }] });
const geminiOk = () =>
  jsonResponse({ candidates: [{ content: { parts: [{ text: ICP_JSON }] } }] });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.LLM_DAILY_CAP;
  resetLlmUsage();
  fetchMock = vi.fn(async () => {
    throw new Error("fetch not stubbed for this test");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.LLM_DAILY_CAP;
  resetLlmUsage();
});

describe("gateway without keys", () => {
  it("serves the deterministic baseline and never calls fetch", async () => {
    const { draft, provider } = await generateIcp(facts);
    expect(provider).toBe(BASELINE_PROVIDER);
    expect(draft.audiences.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(llmUsageToday().real_calls).toBe(0);
  });
});

describe("Groq adapter", () => {
  it("uses Groq when configured, labels it, and sends the key as a bearer token", async () => {
    process.env.GROQ_API_KEY = "test-groq-key";
    fetchMock.mockImplementation(async () => groqOk());
    const { draft, provider } = await generateIcp(facts);
    expect(provider).toBe("groq");
    expect(draft.positioning).toBe("Boards for small agencies.");
    expect(draft.claims_cited).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.groq.com");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-groq-key");
    expect(llmUsageToday().real_calls).toBe(1);
  });

  it("generates topics through Groq", async () => {
    process.env.GROQ_API_KEY = "test-groq-key";
    fetchMock.mockImplementation(async () => groqTopicsOk());
    const { candidates, provider } = await generateTopics(profile, 5);
    expect(provider).toBe("groq");
    expect(candidates).toEqual([
      { title: "Approvals without the email chase", angle: "A guide to client approvals." },
    ]);
  });
});

describe("fallback chain Groq -> Gemini -> baseline", () => {
  it("falls back to Gemini when Groq returns an HTTP error", async () => {
    process.env.GROQ_API_KEY = "k1";
    process.env.GEMINI_API_KEY = "k2";
    fetchMock
      .mockImplementationOnce(async () => jsonResponse({ error: "nope" }, 500))
      .mockImplementationOnce(async () => geminiOk());
    const { provider } = await generateIcp(facts);
    expect(provider).toBe("gemini");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("generativelanguage.googleapis.com");
    expect(llmUsageToday().real_calls).toBe(2);
  });

  it("falls back to Gemini when Groq returns unusable JSON content", async () => {
    process.env.GROQ_API_KEY = "k1";
    process.env.GEMINI_API_KEY = "k2";
    fetchMock
      .mockImplementationOnce(async () =>
        jsonResponse({ choices: [{ message: { content: "not json" } }] }),
      )
      .mockImplementationOnce(async () => geminiOk());
    const { provider } = await generateIcp(facts);
    expect(provider).toBe("gemini");
  });

  it("falls back to the baseline when every real provider fails", async () => {
    process.env.GROQ_API_KEY = "k1";
    process.env.GEMINI_API_KEY = "k2";
    fetchMock.mockImplementation(async () => jsonResponse({}, 503));
    const { draft, provider } = await generateIcp(facts);
    expect(provider).toBe(BASELINE_PROVIDER);
    expect(draft.audiences.length).toBeGreaterThan(0);
    expect(llmUsageToday().real_calls).toBe(2);
  });

  it("skips Groq entirely when only Gemini is configured", async () => {
    process.env.GEMINI_API_KEY = "k2";
    fetchMock.mockImplementation(async () => geminiOk());
    const { provider } = await generateIcp(facts);
    expect(provider).toBe("gemini");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("daily guardrail", () => {
  it("parses LLM_DAILY_CAP with a sensible default", () => {
    expect(llmDailyCap()).toBe(DEFAULT_LLM_DAILY_CAP);
    process.env.LLM_DAILY_CAP = "7";
    expect(llmDailyCap()).toBe(7);
    process.env.LLM_DAILY_CAP = "banana";
    expect(llmDailyCap()).toBe(DEFAULT_LLM_DAILY_CAP);
    process.env.LLM_DAILY_CAP = "-3";
    expect(llmDailyCap()).toBe(DEFAULT_LLM_DAILY_CAP);
  });

  it("stops real calls at the cap and serves the labelled baseline", async () => {
    process.env.GROQ_API_KEY = "k1";
    process.env.LLM_DAILY_CAP = "1";
    fetchMock.mockImplementation(async () => groqOk());
    const first = await generateIcp(facts);
    expect(first.provider).toBe("groq");
    const second = await generateIcp(facts);
    expect(second.provider).toBe(BASELINE_PROVIDER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const usage = llmUsageToday();
    expect(usage.real_calls).toBe(1);
    expect(usage.cap).toBe(1);
    expect(usage.remaining).toBe(0);
  });

  it("LLM_DAILY_CAP=0 disables real calls entirely", async () => {
    process.env.GROQ_API_KEY = "k1";
    process.env.GEMINI_API_KEY = "k2";
    process.env.LLM_DAILY_CAP = "0";
    const { provider } = await generateIcp(facts);
    expect(provider).toBe(BASELINE_PROVIDER);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed real call still consumes guardrail budget", async () => {
    process.env.GROQ_API_KEY = "k1";
    process.env.LLM_DAILY_CAP = "1";
    fetchMock.mockImplementation(async () => jsonResponse({}, 500));
    const { provider } = await generateIcp(facts);
    expect(provider).toBe(BASELINE_PROVIDER);
    expect(llmUsageToday().real_calls).toBe(1);
  });
});

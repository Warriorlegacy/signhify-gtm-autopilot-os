/**
 * lib/llm.ts — the single LLM gateway for the GTM Autopilot OS.
 *
 * One provider interface, three implementations:
 *  - Groq    (free tier) — active only when GROQ_API_KEY is set
 *  - Gemini  (free tier) — active only when GEMINI_API_KEY is set
 *  - Deterministic baseline — always available, no key, no network.
 *
 * Fallback chain (Day 5): Groq → Gemini → deterministic baseline. Every
 * configured real provider is tried in order; a failure (network, HTTP
 * error, unusable output) moves to the next provider, and the baseline
 * is the always-available floor.
 *
 * Guardrail (Day 5): real-model calls are counted per UTC day. Once the
 * count reaches LLM_DAILY_CAP (default DEFAULT_LLM_DAILY_CAP), no more
 * real calls are made that day — the gateway serves the baseline and
 * labels it as such. Free tiers stay free only if a runaway loop cannot
 * burn them; the cap makes the worst case a labelled baseline, never a
 * surprise bill or a dead key. LLM_DAILY_CAP=0 disables real calls.
 *
 * Every result is labelled with the provider that actually produced it
 * (the honesty pattern from the TRD). Whatever the provider, the draft
 * passes through enforceCitations before it is returned.
 */

import {
  buildIcpDraft,
  enforceCitations,
  ICP_PROMPT_VERSION,
  type Fact,
  type IcpDraft,
} from "./intake";
import {
  buildTopicCandidates,
  TOPICS_PROMPT_VERSION,
  type TopicCandidate,
  type TopicSourceProfile,
} from "./topics";

export const BASELINE_PROVIDER = "deterministic-baseline";
const LLM_PROMPT_VERSION = "icp-llm-v1";
const TOPICS_LLM_PROMPT_VERSION = "topics-llm-v1";
const LLM_TIMEOUT_MS = 20_000;

export interface IcpGenerationResult {
  draft: IcpDraft;
  provider: string;
}

export interface TopicGenerationResult {
  candidates: TopicCandidate[];
  provider: string;
}

export interface LlmProvider {
  readonly name: string;
  isConfigured(): boolean;
  draftIcp(facts: Fact[]): Promise<IcpDraft>;
  draftTopics(profile: TopicSourceProfile, count: number): Promise<TopicCandidate[]>;
}

/* ------------------------- baseline provider ------------------------ */

export class DeterministicBaselineProvider implements LlmProvider {
  readonly name = BASELINE_PROVIDER;
  isConfigured(): boolean {
    return true; // no key, no network — always available
  }
  async draftIcp(facts: Fact[]): Promise<IcpDraft> {
    return buildIcpDraft(facts);
  }
  async draftTopics(profile: TopicSourceProfile, count: number): Promise<TopicCandidate[]> {
    return buildTopicCandidates(profile, count);
  }
}

/* --------------------------- shared bits ---------------------------- */

function buildIcpPrompt(facts: Fact[]): string {
  const factList = facts.map((f) => `[${f.id}] (${f.kind}) ${f.text}`).join("\n");
  return [
    "You are the ICP generator for a go-to-market tool.",
    "From the page facts below, produce a JSON object with exactly this shape:",
    '{"positioning": string, "audiences": [{"name": string, "pains": [{"text": string, "evidence": ["f1"]}]}]}',
    "Rules: every pain MUST cite at least one fact id in its evidence array, using only ids from the list.",
    "Do not invent facts, numbers or claims that are not in the list. Return JSON only.",
    "",
    "Page facts:",
    factList,
  ].join("\n");
}

function coerceDraft(parsed: unknown, facts: Fact[]): IcpDraft {
  const obj = (parsed ?? {}) as Partial<IcpDraft>;
  const draft: IcpDraft = {
    positioning: typeof obj.positioning === "string" ? obj.positioning : "",
    audiences: Array.isArray(obj.audiences) ? obj.audiences : [],
    claims_cited: true,
    prompt_version: LLM_PROMPT_VERSION,
  };
  const enforced = enforceCitations(draft, facts);
  if (enforced.audiences.length === 0) {
    throw new Error("Provider returned no cited audiences.");
  }
  return enforced;
}

function buildTopicsPrompt(profile: TopicSourceProfile, count: number): string {
  const factList = profile.facts.map((f) => `[${f.id}] (${f.kind}) ${f.text}`).join("\n");
  const audiences = profile.icp_draft.audiences
    .map((a) => `- ${a.name}: ${a.pains.map((p) => p.text).join(" ")}`)
    .join("\n");
  return [
    "You are the topic engine for a go-to-market content tool.",
    `From the product facts and ICP audiences below, propose exactly ${count} content topics.`,
    'Produce a JSON object with exactly this shape: {"topics": [{"title": string, "angle": string}]}',
    "Rules: every topic must serve one of the named audiences and stay grounded in the listed facts.",
    "Do not repeat a subject twice. Do not invent product capabilities. Return JSON only.",
    "",
    "Product facts:",
    factList,
    "",
    "ICP audiences and pains:",
    audiences,
  ].join("\n");
}

function coerceTopics(parsed: unknown, count: number): TopicCandidate[] {
  const obj = (parsed ?? {}) as { topics?: unknown };
  const list = Array.isArray(obj.topics) ? obj.topics : [];
  const candidates: TopicCandidate[] = [];
  for (const item of list) {
    const t = (item ?? {}) as Partial<TopicCandidate>;
    if (typeof t.title !== "string" || !t.title.trim()) continue;
    candidates.push({
      title: t.title.trim(),
      angle: typeof t.angle === "string" ? t.angle.trim() : "",
    });
    if (candidates.length >= count) break;
  }
  if (candidates.length === 0) {
    throw new Error("Provider returned no usable topics.");
  }
  return candidates;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`LLM provider responded ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- Groq ---------------------------------- */

export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  isConfigured(): boolean {
    return Boolean(process.env.GROQ_API_KEY);
  }
  async draftIcp(facts: Fact[]): Promise<IcpDraft> {
    const data = (await fetchJson("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildIcpPrompt(facts) }],
      }),
    })) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned no content.");
    return coerceDraft(JSON.parse(content), facts);
  }
  async draftTopics(profile: TopicSourceProfile, count: number): Promise<TopicCandidate[]> {
    const data = (await fetchJson("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildTopicsPrompt(profile, count) }],
      }),
    })) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq returned no content.");
    return coerceTopics(JSON.parse(content), count);
  }
}

/* ---------------------------- Gemini -------------------------------- */

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }
  async draftIcp(facts: Fact[]): Promise<IcpDraft> {
    const key = process.env.GEMINI_API_KEY ?? "";
    const data = (await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildIcpPrompt(facts) }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      },
    )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("Gemini returned no content.");
    return coerceDraft(JSON.parse(content), facts);
  }
  async draftTopics(profile: TopicSourceProfile, count: number): Promise<TopicCandidate[]> {
    const key = process.env.GEMINI_API_KEY ?? "";
    const data = (await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildTopicsPrompt(profile, count) }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      },
    )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("Gemini returned no content.");
    return coerceTopics(JSON.parse(content), count);
  }
}

/* --------------------- daily usage guardrail ---------------------- */

/** Default ceiling on real-model calls per UTC day (env: LLM_DAILY_CAP). */
export const DEFAULT_LLM_DAILY_CAP = 500;

export interface LlmUsage {
  /** UTC day the counter belongs to, YYYY-MM-DD. */
  day: string;
  /** Real-model calls attempted today (successful or not). */
  real_calls: number;
  /** The cap currently in force. */
  cap: number;
  /** Real calls still allowed today (never negative). */
  remaining: number;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parse LLM_DAILY_CAP; unset/invalid/negative falls back to the default. */
export function llmDailyCap(): number {
  const raw = process.env.LLM_DAILY_CAP;
  if (raw === undefined || raw.trim() === "") return DEFAULT_LLM_DAILY_CAP;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LLM_DAILY_CAP;
  return Math.floor(parsed);
}

const usageState: { day: string; realCalls: number } = { day: utcToday(), realCalls: 0 };

function rollUsageDay(): void {
  const today = utcToday();
  if (usageState.day !== today) {
    usageState.day = today;
    usageState.realCalls = 0;
  }
}

/** Today's real-model usage against the cap (read-only snapshot). */
export function llmUsageToday(): LlmUsage {
  rollUsageDay();
  const cap = llmDailyCap();
  return {
    day: usageState.day,
    real_calls: usageState.realCalls,
    cap,
    remaining: Math.max(0, cap - usageState.realCalls),
  };
}

/** Reset the counter — for tests and worker restarts only. */
export function resetLlmUsage(): void {
  usageState.day = utcToday();
  usageState.realCalls = 0;
}

/**
 * Consume one real-call slot. Returns false when today's cap is already
 * reached: the caller must not make the real call and falls back instead.
 */
function tryConsumeRealCall(): boolean {
  rollUsageDay();
  if (usageState.realCalls >= llmDailyCap()) return false;
  usageState.realCalls += 1;
  return true;
}

/* --------------------------- the gateway ---------------------------- */

const PROVIDERS: LlmProvider[] = [
  new GroqProvider(),
  new GeminiProvider(),
  new DeterministicBaselineProvider(),
];

/** The first configured provider (Groq → Gemini → deterministic baseline). */
export function selectProvider(): LlmProvider {
  return PROVIDERS.find((p) => p.isConfigured()) ?? new DeterministicBaselineProvider();
}

/**
 * Run one gateway operation through the fallback chain: each configured
 * real provider in order (Groq, then Gemini), subject to the daily cap,
 * then the deterministic baseline. The returned provider name is always
 * the one that actually produced the value.
 */
async function runWithFallback<T>(
  call: (provider: LlmProvider) => Promise<T>,
): Promise<{ value: T; provider: string }> {
  for (const provider of PROVIDERS) {
    if (provider.name === BASELINE_PROVIDER) break;
    if (!provider.isConfigured()) continue;
    if (!tryConsumeRealCall()) break; // cap reached — straight to baseline
    try {
      return { value: await call(provider), provider: provider.name };
    } catch {
      // fall through to the next provider in the chain
    }
  }
  const baseline = new DeterministicBaselineProvider();
  return { value: await call(baseline), provider: baseline.name };
}

/**
 * Generate an ICP draft through the gateway: Groq → Gemini → baseline,
 * with the daily guardrail applied to every real call. The returned
 * provider name is always the one that actually produced the draft.
 */
export async function generateIcp(facts: Fact[]): Promise<IcpGenerationResult> {
  const { value, provider } = await runWithFallback((p) => p.draftIcp(facts));
  return { draft: value, provider };
}

/**
 * Generate topic candidates through the gateway — same chain and
 * guardrail as generateIcp. Candidates are NOT scored here; dedupe +
 * scoring live in lib/topics.ts.
 */
export async function generateTopics(
  profile: TopicSourceProfile,
  count: number,
): Promise<TopicGenerationResult> {
  const { value, provider } = await runWithFallback((p) => p.draftTopics(profile, count));
  return { candidates: value, provider };
}

export { ICP_PROMPT_VERSION, TOPICS_PROMPT_VERSION, TOPICS_LLM_PROMPT_VERSION };

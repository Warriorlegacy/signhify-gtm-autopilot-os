/**
 * lib/llm.ts — the single LLM gateway for the GTM Autopilot OS.
 *
 * One provider interface, three implementations:
 *  - Groq    (free tier) — active only when GROQ_API_KEY is set
 *  - Gemini  (free tier) — active only when GEMINI_API_KEY is set
 *  - Deterministic baseline — always available, no key, no network.
 *
 * Every result is labelled with the provider that actually produced it
 * (the honesty pattern from the TRD). Whatever the provider, the draft
 * passes through enforceCitations before it is returned, and any provider
 * failure falls back to the deterministic baseline.
 */

import {
  buildIcpDraft,
  enforceCitations,
  ICP_PROMPT_VERSION,
  type Fact,
  type IcpDraft,
} from "./intake";

export const BASELINE_PROVIDER = "deterministic-baseline";
const LLM_PROMPT_VERSION = "icp-llm-v1";
const LLM_TIMEOUT_MS = 20_000;

export interface IcpGenerationResult {
  draft: IcpDraft;
  provider: string;
}

export interface LlmProvider {
  readonly name: string;
  isConfigured(): boolean;
  draftIcp(facts: Fact[]): Promise<IcpDraft>;
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
 * Generate an ICP draft through the gateway. Real providers are tried first
 * when configured; any failure falls back to the deterministic baseline.
 * The returned provider name is always the one that actually produced it.
 */
export async function generateIcp(facts: Fact[]): Promise<IcpGenerationResult> {
  const provider = selectProvider();
  if (provider.name === BASELINE_PROVIDER) {
    return { draft: await provider.draftIcp(facts), provider: provider.name };
  }
  try {
    return { draft: await provider.draftIcp(facts), provider: provider.name };
  } catch {
    const baseline = new DeterministicBaselineProvider();
    return { draft: await baseline.draftIcp(facts), provider: baseline.name };
  }
}

export { ICP_PROMPT_VERSION };

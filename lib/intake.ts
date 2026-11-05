/**
 * lib/intake.ts — product intake: URL safety guard, fact extraction and the
 * deterministic ICP draft builder.
 *
 * Pure functions only (no network, no env access) so they are unit-testable.
 * Design rule from the TRD: every generated claim must be traceable to a
 * source fact extracted from the fetched page. Pains without a citation are
 * dropped in code, never rendered.
 */

export type FactKind =
  | "title"
  | "description"
  | "heading"
  | "text"
  | "og"
  | "jsonld"
  | "link";

export interface Fact {
  id: string;
  kind: FactKind;
  text: string;
}

export interface IcpPain {
  text: string;
  /** Fact ids that support this pain. A pain with an empty list is invalid. */
  evidence: string[];
}

export interface IcpAudience {
  name: string;
  pains: IcpPain[];
  /** Union of every fact id cited by this audience's pains. */
  evidence: string[];
}

export interface IcpDraft {
  positioning: string;
  audiences: IcpAudience[];
  /** Always true — enforced by enforceCitations before a draft leaves the system. */
  claims_cited: true;
  prompt_version: string;
}

export const ICP_PROMPT_VERSION = "icp-baseline-v1";

/* ------------------------------------------------------------------ */
/* URL safety guard (SSRF)                                             */
/* ------------------------------------------------------------------ */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 unique local
  if (h.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — check the embedded IPv4 address.
    return isPrivateIpv4(h.slice("::ffff:".length));
  }
  return false;
}

/** True when a hostname is localhost, a .local name, or a private/reserved IP literal. */
export function isPrivateOrLocalHost(hostname: string): boolean {
  // WHATWG URL keeps the brackets on IPv6 hostnames ("[::1]") — strip them.
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  return isPrivateIpv4(host);
}

/**
 * Validate a user-supplied URL for server-side fetching.
 * Throws on anything that is not a public http(s) URL.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not supported.");
  }
  if (!url.hostname) {
    throw new Error("URL has no host.");
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new Error("Refusing to fetch localhost or private-network URLs.");
  }
  return url;
}

/* ------------------------------------------------------------------ */
/* Fact extraction                                                     */
/* ------------------------------------------------------------------ */

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function cleanText(fragment: string): string {
  return fragment
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/*
 * Extraction caps — reviewed Day 2 against two real pages:
 *  - signhify.dpdns.org: 8 h1/h2 (cap 12 not reached) but 47 paragraphs ≥40
 *    chars, so MAX_SNIPPETS does bind there. The first 10 paragraphs in
 *    document order carry the hero + feature narrative; the long tail is
 *    portfolio-card copy, which is intentionally out of scope for a bounded
 *    source packet. Cap kept at 10.
 *  - piyush-portfolio-ebon.vercel.app: a JS-rendered SPA — 0 headings, 0
 *    paragraphs, 0 anchors in the raw HTML; only metadata is readable (see
 *    assessExtraction — that page is honestly "thin").
 * Caps stay as set on Day 1; the new sources below get their own small caps.
 */
const MAX_HEADINGS = 12;
const MAX_SNIPPETS = 10;
const MIN_SNIPPET_CHARS = 40;
const MAX_SNIPPET_CHARS = 240;
const MAX_JSONLD_FACTS = 4;
const MAX_LINKS = 8;
const MIN_ANCHOR_CHARS = 12;
const MAX_ANCHOR_CHARS = 100;

/** Read one attribute value out of a single HTML tag, or null. */
function tagAttr(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([\\s\\S]*?)["']`, "i"));
  return m?.[1] ?? null;
}

/**
 * Parse JSON-LD blocks and return the entity objects they describe
 * (top-level objects, arrays, and @graph members). Invalid JSON is skipped —
 * a page's broken structured data must never break intake.
 */
function jsonLdEntities(html: string): Array<Record<string, unknown>> {
  const entities: Array<Record<string, unknown>> = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(openTag)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse((m[1] ?? "").trim());
    } catch {
      continue;
    }
    const queue: unknown[] = [parsed];
    while (queue.length > 0) {
      const item = queue.shift();
      if (Array.isArray(item)) {
        queue.push(...item);
        continue;
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        entities.push(obj);
        if (Array.isArray(obj["@graph"])) queue.push(...(obj["@graph"] as unknown[]));
      }
    }
  }
  return entities;
}

const GENERIC_ANCHOR_TEXTS = new Set([
  "learn more",
  "read more",
  "click here",
  "here",
  "sign up",
  "sign in",
  "log in",
  "login",
  "get started",
  "contact us",
  "see more",
  "show more",
  "view all",
  "find out more",
  "discover more",
  "back",
  "next",
  "previous",
  "home",
  "menu",
  "close",
  "skip to content",
]);

/** Meaningful link anchor texts: nav chrome and one-word labels are noise. */
function extractLinkTexts(html: string): string[] {
  const texts: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = cleanText(m[1] ?? "");
    if (text.length < MIN_ANCHOR_CHARS || text.length > MAX_ANCHOR_CHARS) continue;
    if (!text.includes(" ")) continue; // single-word labels are nav chrome
    if (GENERIC_ANCHOR_TEXTS.has(text.toLowerCase())) continue;
    if (/^https?:\/\//i.test(text)) continue; // anchor that is just a raw URL
    texts.push(text);
    if (texts.length >= MAX_LINKS) break;
  }
  return texts;
}

/** Normalised dedupe key: case, whitespace, surrounding quotes, trailing stops. */
function normaliseFactKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\.+$/, "")
    .trim();
}

/** Extract citable facts from an HTML document. Ids are f1, f2, … in document order. */
export function extractFacts(html: string): Fact[] {
  const raw: Array<{ kind: FactKind; text: string }> = [];

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const text = cleanText(titleMatch[1]);
    if (text) raw.push({ kind: "title", text: truncate(text, 200) });
  }

  // Meta tags in document order — attribute order varies, so scan them all.
  // Descriptions from name/og/twitter all land as "description" facts (the
  // normalised dedupe below collapses repeats); og:title, og:site_name and
  // twitter:title land as "og" facts.
  for (const meta of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (tagAttr(meta, "property") ?? tagAttr(meta, "name") ?? "").toLowerCase();
    const content = tagAttr(meta, "content");
    if (!content) continue;
    const text = cleanText(content);
    if (!text) continue;
    if (key === "description" || key === "og:description" || key === "twitter:description") {
      raw.push({ kind: "description", text: truncate(text, 300) });
    } else if (key === "og:title" || key === "og:site_name" || key === "twitter:title") {
      raw.push({ kind: "og", text: truncate(text, 200) });
    }
  }

  // Structured data: entity name / description from JSON-LD.
  let jsonLdFacts = 0;
  for (const entity of jsonLdEntities(html)) {
    if (jsonLdFacts >= MAX_JSONLD_FACTS) break;
    for (const field of ["name", "description"] as const) {
      if (jsonLdFacts >= MAX_JSONLD_FACTS) break;
      const value = entity[field];
      if (typeof value !== "string") continue;
      const text = cleanText(value);
      if (!text) continue;
      raw.push({ kind: "jsonld", text: truncate(text, field === "name" ? 200 : 300) });
      jsonLdFacts += 1;
    }
  }

  for (const m of html.matchAll(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = cleanText(m[2] ?? "");
    if (text) raw.push({ kind: "heading", text: truncate(text, 160) });
    if (raw.filter((f) => f.kind === "heading").length >= MAX_HEADINGS) break;
  }

  for (const text of extractLinkTexts(html)) {
    raw.push({ kind: "link", text: truncate(text, 160) });
  }

  let snippets = 0;
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = cleanText(m[1] ?? "");
    if (text.length < MIN_SNIPPET_CHARS) continue;
    raw.push({ kind: "text", text: truncate(text, MAX_SNIPPET_CHARS) });
    snippets += 1;
    if (snippets >= MAX_SNIPPETS) break;
  }

  const seen = new Set<string>();
  const facts: Fact[] = [];
  for (const f of raw) {
    const key = normaliseFactKey(f.text);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ id: `f${facts.length + 1}`, kind: f.kind, text: f.text });
  }
  return facts;
}

/* ------------------------------------------------------------------ */
/* Extraction quality (Day 2): honest "thin" flagging                  */
/* ------------------------------------------------------------------ */

export type ExtractionQuality = "ok" | "thin";

/** Below this many usable facts, a draft cannot be credibly supported. */
export const MIN_USABLE_FACTS = 5;

const BODY_FACT_KINDS: ReadonlySet<FactKind> = new Set(["heading", "text", "link"]);

export interface ExtractionAssessment {
  quality: ExtractionQuality;
  warnings: string[];
}

/**
 * Judge how much of the page was actually readable. A page is "thin" when
 * almost nothing was extracted, or when only metadata could be read and the
 * body exposed no readable text at all (the classic JS-rendered shell page).
 * Thin is a reporting state, never a reason to invent facts.
 */
export function assessExtraction(facts: Fact[]): ExtractionAssessment {
  if (facts.length === 0) {
    return {
      quality: "thin",
      warnings: [
        "No readable facts could be extracted from this page at all — it may be empty, blocked, or rendered entirely with JavaScript. The draft is intentionally empty: no facts were invented to fill the gap.",
      ],
    };
  }
  const bodyFacts = facts.filter((f) => BODY_FACT_KINDS.has(f.kind)).length;
  if (bodyFacts === 0) {
    return {
      quality: "thin",
      warnings: [
        "Extraction is thin: only page metadata (title, descriptions, social and structured data) could be read — the page body exposed no readable text, usually because its content renders with JavaScript. The draft cites only the metadata facts below; no facts were invented to fill the gap.",
      ],
    };
  }
  if (facts.length < MIN_USABLE_FACTS) {
    return {
      quality: "thin",
      warnings: [
        `Extraction is thin: only ${facts.length} usable facts were found on this page. The draft cites only those facts; no facts were invented to fill the gap.`,
      ],
    };
  }
  return { quality: "ok", warnings: [] };
}

/* ------------------------------------------------------------------ */
/* Citation enforcement                                                */
/* ------------------------------------------------------------------ */

/**
 * The gate every generated draft passes through, whichever provider built it:
 * drop pains that cite no known fact, drop audiences left with no pains, and
 * keep only evidence ids that exist in the source packet.
 */
export function enforceCitations(draft: IcpDraft, facts: Fact[]): IcpDraft {
  const known = new Set(facts.map((f) => f.id));
  const audiences: IcpAudience[] = [];
  for (const audience of draft.audiences ?? []) {
    const pains: IcpPain[] = [];
    for (const pain of audience.pains ?? []) {
      const evidence = [...new Set((pain.evidence ?? []).filter((id) => known.has(id)))];
      if (!pain.text?.trim() || evidence.length === 0) continue; // uncited → dropped
      pains.push({ text: pain.text.trim(), evidence });
    }
    if (pains.length === 0) continue;
    audiences.push({
      name: audience.name,
      pains,
      evidence: [...new Set(pains.flatMap((p) => p.evidence))],
    });
  }
  return {
    positioning: draft.positioning?.trim() || "Unknown — no positioning statement could be extracted.",
    audiences,
    claims_cited: true,
    prompt_version: draft.prompt_version || ICP_PROMPT_VERSION,
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic baseline ICP builder                                  */
/* ------------------------------------------------------------------ */

interface AudienceBucket {
  name: string;
  keywords: string[];
  pains: string[];
}

const AUDIENCE_BUCKETS: AudienceBucket[] = [
  {
    name: "Solo founders and indie makers",
    keywords: ["founder", "startup", "indie", "solopreneur", "launch", "mvp", "bootstrapped"],
    pains: [
      "Marketing gets squeezed in after building, so posting is inconsistent week to week.",
      "There is no time to turn one product idea into content for several channels.",
      "Follow-up with interested users happens late, or not at all.",
    ],
  },
  {
    name: "Small agencies (2–10 people)",
    keywords: ["agency", "agencies", "client", "studio", "white-label", "white label"],
    pains: [
      "Client content production eats billable hours every week.",
      "Approvals and follow-ups live in scattered threads, so leads go cold.",
      "Every client needs the same content system rebuilt from scratch.",
    ],
  },
  {
    name: "Developers and technical teams",
    keywords: ["developer", "api", "docs", "documentation", "github", "open source", "cli", "sdk", "engineer"],
    pains: [
      "Good tools lose to louder competitors because nobody has time to explain them in public.",
      "Launch posts are written once and never repurposed into other formats.",
    ],
  },
  {
    name: "Content creators and marketers",
    keywords: ["video", "content", "social", "instagram", "youtube", "reels", "marketing", "audience", "followers"],
    pains: [
      "Producing a week of multi-format content by hand takes hours per post.",
      "Ideas repeat because there is no memory of what was already posted.",
    ],
  },
  {
    name: "Small businesses and operators",
    keywords: ["business", "customers", "sales", "leads", "crm", "booking", "shop", "store", "pricing"],
    pains: [
      "Follow-up on enquiries is manual, so interested leads are lost.",
      "Content stops whenever the owner is busy with delivery work.",
    ],
  },
];

const MAX_AUDIENCES = 3;
const MAX_EVIDENCE_PER_AUDIENCE = 3;

/** Build an ICP draft from extracted facts — deterministic, no LLM, fully cited. */
export function buildIcpDraft(facts: Fact[]): IcpDraft {
  const description = facts.find((f) => f.kind === "description");
  const title = facts.find((f) => f.kind === "title");
  const anchor = description ?? title;

  const positioning = anchor
    ? `Positioning as stated on the page itself: "${anchor.text}"`
    : "Unknown — the fetched page exposed no title or description to position from.";

  const scored: Array<{ bucket: AudienceBucket; evidence: string[] }> = [];
  for (const bucket of AUDIENCE_BUCKETS) {
    const evidence: string[] = [];
    for (const fact of facts) {
      const haystack = fact.text.toLowerCase();
      if (bucket.keywords.some((k) => haystack.includes(k))) evidence.push(fact.id);
      if (evidence.length >= MAX_EVIDENCE_PER_AUDIENCE) break;
    }
    if (evidence.length > 0) scored.push({ bucket, evidence });
  }
  scored.sort((a, b) => b.evidence.length - a.evidence.length);

  let audiences: IcpAudience[] = scored.slice(0, MAX_AUDIENCES).map(({ bucket, evidence }) => ({
    name: bucket.name,
    pains: bucket.pains.map((text) => ({ text, evidence })),
    evidence,
  }));

  if (audiences.length === 0 && facts.length > 0) {
    // No keyword bucket matched: derive the audience straight from the page's
    // own claims, so the draft is still fully cited.
    const cited = facts.slice(0, 3);
    audiences = [
      {
        name: "Prospective customers reading this page",
        pains: cited.map((fact) => ({
          text: `Needs convincing that the product delivers on this claim from its own page: "${truncate(fact.text, 120)}"`,
          evidence: [fact.id],
        })),
        evidence: cited.map((f) => f.id),
      },
    ];
  }

  return enforceCitations(
    {
      positioning,
      audiences,
      claims_cited: true,
      prompt_version: ICP_PROMPT_VERSION,
    },
    facts,
  );
}

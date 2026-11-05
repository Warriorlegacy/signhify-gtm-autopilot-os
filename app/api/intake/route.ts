import { NextRequest, NextResponse } from "next/server";
import { assessExtraction, assertPublicUrl, extractFacts } from "@/lib/intake";
import { generateIcp } from "@/lib/llm";
import { DEFAULT_WORKSPACE_SLUG, getStore, type IntakeResultInput } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 512 * 1024; // bound what we read from any one page
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SignhifyGTMAutopilot/0.1";

/**
 * Fetch a public URL as HTML. Redirects are followed manually so every hop
 * is re-validated against the SSRF guard — a public URL must not be able to
 * bounce us onto localhost or a private address.
 */
async function fetchPublicHtml(start: URL): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`Redirect with no Location header (${res.status}).`);
        current = assertPublicUrl(new URL(location, current).toString());
        continue;
      }
      if (!res.ok) throw new Error(`The page responded with HTTP ${res.status}.`);
      const buffer = await res.arrayBuffer();
      const html = new TextDecoder("utf-8", { fatal: false }).decode(
        buffer.slice(0, MAX_BYTES),
      );
      return { html, finalUrl: current.toString() };
    }
    throw new Error("Too many redirects.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/intake  { "url": "https://example.com" }
 * → { url, fetched_at, facts, icp_draft, provider, extraction_quality,
 *     warnings, profile_id }
 *
 * The Days 1–2 exit test in one route: URL in, cited ICP draft out.
 * Day 2: every successful intake is persisted via the Store (local JSON
 * store today, Supabase later) and the run is logged; the stored profile
 * id comes back as profile_id. If persistence itself fails, the intake
 * result is still returned — with profile_id null and a warning — rather
 * than failing a good extraction over a storage problem.
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let target: URL;
  try {
    const body = (await req.json()) as { url?: unknown };
    if (typeof body?.url !== "string" || !body.url.trim()) {
      return NextResponse.json({ error: "Body must be JSON with a 'url' string." }, { status: 400 });
    }
    target = assertPublicUrl(body.url.trim());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request." },
      { status: 400 },
    );
  }

  let html: string;
  let finalUrl: string;
  try {
    ({ html, finalUrl } = await fetchPublicHtml(target));
  } catch (err) {
    return NextResponse.json(
      { error: `Could not fetch that URL: ${err instanceof Error ? err.message : "fetch failed"}` },
      { status: 502 },
    );
  }

  const facts = extractFacts(html);
  const { draft, provider } = await generateIcp(facts);
  const assessment = assessExtraction(facts);

  const result: IntakeResultInput = {
    url: finalUrl,
    fetched_at: new Date().toISOString(),
    facts,
    icp_draft: draft,
    provider,
    extraction_quality: assessment.quality,
    warnings: assessment.warnings,
  };

  let profileId: string | null = null;
  const warnings = [...assessment.warnings];
  try {
    const store = getStore();
    const profile = await store.saveProductProfile(DEFAULT_WORKSPACE_SLUG, result);
    profileId = profile.id;
    await store.logPipelineRun({
      workspaceSlug: DEFAULT_WORKSPACE_SLUG,
      stage: "intake",
      status: "succeeded",
      durationMs: Date.now() - startedAt,
      provider,
      profileId: profile.id,
    });
  } catch (err) {
    warnings.push(
      `This intake could not be saved to the local store (${err instanceof Error ? err.message : "unknown error"}), so it will not appear in the recent-profiles list.`,
    );
  }

  return NextResponse.json({ ...result, warnings, profile_id: profileId });
}

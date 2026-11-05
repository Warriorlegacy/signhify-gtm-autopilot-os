# Signhify GTM Autopilot OS

**Give it a product URL. It builds the audience engine** — ICP, content calendar,
carousels, reel scripts, scheduled posts via official APIs, and a lead ledger —
**with a human approval gate before anything publishes.**

This repo merges three earlier Signhify systems into one public product:
**Autogram** (content pipeline stages), **autoGTM** (ICP and lead logic) and
**Autoshorts** (vertical video experiments), orchestrated behind one API and
one UI.

## Build status — honest

**Day 2 of 15 (flagship build sequence).** Done: repo scaffold, CI, the full
data model, the LLM gateway, and the intake endpoint (URL → cited ICP draft).
Day 2 added: richer extraction (Open Graph, Twitter meta, JSON-LD, link
anchors — deduped), an honest `extraction_quality: "thin"` flag for
JS-rendered pages that expose little readable text, persistence behind a
Store interface (local JSON store today — every intake is saved and listed
on the landing page), and workspace-scoped RLS policies in
`db/policies.sql` (written, not applied — no Supabase project yet). Not yet
built: topic engine port (Days 3–5), carousel renderer + approval queue UI
(Days 6–8), Meta scheduling (Days 9–10), reel renderer (Days 11–12), lead
ledger (Day 13). Nothing here is deployed yet.

## The 60-second demo

1. **Paste a URL** on the landing page (e.g. `https://signhify.dpdns.org`).
2. **Read the ICP draft** — positioning and audience pains, every pain citing
   facts extracted from the page itself. Uncited claims are dropped in code.
3. **Approve the calendar** the topic engine builds from that ICP. *(Days 3–8)*
4. **Work the approval queue** — carousels and posts schedule only from an
   approval record. Nothing publishes without one. *(Days 6–10)*

## Quick Start

```bash
npm install
npm run dev        # http://localhost:3000
```

Then paste a product URL into the form, or call the API directly:

```bash
curl -s -X POST http://localhost:3000/api/intake \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://signhify.dpdns.org"}'
```

No API keys are required: with no LLM key configured, the gateway uses a
**deterministic baseline** and labels it as such in every response. Copy
`.env.example` to `.env.local` and add a free-tier `GROQ_API_KEY` or
`GEMINI_API_KEY` to enable a real model — the response always names the
provider that actually produced the output.

Verify the build:

```bash
npm run typecheck && npm test && npm run build
```

## Architecture

```
Web (Next.js, App Router)         workspace, calendar, approval queue, lead ledger
  |
API (Next.js route handlers)      intake → topic engine → generation → fact-check → quality gate
  |
Workers (GitHub Actions cron)     renderer (Playwright, 1080×1350 / 1080×1920) → R2 staging
                                  publishers (Meta Graph API, YouTube Data API) — official APIs only
  |
Data (Supabase Postgres)          see db/schema.sql
  |
LLM gateway (lib/llm.ts)          Groq / Gemini free tiers first, deterministic baseline fallback
```

Design decisions: merge, don't rewrite · deterministic rendering from
structured JSON · one provider abstraction for every LLM call ·
**approval as data** — publishing requires an `approvals` row; there is no
code path from generation to publish that skips it.

## Data model (`db/schema.sql`)

`workspaces`, `users`, `product_profiles`, `topics`, `content_packs`,
`slides`, `approvals`, `scheduled_posts`, `leads`, `followups`, `insights`,
`pipeline_runs`.

Every generated artefact stores its `source_packet` and `prompt_version`, so
a claim can be traced and a bad output reproduced. `scheduled_posts.approval_id`
is `NOT NULL` — the foreign key is the scheduling gate. Row Level Security is
enabled on every table; the workspace-scoped policies live in
`db/policies.sql` (written Day 2, applied when a Supabase project exists).

Until Supabase is provisioned, persistence runs through `lib/store.ts`: one
Store interface, with a local JSON implementation under `.data/` that mirrors
the schema's `product_profiles` and `pipeline_runs` concepts. A Supabase
implementation can replace it without touching the routes.

## API surface (v1)

| Route | Status | Purpose |
|---|---|---|
| `POST /api/intake` | ✅ Day 1, persistence Day 2 | Fetch a product URL, return facts + cited ICP draft; saves the profile and returns `profile_id` |
| `POST /api/topics:score` | Days 3–5 | Score and dedupe topics against memory |
| `POST /api/packs` | Days 6–8 | Generate a content pack |
| `POST /api/packs/:id/approve` | Days 6–8 | The only route that can schedule |
| `POST /api/publish/run` | Days 9–10 | Worker-only; checks approval, publishes, writes the result |
| `GET /api/insights/weekly` | Later | Digest data for the analytics loop |

## Security

- Intake fetching rejects non-http(s) URLs, embedded credentials, localhost
  and private/reserved IP ranges — and re-validates every redirect hop, so a
  public URL cannot bounce the fetcher onto an internal address (SSRF guard,
  unit-tested in `tests/intake.test.ts`).
- Supabase service keys are server-side only, never in the repo.
- User tokens for Meta/YouTube will be stored encrypted, never in the repo.

## The Won't list (v1) — the contract

- **No auto-publishing without an approval record.**
- No paid ads.
- No scraping (no LinkedIn/Instagram scraping, no credential automation).
- No auto-apply, no auto-DM, no engagement bots.
- No multi-tenant billing, no mobile app.

## $0 stack note

Built and run entirely on free tiers and open-source software: Next.js,
Supabase free Postgres, Groq/Gemini free tiers, GitHub Actions, Vercel free
hosting. "Completely free" holds for building, demoing and the first real
users; a product with paying users will eventually need one small paid tier
somewhere — the architecture keeps that first step obvious.

## License

MIT — see [LICENSE](LICENSE).

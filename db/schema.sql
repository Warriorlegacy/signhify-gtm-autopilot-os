-- Signhify GTM Autopilot OS — data model (Supabase Postgres)
-- Source of truth: TRD v1.0 (Roadmap and Implementation Plan, page 10).
--
-- Rules baked into this schema:
--   * Every generated artefact (topics, content_packs, leads' drafts, ...)
--     stores its source_packet (jsonb) and prompt_version, so any claim can
--     be traced to its source and any bad output can be reproduced.
--   * Approval is data, and it is the ONLY scheduling gate: a row can only
--     exist in scheduled_posts with approval_id NOT NULL referencing a real
--     approvals row. There is no code path from generation to publish that
--     skips the approvals table.
--   * Row Level Security is enabled on EVERY table. Policies are
--     workspace-scoped (a user may only see rows whose workspace_id belongs
--     to a workspace they are a member of); create those policies per table
--     when wiring auth — see the note at the bottom of this file.
--
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql   (or the Supabase SQL editor)

begin;

-- ---------------------------------------------------------------------
-- Tenancy root
-- ---------------------------------------------------------------------

create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  email         text not null,
  display_name  text,
  -- 'owner' | 'admin' | 'member' — the approver role lives here.
  role          text not null default 'member'
                check (role in ('owner', 'admin', 'member')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, email)
);

-- ---------------------------------------------------------------------
-- Intake: one product profile per onboarded product URL
-- ---------------------------------------------------------------------

create table if not exists product_profiles (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  url             text not null,
  positioning     text,                       -- as stated on the fetched page
  icp             jsonb not null default '{}'::jsonb,  -- cited ICP draft
  source_packet   jsonb not null default '{}'::jsonb,  -- extracted facts (f1..fn)
  prompt_version  text,
  provider        text,                       -- which LLM provider produced the draft
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Topic engine (ported from Autogram in Days 3–5): scored, deduped topics
-- ---------------------------------------------------------------------

create table if not exists topics (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces (id) on delete cascade,
  product_profile_id  uuid references product_profiles (id) on delete set null,
  title               text not null,
  angle               text,
  -- Scoring dimensions from the PRD: utility, novelty, anti-repetition.
  score_utility       numeric(5,2),
  score_novelty       numeric(5,2),
  score_total         numeric(5,2),
  status              text not null default 'candidate'
                      check (status in ('candidate', 'approved', 'rejected', 'used')),
  source_packet       jsonb not null default '{}'::jsonb,
  prompt_version      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Content packs + slides: one approved topic becomes many assets
-- ---------------------------------------------------------------------

create table if not exists content_packs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  topic_id        uuid not null references topics (id) on delete cascade,
  -- 'carousel' | 'reel' | 'youtube' | 'linkedin' | 'x' | 'story'
  format          text not null,
  narrative       jsonb not null default '{}'::jsonb,  -- structured narrative JSON
  caption         text,
  -- Fact-check + quality gate (PRD): score 0–100, packs below threshold
  -- cannot be approved (enforced in the app layer, recorded here).
  quality_score   int check (quality_score between 0 and 100),
  fact_check      jsonb not null default '{}'::jsonb,
  status          text not null default 'draft'
                  check (status in ('draft', 'in_review', 'approved', 'rejected', 'scheduled', 'published')),
  source_packet   jsonb not null default '{}'::jsonb,
  prompt_version  text,
  provider        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists slides (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  content_pack_id uuid not null references content_packs (id) on delete cascade,
  position        int not null,               -- 1..10 within the pack
  headline        text,
  body            text,
  layout          jsonb not null default '{}'::jsonb,  -- deterministic render spec
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (content_pack_id, position)
);

-- ---------------------------------------------------------------------
-- Approvals: the human gate. Nothing schedules or publishes without a row.
-- ---------------------------------------------------------------------

create table if not exists approvals (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  content_pack_id uuid not null references content_packs (id) on delete cascade,
  approver_id     uuid references users (id) on delete set null,
  decision        text not null check (decision in ('approved', 'rejected')),
  note            text,
  decided_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- Scheduled posts REQUIRE an approval. approval_id is NOT NULL by design:
-- this foreign key is the only scheduling gate in the system (TRD).
create table if not exists scheduled_posts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  content_pack_id uuid not null references content_packs (id) on delete cascade,
  approval_id     uuid not null references approvals (id) on delete restrict,
  -- 'instagram' | 'youtube' | 'linkedin' | 'x' — official APIs only.
  channel         text not null,
  scheduled_for   timestamptz not null,
  status          text not null default 'scheduled'
                  check (status in ('scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  external_post_id text,                      -- id returned by the platform API
  render_url      text,                       -- staged asset (e.g. R2) the API publishes from
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Lead ledger (ported from autoGTM, Day 13): drafts only — sends are logged
-- ---------------------------------------------------------------------

create table if not exists leads (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  source          text,                       -- where the lead was found
  name            text,
  contact         text,                       -- email / handle, as provided by the owner
  company         text,
  status          text not null default 'new'
                  check (status in ('new', 'contacted', 'replied', 'qualified', 'won', 'lost', 'archived')),
  notes           text,
  source_packet   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists followups (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  lead_id         uuid not null references leads (id) on delete cascade,
  draft           text not null,              -- follow-ups are drafts until approved
  status          text not null default 'draft'
                  check (status in ('draft', 'approved', 'sent', 'discarded')),
  approved_by     uuid references users (id) on delete set null,
  sent_at         timestamptz,
  prompt_version  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Analytics loop + run ledger
-- ---------------------------------------------------------------------

create table if not exists insights (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces (id) on delete cascade,
  scheduled_post_id uuid references scheduled_posts (id) on delete set null,
  channel           text,
  metrics           jsonb not null default '{}'::jsonb,  -- reach, saves, watch time, ...
  captured_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- Idempotent jobs write one row per run: stage, provider, token/cost log.
create table if not exists pipeline_runs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references workspaces (id) on delete cascade,
  stage         text not null,              -- 'intake' | 'topics' | 'packs' | 'publish' | 'insights'
  status        text not null default 'running'
                check (status in ('running', 'succeeded', 'failed')),
  provider      text,                       -- LLM provider label, when applicable
  token_count   int,
  error         text,
  detail        jsonb not null default '{}'::jsonb,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Helpful indexes
-- ---------------------------------------------------------------------

create index if not exists idx_topics_workspace_status on topics (workspace_id, status);
create index if not exists idx_packs_topic on content_packs (topic_id);
create index if not exists idx_slides_pack on slides (content_pack_id, position);
create index if not exists idx_scheduled_due on scheduled_posts (status, scheduled_for);
create index if not exists idx_leads_workspace_status on leads (workspace_id, status);
create index if not exists idx_runs_stage_started on pipeline_runs (stage, started_at desc);

-- ---------------------------------------------------------------------
-- Row Level Security — enabled on EVERY table (TRD security rule).
-- Policies are workspace-scoped and live in db/policies.sql (written
-- Day 2, not applied anywhere yet — apply both files with the auth
-- wiring). The service-role key bypasses RLS and is server-side only.
-- ---------------------------------------------------------------------

alter table workspaces       enable row level security;
alter table users            enable row level security;
alter table product_profiles enable row level security;
alter table topics           enable row level security;
alter table content_packs    enable row level security;
alter table slides           enable row level security;
alter table approvals        enable row level security;
alter table scheduled_posts  enable row level security;
alter table leads            enable row level security;
alter table followups        enable row level security;
alter table insights         enable row level security;
alter table pipeline_runs    enable row level security;

commit;

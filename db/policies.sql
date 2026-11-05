-- Signhify GTM Autopilot OS — Row Level Security policies (Supabase Postgres)
-- Companion to db/schema.sql (RLS is enabled there; policies live here).
--
-- Written Day 2. NOT APPLIED ANYWHERE: no Supabase project exists yet.
-- Apply AFTER db/schema.sql, together with the auth wiring:
--   psql "$DATABASE_URL" -f db/schema.sql -f db/policies.sql
--
-- Tenancy model: public.users is the membership table — each user row
-- belongs to exactly one workspace (users.workspace_id) and carries the
-- approver role. Every policy below scopes rows to the workspaces the
-- signed-in user belongs to, resolved through the helper
-- public.auth_workspace_ids().
--
-- TODO (auth wiring): the helper matches public.users.id against
-- auth.uid(), so when Supabase Auth is wired, public.users.id must BE the
-- auth user's id (insert the profile row with id = auth user id at
-- sign-up), or the helper must be re-pointed at a mapping column. Until
-- auth exists, auth.uid() is null, the helper returns no rows, and every
-- policy denies — the safe failure mode. The service-role key bypasses
-- RLS and stays server-side only.

begin;

-- ---------------------------------------------------------------------
-- Helper: the workspaces the current auth user is a member of.
-- security definer so the membership lookup itself is not blocked by the
-- RLS policies on public.users (chicken-and-egg); it only ever returns
-- workspace ids for auth.uid(), never for an arbitrary user.
-- ---------------------------------------------------------------------

create or replace function public.auth_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select workspace_id from public.users where id = auth.uid()
$$;

comment on function public.auth_workspace_ids() is
  'Workspaces the current Supabase Auth user belongs to, via public.users membership. Stub until auth is wired: returns no rows when auth.uid() is null.';

-- ---------------------------------------------------------------------
-- workspaces — the tenancy root. Its own id IS the workspace id, so the
-- scope check is id-based. INSERT is the bootstrap exception: creating a
-- workspace happens before any membership row can exist, so it is
-- allowed for any authenticated user; the app must insert the owner's
-- users row in the same flow. TODO: tighten once sign-up flow exists.
-- ---------------------------------------------------------------------

drop policy if exists workspaces_select on workspaces;
create policy workspaces_select on workspaces
  for select to authenticated
  using (id in (select public.auth_workspace_ids()));

drop policy if exists workspaces_insert on workspaces;
create policy workspaces_insert on workspaces
  for insert to authenticated
  with check (true); -- bootstrap, see note above

drop policy if exists workspaces_update on workspaces;
create policy workspaces_update on workspaces
  for update to authenticated
  using (id in (select public.auth_workspace_ids()))
  with check (id in (select public.auth_workspace_ids()));

drop policy if exists workspaces_delete on workspaces;
create policy workspaces_delete on workspaces
  for delete to authenticated
  using (id in (select public.auth_workspace_ids()));

-- ---------------------------------------------------------------------
-- users — membership rows. A user can always read their own row (needed
-- for the helper-driven UI to bootstrap); everything else is scoped to
-- workspaces they belong to. INSERT allows the sign-up/invite flow to
-- create a membership row; TODO: restrict to owners/admins with roles.
-- ---------------------------------------------------------------------

drop policy if exists users_select on users;
create policy users_select on users
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()) or id = auth.uid());

drop policy if exists users_insert on users;
create policy users_insert on users
  for insert to authenticated
  with check (true); -- sign-up / invite flow, see note above

drop policy if exists users_update on users;
create policy users_update on users
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists users_delete on users;
create policy users_delete on users
  for delete to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

-- ---------------------------------------------------------------------
-- Full CRUD, workspace-scoped: product_profiles, topics, content_packs,
-- slides, leads, followups.
-- ---------------------------------------------------------------------

drop policy if exists product_profiles_select on product_profiles;
create policy product_profiles_select on product_profiles
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists product_profiles_insert on product_profiles;
create policy product_profiles_insert on product_profiles
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists product_profiles_update on product_profiles;
create policy product_profiles_update on product_profiles
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists product_profiles_delete on product_profiles;
create policy product_profiles_delete on product_profiles
  for delete to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists topics_select on topics;
create policy topics_select on topics
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists topics_insert on topics;
create policy topics_insert on topics
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists topics_update on topics;
create policy topics_update on topics
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists topics_delete on topics;
create policy topics_delete on topics
  for delete to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists content_packs_select on content_packs;
create policy content_packs_select on content_packs
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists content_packs_insert on content_packs;
create policy content_packs_insert on content_packs
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists content_packs_update on content_packs;
create policy content_packs_update on content_packs
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists content_packs_delete on content_packs;
create policy content_packs_delete on content_packs
  for delete to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists slides_select on slides;
create policy slides_select on slides
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists slides_insert on slides;
create policy slides_insert on slides
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists slides_update on slides;
create policy slides_update on slides
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists slides_delete on slides;
create policy slides_delete on slides
  for delete to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists leads_select on leads;
create policy leads_select on leads
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists leads_insert on leads;
create policy leads_insert on leads
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists leads_update on leads;
create policy leads_update on leads
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists leads_delete on leads;
create policy leads_delete on leads
  for delete to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists followups_select on followups;
create policy followups_select on followups
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists followups_insert on followups;
create policy followups_insert on followups
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists followups_update on followups;
create policy followups_update on followups
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists followups_delete on followups;
create policy followups_delete on followups
  for delete to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

-- ---------------------------------------------------------------------
-- approvals — the audit gate. Insert / select / update only: approval
-- records are never deleted, so there is deliberately NO delete policy.
-- ---------------------------------------------------------------------

drop policy if exists approvals_select on approvals;
create policy approvals_select on approvals
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists approvals_insert on approvals;
create policy approvals_insert on approvals
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists approvals_update on approvals;
create policy approvals_update on approvals
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

-- ---------------------------------------------------------------------
-- scheduled_posts — full CRUD, workspace-scoped. (The real scheduling
-- gate is structural, in schema.sql: approval_id is NOT NULL.)
-- ---------------------------------------------------------------------

drop policy if exists scheduled_posts_select on scheduled_posts;
create policy scheduled_posts_select on scheduled_posts
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists scheduled_posts_insert on scheduled_posts;
create policy scheduled_posts_insert on scheduled_posts
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists scheduled_posts_update on scheduled_posts;
create policy scheduled_posts_update on scheduled_posts
  for update to authenticated
  using (workspace_id in (select public.auth_workspace_ids()))
  with check (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists scheduled_posts_delete on scheduled_posts;
create policy scheduled_posts_delete on scheduled_posts
  for delete to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

-- ---------------------------------------------------------------------
-- insights — append-only analytics: insert / select only.
-- ---------------------------------------------------------------------

drop policy if exists insights_select on insights;
create policy insights_select on insights
  for select to authenticated
  using (workspace_id in (select public.auth_workspace_ids()));

drop policy if exists insights_insert on insights;
create policy insights_insert on insights
  for insert to authenticated
  with check (workspace_id in (select public.auth_workspace_ids()));

-- ---------------------------------------------------------------------
-- pipeline_runs — append-only run ledger: insert / select only.
-- workspace_id is nullable in the schema (global jobs), so null-workspace
-- runs are visible to / writable by any authenticated user; workspace
-- runs stay scoped.
-- ---------------------------------------------------------------------

drop policy if exists pipeline_runs_select on pipeline_runs;
create policy pipeline_runs_select on pipeline_runs
  for select to authenticated
  using (
    workspace_id is null
    or workspace_id in (select public.auth_workspace_ids())
  );

drop policy if exists pipeline_runs_insert on pipeline_runs;
create policy pipeline_runs_insert on pipeline_runs
  for insert to authenticated
  with check (
    workspace_id is null
    or workspace_id in (select public.auth_workspace_ids())
  );

commit;

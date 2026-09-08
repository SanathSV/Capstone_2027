-- ===========================================================================
-- Astra — Phase 1 schema
-- Run this whole file once in the Supabase SQL Editor (or `psql`).
-- It is idempotent: re-running it drops and recreates the Astra objects only.
-- ===========================================================================

-- Primary keys use gen_random_uuid(), which has been part of core Postgres
-- since 13 — no extension needed. (Older guides tell you to install pgcrypto
-- and call extensions.gen_random_uuid(); on a current Supabase project that
-- qualified name may not resolve, while the bare one always does.)

-- Helper functions used by RLS policies live here. `private` is NOT exposed
-- through PostgREST, so nothing in it is reachable from the browser.
create schema if not exists private;

-- ---------------------------------------------------------------------------
-- 0. Clean slate (safe to run on an existing Astra database)
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;

drop table if exists public.pre_context_runs cascade;
drop table if exists public.team_integrations cascade;
drop table if exists public.team_members     cascade;
drop table if exists public.teams            cascade;
drop table if exists public.employees        cascade;
drop table if exists public.profiles         cascade;

drop function if exists public.handle_new_user()        cascade;
drop function if exists public.link_employee_profile()  cascade;
drop function if exists public.register_team_leader()   cascade;
drop function if exists public.touch_updated_at()       cascade;
drop function if exists private.is_admin()              cascade;
drop function if exists private.is_team_leader(uuid)    cascade;
drop function if exists private.is_team_member(uuid)    cascade;

-- ---------------------------------------------------------------------------
-- 1. profiles — one row per authenticated Astra user
-- ---------------------------------------------------------------------------
-- Mirrors auth.users so the app can join on human-readable fields without ever
-- querying the auth schema. Populated by the on_auth_user_created trigger.
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text,
  avatar_url text,
  -- Who may change the company directory.
  --
  --   'user'   the default. Reads the resource pool, leads and joins teams,
  --            generates pre-context. Cannot add, edit or remove people.
  --   'admin'  everything a user can do, plus managing the resource pool.
  --
  -- Two values rather than a permissions table because there is exactly one
  -- privileged action in the product. A check constraint keeps the column
  -- honest; widening it later is one ALTER away.
  role       text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive uniqueness: Google hands back "Sam@x.com" and "sam@x.com"
-- for the same human, and the employee <-> profile link matches on lower(email).
create unique index profiles_email_lower_key on public.profiles (lower(email));
-- private.is_admin() runs on every directory write; this keeps it an index
-- lookup rather than a scan once the profile table grows.
create index profiles_admin_idx on public.profiles (id) where role = 'admin';

comment on table public.profiles is
  'Astra users. Created automatically when someone signs up via Supabase Auth.';

-- ---------------------------------------------------------------------------
-- 2. employees — the company resource pool
-- ---------------------------------------------------------------------------
-- The cross-walk table that makes context aggregation possible: one real human,
-- and the handle they carry in each third-party system. Every row here can be
-- pulled into any number of teams.
create table public.employees (
  id              uuid primary key default gen_random_uuid(),
  -- Set once the same human signs into Astra. Nullable: most of the directory
  -- is people who never log in, they are only tracked in GitHub/Jira/Slack.
  profile_id      uuid references public.profiles (id) on delete set null,
  full_name       text not null check (length(btrim(full_name)) between 1 and 120),
  email           text not null check (email ~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  title           text check (length(title) <= 120),
  -- The three handles the context engine cross-references. All optional: a
  -- designer may have Slack and Jira but no GitHub account.
  github_username text check (github_username ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  jira_account_id text check (length(jira_account_id) <= 128),
  slack_user_id   text check (slack_user_id ~ '^[UW][A-Z0-9]{6,20}$'),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index employees_email_lower_key on public.employees (lower(email));
create index employees_profile_id_idx        on public.employees (profile_id);
create index employees_created_by_idx        on public.employees (created_by);
-- The context engine looks people up by handle when folding GitHub results back
-- onto real names.
create index employees_github_username_idx   on public.employees (lower(github_username))
  where github_username is not null;

comment on column public.employees.jira_account_id is
  'Jira Cloud accountId (the id returned by /rest/api/3/myself), not a display name.';
comment on column public.employees.slack_user_id is
  'Slack member ID, e.g. U01ABCDEF. Profile -> More -> Copy member ID.';

-- ---------------------------------------------------------------------------
-- 3. teams
-- ---------------------------------------------------------------------------
create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  description text check (length(description) <= 2000),
  -- on delete restrict: a team must never be orphaned. Hand it over first.
  leader_id   uuid not null references public.profiles (id) on delete restrict,
  sprint_name text check (length(sprint_name) <= 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index teams_leader_id_idx on public.teams (leader_id);

-- ---------------------------------------------------------------------------
-- 4. team_members — a resource-pool employee, and the sprint role they play
-- ---------------------------------------------------------------------------
create table public.team_members (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id)     on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  -- Free text on purpose: "Tech Lead", "Frontend Dev", "QA", "SRE". Teams
  -- invent roles faster than an enum can be migrated.
  sprint_role text not null default 'Engineer'
              check (length(btrim(sprint_role)) between 1 and 60),
  is_lead     boolean not null default false,
  created_at  timestamptz not null default now(),
  -- The same person cannot hold two seats on one team.
  unique (team_id, employee_id)
);

-- (team_id, ...) is already covered by the unique constraint's index.
create index team_members_employee_id_idx on public.team_members (employee_id);

-- ---------------------------------------------------------------------------
-- 5. team_integrations — per-team third-party credentials
-- ---------------------------------------------------------------------------
-- One row per team, all fields optional: a team with only GitHub configured
-- still generates a valid (smaller) pre-context payload.
--
-- SECURITY: every *_token column holds AES-256-GCM ciphertext produced by
-- src/lib/crypto.ts, never a plaintext secret. The key lives in
-- ASTRA_ENCRYPTION_KEY on the server and never reaches the browser, so a leaked
-- database dump does not leak the tokens. RLS additionally restricts this table
-- to the team leader.
create table public.team_integrations (
  team_id          uuid primary key references public.teams (id) on delete cascade,

  slack_bot_token  text,
  slack_channel_id text check (slack_channel_id ~ '^[CGD][A-Z0-9]{6,20}$'),

  github_token     text,
  github_repo_url  text check (github_repo_url ~* '^https://github[.]com/[^/[:space:]]+/[^/[:space:]]+/?$'),

  jira_base_url    text check (jira_base_url ~* '^https://[^/[:space:]]+/?$'),
  jira_project_key text check (jira_project_key ~ '^[A-Z][A-Z0-9_]{1,14}$'),
  jira_email       text,
  jira_api_token   text,

  updated_at       timestamptz not null default now()
);

comment on table public.team_integrations is
  'Encrypted at rest by the application layer. Readable only by the team leader.';

-- ---------------------------------------------------------------------------
-- 6. pre_context_runs — an audit log of every "Generate Pre-Context" click
-- ---------------------------------------------------------------------------
-- The payload is the exact JSON handed to the bot container, so a meeting can
-- always be replayed against the context the bot actually had.
create table public.pre_context_runs (
  id             uuid primary key default gen_random_uuid(),
  team_id        uuid not null references public.teams (id) on delete cascade,
  generated_by   uuid references public.profiles (id) on delete set null,
  status         text not null default 'success'
                 check (status in ('success', 'partial', 'failed')),
  -- jsonb, not json: we query into it (payload -> 'roster') and it deduplicates
  -- keys. The bot never reads this row, it receives the payload directly.
  payload        jsonb,
  -- Per-source outcome: {"github": {"ok": true, "ms": 812}, "jira": {...}}
  sources        jsonb not null default '{}'::jsonb,
  error          text,
  token_estimate integer check (token_estimate >= 0),
  duration_ms    integer check (duration_ms >= 0),
  created_at     timestamptz not null default now()
);

-- The team page shows "latest run first", which is exactly this index.
create index pre_context_runs_team_created_idx
  on public.pre_context_runs (team_id, created_at desc);
create index pre_context_runs_generated_by_idx on public.pre_context_runs (generated_by);

-- ===========================================================================
-- 7. Triggers
-- ===========================================================================

-- updated_at maintenance, shared by every table that has the column.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger employees_touch_updated_at
  before update on public.employees
  for each row execute function public.touch_updated_at();
create trigger teams_touch_updated_at
  before update on public.teams
  for each row execute function public.touch_updated_at();
create trigger team_integrations_touch_updated_at
  before update on public.team_integrations
  for each row execute function public.touch_updated_at();

-- --- new auth user -> profile, and adopt any directory row with that email ---
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_role text;
begin
  -- Bootstrapping: the very first person to sign up becomes the admin.
  -- Without this nobody could ever add anyone to the resource pool, and the
  -- app would arrive unusable with no way out except hand-editing SQL.
  -- Everyone after them is a plain user; promote others deliberately with
  -- the statement at the bottom of this file.
  select case when exists (select 1 from public.profiles) then 'user' else 'admin' end
    into v_role;

  insert into public.profiles (id, email, full_name, avatar_url, role)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    v_role
  )
  on conflict (id) do nothing;

  -- Someone already in the resource pool just signed up: claim that row so
  -- "Teams I am In" works from their very first login.
  update public.employees
     set profile_id = new.id
   where profile_id is null
     and lower(email) = lower(new.email);

  return new;
end;
$fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --- new directory row -> link to an existing profile with the same email ---
create or replace function public.link_employee_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.profile_id is null then
    select p.id into new.profile_id
      from public.profiles p
     where lower(p.email) = lower(new.email)
     limit 1;
  end if;
  return new;
end;
$fn$;

create trigger employees_link_profile
  before insert or update of email on public.employees
  for each row execute function public.link_employee_profile();

-- --- new team -> the creator is registered as its Leader, automatically ------
-- Spec: "The user who creates a team is automatically registered as its
-- Leader." Doing this in a trigger rather than in the API route means it holds
-- even for rows inserted by a script or by hand in the SQL editor.
create or replace function public.register_team_leader()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_employee_id uuid;
  v_email       text;
  v_name        text;
begin
  select p.email, coalesce(p.full_name, split_part(p.email, '@', 1))
    into v_email, v_name
    from public.profiles p
   where p.id = new.leader_id;

  if v_email is null then
    return new;  -- no profile, nothing to register
  end if;

  -- The leader may or may not already exist in the resource pool.
  select e.id into v_employee_id
    from public.employees e
   where lower(e.email) = lower(v_email)
   limit 1;

  if v_employee_id is null then
    insert into public.employees (profile_id, full_name, email, title, created_by)
    values (new.leader_id, v_name, v_email, 'Team Leader', new.leader_id)
    returning id into v_employee_id;
  else
    update public.employees
       set profile_id = new.leader_id
     where id = v_employee_id
       and profile_id is null;
  end if;

  insert into public.team_members (team_id, employee_id, sprint_role, is_lead)
  values (new.id, v_employee_id, 'Team Leader', true)
  on conflict (team_id, employee_id)
  do update set is_lead = true, sprint_role = 'Team Leader';

  return new;
end;
$fn$;

create trigger teams_register_leader
  after insert on public.teams
  for each row execute function public.register_team_leader();

-- ===========================================================================
-- 8. RLS helper functions
-- ===========================================================================
-- Both are SECURITY DEFINER so they can read team_members without recursing
-- into that table's own policies. Both hard-code (select auth.uid()) inside the
-- body, so they can only ever answer a question about the *calling* user —
-- passing someone else's team id tells you nothing you were not already
-- allowed to know.

-- Is the caller an admin? SECURITY DEFINER so it can read `profiles` without
-- depending on that table's own policies, and it only ever asks about the
-- calling user, so it cannot be used to probe anyone else's role.
create or replace function private.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $fn$
  select exists (
    select 1 from public.profiles p
     where p.id = (select auth.uid())
       and p.role = 'admin'
  );
$fn$;

create or replace function private.is_team_leader(p_team_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $fn$
  select exists (
    select 1 from public.teams t
     where t.id = p_team_id
       and t.leader_id = (select auth.uid())
  );
$fn$;

create or replace function private.is_team_member(p_team_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.team_members tm
      join public.employees e on e.id = tm.employee_id
     where tm.team_id = p_team_id
       and e.profile_id = (select auth.uid())
  ) or exists (
    select 1 from public.teams t
     where t.id = p_team_id
       and t.leader_id = (select auth.uid())
  );
$fn$;

-- Nobody may call these directly through the API; `authenticated` needs EXECUTE
-- only because RLS policy expressions are evaluated as the querying role.
revoke execute on function private.is_admin()           from public, anon;
revoke execute on function private.is_team_leader(uuid) from public, anon;
revoke execute on function private.is_team_member(uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_admin()           to authenticated;
grant execute on function private.is_team_leader(uuid) to authenticated;
grant execute on function private.is_team_member(uuid) to authenticated;

-- ===========================================================================
-- 9. Row Level Security
-- ===========================================================================
-- Every policy wraps auth.uid() in a scalar subquery — (select auth.uid()) — so
-- Postgres evaluates it once per statement instead of once per row.

alter table public.profiles          enable row level security;
alter table public.employees         enable row level security;
alter table public.teams             enable row level security;
alter table public.team_members      enable row level security;
alter table public.team_integrations enable row level security;
alter table public.pre_context_runs  enable row level security;

-- --- profiles ---------------------------------------------------------------
-- Readable by any signed-in user: the dashboard shows "led by <name>" and the
-- team picker needs to resolve leaders. Only ever names and emails.
create policy profiles_select_authenticated on public.profiles
  for select to authenticated using (true);

create policy profiles_insert_self on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

create policy profiles_update_self on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- --- employees (shared company directory) -----------------------------------
create policy employees_select_authenticated on public.employees
  for select to authenticated using (true);

-- Writing to the directory is an ADMIN action. Everyone can read it -- team
-- creation and the roster pickers depend on that -- but only an admin adds,
-- edits or removes a person.
--
-- Enforced here rather than only in the UI: hiding a button stops the honest
-- mistake, a policy stops a hand-written fetch() from the browser console.
create policy employees_insert_admin on public.employees
  for insert to authenticated
  with check (
    (select private.is_admin())
    and created_by = (select auth.uid())
  );

-- Editing is gated the same way. A directory nobody may add to, but anybody
-- may rewrite, is not actually controlled: changing someone's GitHub handle
-- silently redirects whose commits show up in that team's pre-context.
create policy employees_update_admin on public.employees
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- Deleting cascades into every team's roster, so it is admin-only too.
create policy employees_delete_admin on public.employees
  for delete to authenticated using ((select private.is_admin()));

-- --- teams ------------------------------------------------------------------
create policy teams_select_visible on public.teams
  for select to authenticated
  using (leader_id = (select auth.uid()) or (select private.is_team_member(id)));

create policy teams_insert_as_leader on public.teams
  for insert to authenticated with check (leader_id = (select auth.uid()));

create policy teams_update_leader on public.teams
  for update to authenticated
  using (leader_id = (select auth.uid()))
  with check (leader_id = (select auth.uid()));

create policy teams_delete_leader on public.teams
  for delete to authenticated using (leader_id = (select auth.uid()));

-- --- team_members -----------------------------------------------------------
create policy team_members_select_visible on public.team_members
  for select to authenticated using ((select private.is_team_member(team_id)));

create policy team_members_insert_leader on public.team_members
  for insert to authenticated with check ((select private.is_team_leader(team_id)));

create policy team_members_update_leader on public.team_members
  for update to authenticated
  using ((select private.is_team_leader(team_id)))
  with check ((select private.is_team_leader(team_id)));

create policy team_members_delete_leader on public.team_members
  for delete to authenticated using ((select private.is_team_leader(team_id)));

-- --- team_integrations (secrets: leader only, no exceptions) ----------------
create policy team_integrations_all_leader on public.team_integrations
  for all to authenticated
  using ((select private.is_team_leader(team_id)))
  with check ((select private.is_team_leader(team_id)));

-- --- pre_context_runs -------------------------------------------------------
create policy pre_context_runs_select_members on public.pre_context_runs
  for select to authenticated using ((select private.is_team_member(team_id)));

create policy pre_context_runs_insert_leader on public.pre_context_runs
  for insert to authenticated with check ((select private.is_team_leader(team_id)));

-- ===========================================================================
-- 10. Grants (PostgREST checks table privileges before RLS is ever consulted)
-- ===========================================================================
-- PostgREST resolves the API key to a Postgres role and runs the query as that
-- role, so a missing GRANT fails with "permission denied for schema public"
-- long before any policy is considered. Three roles need naming:
--
--   anon           the publishable/anon key, signed-out visitors
--   authenticated  the publishable/anon key once a session exists — the app
--   service_role   the secret/service_role key — the pre-context engine only
--
-- service_role matters even though it bypasses RLS: bypassing row *policies*
-- is not the same as holding table *privileges*, and these tables were dropped
-- and recreated by this script, so whatever the project was set up with does
-- not necessarily carry over.
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete
  on public.profiles, public.employees, public.teams,
     public.team_members, public.team_integrations, public.pre_context_runs
  to authenticated;

-- The engine reads team_integrations and writes pre_context_runs with this
-- role, after the caller's own session has already proved they lead the team.
grant all privileges
  on public.profiles, public.employees, public.teams,
     public.team_members, public.team_integrations, public.pre_context_runs
  to service_role;

-- Sequences: none of the tables use one today (every key is a uuid), but a
-- future `generated always as identity` column would fail for these roles
-- without this, in a way that is tedious to diagnose.
grant usage, select on all sequences in schema public to authenticated, service_role;

-- ===========================================================================
-- 11. Roles
-- ===========================================================================
-- The first account to sign up is made an admin automatically (see
-- handle_new_user above). To promote or demote anyone else, run:
--
--   update public.profiles set role = 'admin' where lower(email) = 'someone@company.com';
--   update public.profiles set role = 'user'  where lower(email) = 'someone@company.com';
--
-- To see who currently holds it:
--
--   select email, role, created_at from public.profiles order by role, email;
--
-- There is deliberately no UI for this. Granting the ability to edit the
-- cross-walk is the one action in Astra that changes what every team's bot
-- is told, so it is a decision someone makes at the database, on purpose.

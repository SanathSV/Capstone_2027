# Astra — Phase 1

The web console that briefs the meeting bot.

Astra keeps a company **resource pool**, lets a leader assemble a **team** out of
it with sprint roles and integration credentials, and then — on one button —
harvests GitHub, Jira and Slack into a single compact JSON **pre-context
payload**. That payload is what gets injected into the ephemeral bot container
at launch, so the bot walks into a standup already knowing who is in the room,
what they shipped, and what the sprint is supposed to deliver.

```
  ┌───────────────┐        ┌──────────────────┐        ┌────────────────────┐
  │ Resource Pool │───────▶│ Team + Sprint    │───────▶│ Pre-Context Engine │
  │ name, email,  │        │ roles, GitHub /  │        │ fan-out, compact,  │
  │ gh/jira/slack │        │ Jira / Slack keys│        │ one JSON payload   │
  └───────────────┘        └──────────────────┘        └─────────┬──────────┘
                                                                 │
                                       ConfigMap / env file      ▼
                                                        ┌────────────────────┐
   bot-auth/generate_google_auth.py ─── auth.json ──────▶│ Meeting bot pod    │
   (one headful sign-in, on your machine)                │  joins Google Meet │
                                                        └────────────────────┘
```

No Redis, no queue, no cache. The payload is generated on demand and handed
straight to the container — see [Why there is no cache](#why-there-is-no-cache).

**Stack:** Next.js 14 (App Router) · TypeScript · Tailwind CSS · Supabase
(Postgres + Auth) · Python/Playwright for the bot credentials.

---

## Contents

1. [Quick start](#quick-start)
2. [The database schema](#the-database-schema) — the DDL to paste into Supabase
3. [Seed data](#seed-data)
4. [Roles](#roles) — who may change the resource pool
5. [Environment variables](#environment-variables)
6. [How the pre-context engine works](#how-the-pre-context-engine-works)
7. [Google auth for the bot](#google-auth-for-the-bot)
8. [Project layout](#project-layout)
9. [API reference](#api-reference)
10. [Security notes](#security-notes)

---

## Quick start

```bash
# 1. Install
cd astra-platform
npm install

# 2. Create a Supabase project at https://supabase.com, then open the SQL Editor
#    and run supabase/schema.sql (reproduced in full below).

# 3. Configure
cp .env.example .env.local          # PowerShell: Copy-Item .env.example .env.local
npm run keygen                      # prints a key -> ASTRA_ENCRYPTION_KEY

# 4. Run
npm run dev                         # http://localhost:3000
```

Then, in the app:

1. **Create an account.** Supabase Auth creates your `auth.users` row; a trigger
   creates the matching `profiles` row.
2. **Fill the Resource Pool.** Add people with their GitHub username, Jira
   account ID and Slack user ID. This cross-walk is what everything else hangs
   off — an employee with no handles will appear on the roster and in nothing
   else.
3. **Create a team.** You become its Leader automatically. Pick people, give
   them sprint roles, paste the integration credentials.
4. **Press Generate Pre-Context.** The payload is rendered on the page, printed
   to your `npm run dev` terminal, and stored in `pre_context_runs`.

> **Supabase auth settings.** Two things, both in the dashboard:
>
> 1. For local development, turn *off* "Confirm email" under Authentication →
>    Providers → Email. Otherwise every sign-up sends a confirmation mail, and
>    the built-in sender allows only **2 emails per hour for the whole
>    project** — a few minutes of testing exhausts it and sign-up starts
>    returning `429`.
> 2. Add `http://localhost:3000/auth/callback` to Authentication → URL
>    Configuration → Redirect URLs. **Password recovery and magic links do not
>    work without this** — Supabase refuses to redirect to an unlisted URL, so
>    the link in the email dead-ends.

### Signing in

Three ways in, all landing on the same `profiles` row — the
`on_auth_user_created` trigger does not care how you got there:

| Method | Sends email? | Good for |
|---|---|---|
| Email + password | no (with confirmation off) | everyday use, and all local development |
| Magic link | yes | people who would rather not manage a password |
| Password reset | yes | forgetting the password |

**Password recovery.** "Forgot password?" on the sign-in form sends a
single-use link that expires in an hour. Opening it hits `/auth/callback`,
which trades the one-time code for a real session and forwards to
`/reset-password`. That page is therefore an ordinary authenticated
`updateUser({ password })` call — there is no token being passed around in the
URL for someone to leak in a `Referer` header.

`/reset-password` is deliberately reachable while signed out: an expired or
already-used link arrives with no session, and the page says so instead of
bouncing you to a login form with no explanation. Both email-sending paths
spend from the same 2-per-hour budget, which the form now says on screen.

---

## The database schema

Run this in the **Supabase SQL Editor** before starting the app. It is
reproduced here in full as the canonical reference; the identical, runnable copy
lives at [`supabase/schema.sql`](supabase/schema.sql).

Five tables plus an audit log:

| Table | What it holds |
|---|---|
| `profiles` | One row per Astra user, mirroring `auth.users`, plus their `role`. |
| `employees` | The resource pool — the name↔handle cross-walk. |
| `teams` | A team and its leader. |
| `team_members` | Who is on a team, and their sprint role. |
| `team_integrations` | Per-team GitHub/Jira/Slack credentials, encrypted. |
| `pre_context_runs` | Every payload ever generated, for replay and audit. |

Three design decisions worth knowing before you read the DDL:

- **The leader is registered by a trigger, not by the app.** `teams_register_leader`
  fires after every insert into `teams`, creates a directory entry for the
  creator if they do not have one, and seats them with `is_lead = true`. So the
  rule holds even for a row inserted by hand in the SQL editor.
- **Employees link to profiles by email.** Someone can be in the resource pool
  for months before they ever sign in. When they do,
  `handle_new_user` claims their directory row, and "Teams I am In" works from
  their first login.
- **There are two roles, and only one privileged action.** `profiles.role` is
  `'user'` or `'admin'`. Admins manage the resource pool — adding, editing and
  removing people. Everyone else reads it, leads teams, and generates
  pre-context exactly as before. Those handles decide whose commits and issues
  land in every team's payload, which is why editing them is not open to all.
  The **first account to sign up becomes the admin**, because otherwise the
  directory would arrive unmanageable.
- **RLS helpers live in a `private` schema.** `private.is_team_member()` and
  `private.is_team_leader()` are `SECURITY DEFINER`, so team policies can read
  `team_members` without recursing into that table's own policy. Both hard-code
  `auth.uid()` internally, so they can only answer a question about the caller.


```sql
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
```

### Verifying it took

```sql
-- 6 tables in public
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;

-- RLS on, everywhere
select relname, relrowsecurity from pg_class
 where relnamespace = 'public'::regnamespace and relkind = 'r';

-- policies present
select tablename, policyname, cmd from pg_policies
 where schemaname = 'public' order by tablename, policyname;
```

---

## Seed data

Run **after** `schema.sql`, and after you have signed up in the app at least
once — the demo team needs a real `auth.users` row to lead it. The runnable copy
is [`supabase/seed.sql`](supabase/seed.sql).

Replace `you@example.com` with your own login email before running it.

```sql
-- ===========================================================================
-- Astra — seed data
-- Run AFTER schema.sql, and AFTER you have signed up at least once in the app
-- (the team needs a real auth user to lead it).
--
-- BEFORE YOU RUN IT: replace 'you@example.com' in section 2 with the email you
-- signed up with. (Deliberately a literal rather than a psql \set variable —
-- the Supabase SQL Editor is not psql and would reject the backslash command.)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Resource pool
-- ---------------------------------------------------------------------------
-- Replace the handles with real ones before generating pre-context: the GitHub
-- and Jira lookups filter on exactly these strings.
insert into public.employees
  (full_name, email, title, github_username, jira_account_id, slack_user_id, created_by)
values
  ('Ada Lovelace',    'ada@astra.dev',    'Principal Engineer', 'adalovelace',  '5b10a2844c20165700ede21g', 'U01ADA0001', null),
  ('Grace Hopper',    'grace@astra.dev',  'Tech Lead',          'gracehopper',  '5b10a2844c20165700ede21h', 'U01GRC0002', null),
  ('Alan Turing',     'alan@astra.dev',   'Backend Engineer',   'alanturing',   '5b10a2844c20165700ede21i', 'U01ALN0003', null),
  ('Katherine Johnson','kat@astra.dev',   'Frontend Engineer',  'katjohnson',   '5b10a2844c20165700ede21j', 'U01KAT0004', null),
  ('Linus Torvalds',  'linus@astra.dev',  'Platform / SRE',     'torvalds',     '5b10a2844c20165700ede21k', 'U01LIN0005', null),
  ('Margaret Hamilton','margaret@astra.dev','QA Lead',          'mhamilton',    '5b10a2844c20165700ede21l', 'U01MAR0006', null),
  ('Barbara Liskov',  'barbara@astra.dev','Product Manager',    null,           '5b10a2844c20165700ede21m', 'U01BAR0007', null),
  ('Radia Perlman',   'radia@astra.dev',  'Designer',           null,           null,                       'U01RAD0008', null)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. A demo team led by your account
-- ---------------------------------------------------------------------------
-- The teams_register_leader trigger adds YOU to the roster as "Team Leader"
-- automatically, so this block only has to add everyone else.
do $seed$
declare
  v_leader_id uuid;
  v_team_id   uuid;
begin
  select id into v_leader_id
    from public.profiles
   where lower(email) = lower('you@example.com')   -- <<< your login email
   limit 1;

  if v_leader_id is null then
    raise notice 'No profile for that email yet. Sign up in the app first, then re-run this block.';
    return;
  end if;

  insert into public.teams (name, description, leader_id, sprint_name)
  values (
    'Payments Core',
    'Owns the checkout and settlement services. Sprint standups are transcribed by Astra.',
    v_leader_id,
    'Sprint 24 — Settlement hardening'
  )
  returning id into v_team_id;

  insert into public.team_members (team_id, employee_id, sprint_role)
  select v_team_id, e.id, r.sprint_role
    from (values
      ('grace@astra.dev',    'Tech Lead'),
      ('alan@astra.dev',     'Backend Dev'),
      ('kat@astra.dev',      'Frontend Dev'),
      ('linus@astra.dev',    'DevOps'),
      ('margaret@astra.dev', 'QA'),
      ('barbara@astra.dev',  'Product Manager')
    ) as r(email, sprint_role)
    join public.employees e on lower(e.email) = r.email
  on conflict (team_id, employee_id) do nothing;

  -- Integration credentials are deliberately NOT seeded: they must be written
  -- through the app so they get encrypted with ASTRA_ENCRYPTION_KEY. Adding
  -- plaintext here would make every later read fail to decrypt.
  raise notice 'Seeded team % — now open it in Astra and fill in the integrations tab.', v_team_id;
end;
$seed$;

-- ---------------------------------------------------------------------------
-- 3. Sanity checks
-- ---------------------------------------------------------------------------
-- select full_name, github_username, jira_account_id, slack_user_id from public.employees order by full_name;
-- select t.name, p.email as leader, count(tm.*) as members
--   from public.teams t
--   join public.profiles p on p.id = t.leader_id
--   left join public.team_members tm on tm.team_id = t.id
--  group by t.name, p.email;
```

The integration credentials are deliberately **not** seeded. They have to be
entered through the app so they are encrypted with your `ASTRA_ENCRYPTION_KEY`;
plaintext written straight into the table would fail to decrypt on every later
read.

---

## Roles

| | `user` | `admin` |
|---|---|---|
| Read the resource pool | yes | yes |
| **Add / edit / remove people in it** | **no** | **yes** |
| Create a team, and lead it | yes | yes |
| Put pool members on a team they lead | yes | yes |
| Store that team's API credentials | yes | yes |
| Generate pre-context for a team they lead | yes | yes |

The first account to sign up is promoted automatically. After that:

```sql
update public.profiles set role = 'admin' where lower(email) = 'someone@company.com';
update public.profiles set role = 'user'  where lower(email) = 'someone@company.com';
select email, role from public.profiles order by role, email;
```

There is deliberately no UI for granting this. It is the one action that
changes what every team's bot is told, so it is a decision someone makes at
the database, on purpose.

The Resource Pool page shows an **Admin** or **Read only** chip so you always
know which you are. For a non-admin the add form is replaced by an explanation
rather than being left visible and broken, and the per-row Edit and Remove
buttons are absent. None of that is the actual protection — the RLS policies
are, so a hand-written `fetch()` from the browser console is refused by the
database just the same.

**Already have a database?** Run
[`supabase/add-roles.sql`](supabase/add-roles.sql). It is additive — one
column, one helper, three policies — and promotes your existing first account
so you are not locked out of your own directory.

---

## Environment variables

`.env.local`, gitignored. Copy `.env.example`.

| Variable | Where it comes from | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → Data API | The **bare origin**, `https://abc.supabase.co` — *not* the "RESTful endpoint" ending in `/rest/v1`. supabase-js appends its own paths. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Settings → API Keys | `sb_publishable_…` or the legacy `anon` JWT; either works. Safe in the browser — RLS is what protects the data. |
| `SUPABASE_SERVICE_ROLE_KEY` | same page | `sb_secret_…` or the legacy `service_role` JWT. **Server only.** Bypasses every RLS policy. |
| `ASTRA_ENCRYPTION_KEY` | `npm run keygen` | 32 random bytes, base64. Encrypts the stored tokens. |
| `NEXT_PUBLIC_SITE_URL` | you | Used to build the auth redirect URL. |
| `ASTRA_ALLOW_LOCAL_BOT_AUTH` | you | `1` to permit the headful bot sign-in. Leave unset on a server. |
| `ASTRA_PYTHON` | you | Interpreter with Playwright installed. Optional. |

**On `ASTRA_ENCRYPTION_KEY`:** every GitHub/Jira/Slack token is stored as
AES-256-GCM ciphertext in an envelope (`v1.<iv>.<tag>.<ciphertext>`). Rotating
the key makes every stored token undecryptable — the app says so explicitly
rather than reporting the integrations as unconfigured — and each team's tokens
have to be re-entered.

**On the service role key:** it is used in exactly two places, both in
`src/app/api/teams/[id]/pre-context/route.ts`, and both strictly *after*
`requireTeamLeader()` has proved with the caller's own session that they lead
the team: reading the encrypted credentials, and writing the audit row.

---

## How the pre-context engine works

`POST /api/teams/:id/pre-context` →
[`src/lib/context/aggregate.ts`](src/lib/context/aggregate.ts).

```
requireTeamLeader()          RLS proves the caller leads this team
        │
        ├── roster           team_members ⨝ employees  (the cross-walk)
        │
        ├── decrypt          team_integrations, service role, AES-256-GCM
        │
        ├── fan out ─┬─ GitHub  repo · open PRs · commits (14d), filtered by handle
        │            ├─ Jira    board → active sprint → goal → issues by accountId
        │            └─ Slack   channel membership vs. the roster's Slack IDs
        │                       (all three in parallel; each fails independently)
        │
        ├── analyse          sprint health, per-person rollup, risks, agenda
        │
        ├── compact          prune nulls, cap lists, truncate text, enforce 96 KB
        │
        └── emit             JSON response + console.log + pre_context_runs row
```

### Context engineering

Raw API output does not fit a bot's context window. A busy repository returns
hundreds of open PRs and a Jira board thousands of issues, and almost none of it
concerns the six people in the standup. So the engine narrows in three passes,
all tuned from `LIMITS` in
[`src/lib/context/compaction.ts`](src/lib/context/compaction.ts):

| Pass | What it does |
|---|---|
| **Filter** | Everything is intersected with the roster's handles. PRs by people outside the team, issues assigned elsewhere, commits from a bot account — dropped at the source, never carried in memory. |
| **Trim** | 20 PRs, 30 commits, 50 issues; titles to 110 chars, commit *subject lines only*. Nulls and empty arrays are pruned — `"reviews": null` costs tokens and teaches nothing. |
| **Budget** | If the result still exceeds 96 KB, shed in order of redundancy: commits first (the PR list already says what is in flight), then PRs, then issues last (the sprint board *is* the agenda). |

Everything dropped is named in `meta.truncated`, so a thin payload is never
mistaken for a quiet sprint.

The payload also carries a **digest**: pre-computed facts the model would
otherwise have to derive mid-sentence — days left in the sprint, PRs open more
than a week, who has no commits in the window, who has nothing assigned.

### The analysis layer

Raw lists make the bot do arithmetic mid-sentence, which is exactly when models
invent numbers. So
[`src/lib/context/analytics.ts`](src/lib/context/analytics.ts) does the
reasoning once, deterministically, and the payload carries conclusions.

| Field | What it answers |
|---|---|
| `analysis.sprint` | Completion measured **against elapsed time** — "60% done" is excellent on day three and alarming on day nine. Verdict is `ahead` / `on_track` / `behind` / `at_risk`, with one sentence safe to read aloud. Uses story points when the team estimates, issue count otherwise. |
| `analysis.per_member` | One row per person, sorted busiest-first — commits, open and stale PRs, **reviews waiting on them**, issues in progress, done, points, branches. Shaped like the meeting: a standup goes around the room, so does this. |
| `analysis.risks` | Everything worth flagging, most serious first: stale PRs, stalled issues, WIP overload, review bottlenecks, idle members, and *claimed-but-quiet* — work in progress in Jira with nothing in the repository, which is the most useful cross-source signal in the payload. |
| `analysis.talking_points` | The agenda, in order, as sentences. At most two items of any one kind, so it covers different problems rather than six near-identical stale PRs; the rest roll into a counted line and stay individually in `risks`. |
| `analysis.totals` | Headline counts, so nothing has to be summed. |
| `analysis.complete` | Whether every configured source answered. |

**`complete` is the important field.** Every conclusion drawn from an *absence*
is gated on it. "Nobody heard from Kat this week" is a sentence that gets said
out loud in a meeting, and it must never be an artefact of a branch that 403'd —
so with a failed source, the analysis reports what it observed and asserts
nothing about what it did not.

Thresholds live in one block at the top of that file: stale at 7 days, very
stale at 14, WIP limit 3, stalled issue at 5 days, review bottleneck at 3,
15 points of schedule tolerance.

**Cost.** On a 9-person team with 20 PRs, 30 commits and 50 sprint issues the
analysis adds ~1,300 tokens against ~3,800 for the raw sections — about 34%
overhead, and roughly a fifth of the 96 KB budget in total. It buys back more
than it costs: the bot reads a verdict instead of deriving one.

### Partial failure is normal

A team may have GitHub configured and Jira not. A Jira token may have expired
this morning. Each source therefore fails on its own and records why in
`meta.sources`; the run is reported as `partial`, not thrown away. A standup with
GitHub context and no Jira context is still a much better standup.

| `status` | Meaning |
|---|---|
| `success` | Every configured source answered. |
| `partial` | Some answered, some failed — or nothing is configured yet and you got the roster cross-walk alone. |
| `failed` | Every configured source failed. |

### The payload

```jsonc
{
  "schema": "astra.precontext/v1",
  "team":   { "id": "…", "name": "Payments Core", "sprint": "Sprint 24" },
  "roster": [
    { "ref": "gracehopper", "name": "Grace Hopper", "role": "Tech Lead",
      "gh": "gracehopper", "jira": "5b10a284…", "slack": "U01GRC0002", "lead": true }
  ],
  "github": {
    "repo": "acme/payments",
    "open_prs":       [{ "num": 418, "title": "…", "author": "gracehopper", "age_days": 9 }],
    "recent_commits": [{ "sha": "a1b2c3d", "msg": "…", "author": "alanturing", "at": "2026-09-05" }],
    "commits_by_member": { "gracehopper": 12, "alanturing": 4 },
    "quiet_members": ["katjohnson"]
  },
  "jira": {
    "sprint": { "name": "Sprint 24", "goal": "Settlement retries under 200ms", "days_left": 4 },
    "issues": [{ "key": "PAY-812", "summary": "…", "status": "In Progress", "assignee": "alanturing" }],
    "status_counts": { "To Do": 3, "In Progress": 5, "Done": 11 }
  },
  // The derived layer: read this first, it is the same facts already reasoned about.
  "analysis": {
    "sprint": { "verdict": "behind", "elapsed_pct": 57, "points_done_pct": 33,
                "days_left": 6, "goal": "Settlement retries under 200ms",
                "note": "33% complete with 57% elapsed — 24 points behind the line." },
    "per_member": [
      { "ref": "katjohnson", "name": "Kat Johnson", "role": "Frontend Dev",
        "commits": 0, "prs_open": 0, "prs_stale": 0, "in_progress": 4, "done": 0,
        "signals": ["4 issue(s) in progress but no commits or PRs"] }
    ],
    "risks": [
      { "kind": "claimed_but_quiet", "severity": "medium", "subject": "katjohnson",
        "detail": "Kat Johnson has 4 issue(s) in progress but nothing in the repository — worth asking what is blocking them." }
    ],
    "talking_points": ["Sprint goal: Settlement retries under 200ms", "…"],
    "totals": { "members": 6, "commits": 16, "open_prs": 4, "stale_prs": 2,
                "issues": 50, "in_progress": 17 },
    "complete": true
  },
  "digest": ["Jira sprint \"Sprint 24\" (active, 4d remaining).", "…"],
  "meta":   { "sources": {…}, "truncated": [], "token_estimate": 1840, "bytes": 7362 }
}
```

`ref` is the join key: every author, assignee and reviewer elsewhere in the
payload is one of these short names, so the model never has to work out that
`gracehopper` and `5b10a284…` are the same person.

### Why there is no cache

Sprint state moves during the sprint. A cached payload is a payload that is
wrong about what someone pushed this morning, which is precisely what a standup
is about. The payload is generated on demand, handed to the container at launch,
and lives for exactly one meeting. Every run is still recorded in
`pre_context_runs` — as history, not as a cache.

### Handing it to the bot

```bash
# Download the payload from the team page, then:
kubectl create configmap astra-precontext-payments --from-file=precontext.json

# or for the docker-compose bot in ../Meeting_Bot:
docker run \
  -v $PWD/precontext.json:/context/precontext.json:ro \
  -v $PWD/bot-auth/secrets/auth.json:/creds/auth.json:ro \
  astra-meeting-bot
```

---

## Google auth for the bot

**One bot account per Team Leader, not per team.** A leader who runs three
standups signs in once, and every team they lead uses that session. The
credential is therefore keyed on the leader's user id, never on a team id.

### Setting it up

**Settings → Bot Account Setup → Authenticate Bot Account.** That opens a real
Chromium window on the machine running Astra; sign in to the dedicated bot
Google account there, then close it. The page polls and updates itself.

The session is written to

```
bot-auth/secrets/leaders/{user_id}/auth.json     the credential
bot-auth/secrets/leaders/{user_id}/meta.json     the status the dashboard reads
```

`meta.json` exists so that answering "is this bot ready?" never involves opening
a file full of live Google cookies.

### Why this only works locally

Signing in means completing Google's password prompt, 2FA and device checks *by
hand*. That needs a screen and the leader in front of it, which a deployed
server has neither of. So the flow is gated on
`ASTRA_ALLOW_LOCAL_BOT_AUTH=1` — unset on a real server, where the button then
explains why instead of hanging on a window that can never appear.

Set `ASTRA_PYTHON` if the interpreter with Playwright installed is not plain
`python` / `python3` (a virtualenv, typically).

### How other people see the status

The credential is on one laptop, but a team member needs to know before the
standup whether their leader's bot can actually join. So the file stays local
and its **status** is published to `bot_credentials` in Postgres — status,
the bot's Google address, cookie count, expiry. Never the session itself. The
team page reads that row and shows the leader's badge to everyone.

| Badge | Means |
|---|---|
| **Authenticated** | signed in, and the session has not expired |
| **Expired** | there was a session; its cookies have lapsed |
| **Revoked** | deliberately signed out |
| **Not Authenticated** | never set up — the bot would join as a guest, if admitted at all |

Run [`supabase/add-bot-credentials.sql`](supabase/add-bot-credentials.sql) to
create that table. Additive, no data loss.

### Phase 2

`auth.json` moves to Supabase Storage under `leaders/{user_id}/auth.json` in a
private bucket, and the bot container downloads it with a signed URL instead of
having it bind-mounted. The local layout already mirrors those keys, so the
migration is a copy rather than a rename. The upload hook is marked in
`src/lib/botAuth.ts`, in the run's `close` handler — the one place where a run
is known to have succeeded.

### The script on its own

The same script is still a normal CLI, which is how you check a session without
the dashboard:



The bot joins Meet as a real signed-in account: guests wait in the lobby, cannot
always enable captions, and some organisations refuse them outright.

It cannot have a password — Google blocks automated sign-in, and a password in
an image is not a thing we are going to do. So a human signs in **once**, on a
machine with a screen, and the session is exported as JSON.

```bash
cd bot-auth
pip install -r requirements.txt
python -m playwright install chromium

python generate_google_auth.py              # headful, sign in, writes secrets/auth.json
python generate_google_auth.py --check      # inspect the file, no browser
python generate_google_auth.py --verify     # open it in a clean browser and prove it works
```

**Why JSON and not a Chrome profile.** A profile directory is not portable:
cookie values are AES-GCM encrypted under a master key that Windows wraps with
DPAPI and macOS keeps in the Keychain, so Linux Chrome in a container cannot read
a profile made on a Windows laptop — the account silently looks signed out.
Playwright reads cookies already decrypted over CDP, so `storage_state()`
produces a file that works anywhere. This is the same reasoning behind
`Meeting_Bot/meet_listener.py`'s `storage_state.json`; this script is that step,
standalone, with the output named `auth.json`.

`--verify` is the honest test: it loads the file into a browser that has nothing
else, which is exactly what the container does.

**`auth.json` is a live Google session.** Anyone holding it is signed in as the
bot account with no password and no second factor. It is gitignored, written
owner-only where the OS supports it, and should reach the container through a
secret store rather than an image layer.

---

## Project layout

```
astra-platform/
├── README.md                  this file
├── INTEGRATIONS.md            GitHub / Jira / Slack setup, step by step
├── supabase/
│   ├── schema.sql             the DDL above, runnable
│   └── seed.sql               demo directory + team
├── bot-auth/
│   ├── generate_google_auth.py   headful sign-in → auth.json
│   └── requirements.txt
├── chrome-extension/          standalone MV3 extension (no build step)
│   ├── manifest.json
│   ├── config.js              your Supabase URL + key + API base
│   ├── popup.html/.css/.js
│   ├── background.js          session refresh + tab badge
│   └── lib/                   supabase (fetch-only), session, api
└── src/
    ├── middleware.ts          session refresh + route gating
    ├── app/
    │   ├── login/             sign in / sign up / magic link / forgot password
    │   ├── reset-password/    set a new password after a recovery link
    │   ├── settings/         profile, and Bot Account Setup
    │   ├── dashboard/         Teams I Lead · Teams I am In
    │   ├── directory/         the resource pool
    │   ├── teams/new/         three-step creation wizard
    │   ├── teams/[id]/        roster · integrations · pre-context
    │   └── api/               route handlers
    ├── components/
    └── lib/
        ├── api.ts             error envelope, auth + leader guards
        ├── crypto.ts          AES-256-GCM envelope for stored tokens
        ├── preContextService.ts  the generation flow, shared by both routes
        ├── apiAuth.ts        bearer-token auth + CORS, for the extension
        ├── botAuth.ts        spawns the Playwright sign-in, reads its status
        ├── db/                row types and server-side queries
        └── context/           ← the engine
            ├── aggregate.ts   fan-out, digest, status
            ├── analytics.ts   ← sprint health, risks, the agenda
            ├── markdown.ts    ← the payload as Markdown (what ships)
            ├── github.ts      repo · PRs · commits
            ├── jira.ts        board → sprint → issues
            ├── slack.ts       channel membership check
            ├── compaction.ts  the token budget
            └── http.ts        timeouts, retries, readable errors
```

---

## The Chrome extension

[`chrome-extension/`](chrome-extension/) is a standalone Manifest V3 extension
that summons a briefed bot into whatever Google Meet you are looking at. No
build step — point **Load unpacked** at the folder. Set your Supabase values in
`chrome-extension/config.js` first; the full guide is
[`chrome-extension/README.md`](chrome-extension/README.md).

It signs in with Supabase Auth, lists the teams you lead, and on selecting one
**prefetches both payloads** — the team's pre-context and your bot's Google
session — so that pressing **Connect Bot** is a single POST of data already in
memory rather than the start of a multi-second wait while the meeting runs.

Three routes exist for it, all bearer-authenticated and CORS-enabled, because an
extension has its own origin and no cookies for this site:

| Route | Returns |
|---|---|
| `GET /api/teams/:id/precontext` | **Markdown** — about half the tokens of the same data as JSON (see [COMPACTION_ALGO.md](COMPACTION_ALGO.md)). A run under 10 minutes old, or freshly generated. `?format=json` for the structured payload; `?refresh=1` forces a new run. |
| `GET /api/bot-auth/session` | Your own bot session. Local-only, gated on `ASTRA_ALLOW_LOCAL_BOT_AUTH`. |
| `POST /api/bot/summon` | Prints the four fields and acknowledges. Phase 2 launches the container here. |

**On credentials.** `/api/bot-auth/session` returns a live Google session, so it
only ever serves the caller's own, only on a machine with the local flag set,
and the summon log records the credential's *shape* — counts, state, the bot's
email — never a cookie value. A terminal log is the easiest place to leak a
secret from. Round-tripping it through a browser is a Phase-1 convenience; in
Phase 2 the container reads it straight from Supabase Storage and that route
goes away.

---

## API reference

Every route requires a session cookie. Team routes additionally require
leadership where noted; RLS enforces the same rule at the database level, so a
forged request fails twice.

| Method | Path | Who | Does |
|---|---|---|---|
| `GET` | `/api/employees` | any user | List the resource pool. |
| `POST` | `/api/employees` | **admin** | Add someone. Validates all three handles. |
| `PATCH` | `/api/employees/:id` | **admin** | Update the fields you send. |
| `DELETE` | `/api/employees/:id` | **admin** | Remove; cascades into every roster. |
| `GET` | `/api/teams` | any user | Teams you lead or are on. |
| `POST` | `/api/teams` | any user | Create a team + roster + integrations. You become Leader. |
| `GET` | `/api/teams/:id` | member | One team. |
| `PATCH` | `/api/teams/:id` | leader | Rename, re-describe, change sprint. |
| `DELETE` | `/api/teams/:id` | leader | Delete; cascades to roster, credentials, runs. |
| `GET` | `/api/teams/:id/members` | member | The roster with employee records. |
| `POST` | `/api/teams/:id/members` | leader | Seat one person or a batch. |
| `PATCH` | `/api/teams/:id/members/:memberId` | leader | Change a sprint role. |
| `DELETE` | `/api/teams/:id/members/:memberId` | leader | Unseat (they stay in the pool). |
| `GET` | `/api/teams/:id/integrations` | leader | Redacted view — booleans, never tokens. |
| `PUT` | `/api/teams/:id/integrations` | leader | Save. Omitted token = unchanged, `""` = cleared. |
| `POST` | `/api/teams/:id/pre-context` | leader | **Generate the payload.** Always fresh; never cached. |
| `GET` | `/api/teams/:id/precontext` | leader | Same engine, but reuses a run under 10 minutes old. For the extension's prefetch. |
| `GET` | `/api/bot-auth` | any user | Your bot's status, and any sign-in in flight. |
| `POST` | `/api/bot-auth` | any user | Open the headful Google sign-in window. |
| `GET` | `/api/bot-auth/status` | any user | Cheap poll while that window is open. |
| `DELETE` | `/api/bot-auth` | any user | Revoke, or `?cancel=1` to abort a sign-in. |

Errors are uniform: `{ "error": "a sentence you can act on", "detail": null }`
with a real status code. Unexpected failures log server-side and return a
generic 500 — database internals do not travel to the browser.

---

## If something is denied

`permission denied for schema public` when you press **Generate Pre-Context**,
while the rest of the app works: the `service_role` grants are missing. That
button is the only thing that uses the service-role key, so it is the only thing
that fails. Run [`supabase/fix-grants.sql`](supabase/fix-grants.sql) — it is
additive and touches no data.

The same file's first query prints what each of `anon`, `authenticated` and
`service_role` can actually do, which is the quickest way to tell a privilege
problem (fails for everyone, same way) from an RLS problem (works for the leader,
returns nothing for everyone else).

---

## Security notes

- **RLS is the access control**, not the API layer. The route handlers query as
  the signed-in user; a policy bug would show up as missing data, not as leaked
  data. `team_integrations` is leader-only, so a team member cannot read the
  credentials even by querying Supabase directly with their own token.
- **Tokens are encrypted at rest** and never sent to the browser — not even
  masked, because a masked value still has to travel to be masked. The settings
  form learns only whether a token exists.
- **The service role key** appears in exactly one route, after a leadership
  check. It must never be given a team id straight off a request.
- **`auth.json` is a credential.** See above.
- **`.env.local`, `bot-auth/secrets/` and every `auth.json` are gitignored.**
  Check before your first commit: `git status --short`.
- **Recording a meeting is subject to the consent rules of everyone in it.** The
  bot appears in the participant list, but announce it anyway.

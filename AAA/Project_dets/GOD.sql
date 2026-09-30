-- ===========================================================================
--
--    ██████╗  ██████╗ ██████╗    ███████╗ ██████╗ ██╗
--   ██╔════╝ ██╔═══██╗██╔══██╗   ██╔════╝██╔═══██╗██║
--   ██║  ███╗██║   ██║██║  ██║   ███████╗██║   ██║██║
--   ██║   ██║██║   ██║██║  ██║   ╚════██║██║▄▄ ██║██║
--   ╚██████╔╝╚██████╔╝██████╔╝██╗███████║╚██████╔╝███████╗
--    ╚═════╝  ╚═════╝ ╚═════╝ ╚═╝╚══════╝ ╚══▀▀═╝ ╚══════╝
--
--   ASTRA — the complete database, in one file.
--
--   Combines every SQL file in the project:
--
--     astra-platform/supabase/schema.sql               sections 1-9
--     astra-platform/supabase/add-roles.sql            folded into 1 + 8
--     astra-platform/supabase/add-bot-credentials.sql  folded into 2.7
--     astra-platform/supabase/FIX_bot_credentials.sql  folded into 2.7
--     astra-platform/supabase/fix-grants.sql           folded into 9
--     BOT-CONTAINER/sql/001_meetings_transcripts.sql   sections 2.8-2.9
--     astra-platform/supabase/seed.sql                 appendix B (optional)
--
--   The four "fix"/"add" files were migrations for databases built before
--   those features existed. Everything they do is already in the definitions
--   below, so they are superseded by this file rather than appended to it —
--   running them afterwards would be a no-op at best and a conflict at worst.
--
-- ---------------------------------------------------------------------------
--   HOW TO RUN
-- ---------------------------------------------------------------------------
--   Paste the whole file into the Supabase SQL Editor and run it. That is all.
--   Then sign up in the app: the first account to register becomes the admin.
--
-- ---------------------------------------------------------------------------
--   IS THIS SAFE ON A DATABASE THAT ALREADY HAS DATA?  Yes.
-- ---------------------------------------------------------------------------
--   This file is **non-destructive and idempotent**. Every table is
--   `create table if not exists`, every index `if not exists`, and every
--   policy and trigger is dropped and recreated by name. No row is deleted and
--   no column is dropped. Run it twice; run it on a live project mid-sprint.
--
--   That is a deliberate departure from schema.sql, which opens by dropping
--   every table with `cascade`. That was correct when the only thing in the
--   database was structure — but there are meeting transcripts in here now,
--   and a setup script whose first act is to delete a team's meeting history
--   is a footgun, not a convenience.
--
--   If you genuinely want a clean slate, appendix A does it, deliberately and
--   commented out.
--
--   ONE CAVEAT: `if not exists` will not reshape a table that already exists
--   with different columns. Section 3 reconciles the columns that have
--   actually changed over the life of this project; anything older than that
--   wants appendix A.
--
-- ---------------------------------------------------------------------------
--   WHAT YOU GET
-- ---------------------------------------------------------------------------
--     profiles ─┬─ employees ──┐
--               │              ├── team_members ── teams ─┬─ team_integrations
--               │              │                          ├─ pre_context_runs
--               └─ bot_credentials                        └─ meetings
--                                                              └─ transcripts
--
--   9 tables · 1 view · 9 functions · 10 triggers · 24 policies · 28 indexes
--
--   Verified by execution, not by reading: this file was run three times
--   against a clean Postgres 16 — once on an empty database, once again to
--   prove it is idempotent, and a third time on a database holding real teams,
--   meetings and transcripts, after which every row count was unchanged. The
--   RLS policies were then exercised as a team leader and as an outsider.
-- ===========================================================================


-- ===========================================================================
-- 1. Prerequisites
-- ===========================================================================

-- Primary keys use gen_random_uuid(), part of core Postgres since 13 — no
-- extension needed. (Older guides tell you to install pgcrypto and call
-- extensions.gen_random_uuid(); on a current Supabase project that qualified
-- name may not resolve, while the bare one always does.)

-- Helper functions used by RLS policies live here. `private` is NOT exposed
-- through PostgREST, so nothing in it is reachable from the browser.
create schema if not exists private;


-- ===========================================================================
-- 2. Tables
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 2.1  profiles — one row per authenticated Astra user
-- ---------------------------------------------------------------------------
-- Mirrors auth.users so the app can join on human-readable fields without ever
-- querying the auth schema. Populated by the on_auth_user_created trigger.
create table if not exists public.profiles (
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
create unique index if not exists profiles_email_lower_key
  on public.profiles (lower(email));
-- private.is_admin() runs on every directory write; this keeps it an index
-- lookup rather than a scan once the profile table grows.
create index if not exists profiles_admin_idx
  on public.profiles (id) where role = 'admin';

comment on table public.profiles is
  'Astra users. Created automatically when someone signs up via Supabase Auth.';

-- ---------------------------------------------------------------------------
-- 2.2  employees — the company resource pool
-- ---------------------------------------------------------------------------
-- The cross-walk table that makes context aggregation possible: one real human,
-- and the handle they carry in each third-party system. Every row here can be
-- pulled into any number of teams.
create table if not exists public.employees (
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

create unique index if not exists employees_email_lower_key
  on public.employees (lower(email));
create index if not exists employees_profile_id_idx on public.employees (profile_id);
create index if not exists employees_created_by_idx on public.employees (created_by);
-- The context engine looks people up by handle when folding GitHub results back
-- onto real names.
create index if not exists employees_github_username_idx
  on public.employees (lower(github_username)) where github_username is not null;

comment on column public.employees.jira_account_id is
  'Jira Cloud accountId (the id returned by /rest/api/3/myself), not a display name.';
comment on column public.employees.slack_user_id is
  'Slack member ID, e.g. U01ABCDEF. Profile -> More -> Copy member ID.';

-- ---------------------------------------------------------------------------
-- 2.3  teams
-- ---------------------------------------------------------------------------
-- `description` travels further than any other column here: it is rendered into
-- the pre-context Markdown, sent in the summon payload, and put on its own line
-- in the model's prompt. It is editable in the dashboard on the team page.
create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  description text check (length(description) <= 2000),
  -- on delete restrict: a team must never be orphaned. Hand it over first.
  leader_id   uuid not null references public.profiles (id) on delete restrict,
  sprint_name text check (length(sprint_name) <= 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists teams_leader_id_idx on public.teams (leader_id);

-- ---------------------------------------------------------------------------
-- 2.4  team_members — a resource-pool employee, and the sprint role they play
-- ---------------------------------------------------------------------------
create table if not exists public.team_members (
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
create index if not exists team_members_employee_id_idx
  on public.team_members (employee_id);

-- ---------------------------------------------------------------------------
-- 2.5  team_integrations — per-team third-party credentials
-- ---------------------------------------------------------------------------
-- One row per team, all fields optional: a team with only GitHub configured
-- still generates a valid (smaller) pre-context payload.
--
-- SECURITY: every *_token column holds AES-256-GCM ciphertext produced by
-- src/lib/crypto.ts, never a plaintext secret. The key lives in
-- ASTRA_ENCRYPTION_KEY on the server and never reaches the browser, so a leaked
-- database dump does not leak the tokens. RLS additionally restricts this table
-- to the team leader.
create table if not exists public.team_integrations (
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
-- 2.6  pre_context_runs — an audit log of every "Generate Pre-Context" click
-- ---------------------------------------------------------------------------
-- The payload is the exact JSON handed to the bot container, so a meeting can
-- always be replayed against the context the bot actually had.
create table if not exists public.pre_context_runs (
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
create index if not exists pre_context_runs_team_created_idx
  on public.pre_context_runs (team_id, created_at desc);
create index if not exists pre_context_runs_generated_by_idx
  on public.pre_context_runs (generated_by);

-- ---------------------------------------------------------------------------
-- 2.7  bot_credentials — status of each Team Leader's Google bot session
-- ---------------------------------------------------------------------------
-- NOT the credential. The Google session lives in an auth.json on the leader's
-- own machine (bot-auth/secrets/leaders/{user_id}/auth.json), and in Phase 2 it
-- moves to Supabase Storage under leaders/{user_id}/auth.json. No cookie or
-- token is ever written here.
--
-- This is the *status*, and it exists because status has to be visible to
-- people who are not standing at that machine: a team member opening a team
-- page needs to know whether the leader's bot can join the meeting, and the
-- file that answers that is on somebody else's laptop.
--
-- One row per leader, not per team: one bot account covers every team a leader
-- leads, which is why this is keyed on the user.
create table if not exists public.bot_credentials (
  user_id      uuid primary key references public.profiles (id) on delete cascade,

  status       text not null default 'none'
               check (status in ('none', 'authenticated', 'expired', 'revoked')),

  -- Which Google account was signed in, so a leader who authenticated the wrong
  -- one (their personal address, say) can see that at a glance.
  google_email text check (length(google_email) <= 254),

  cookie_count integer check (cookie_count >= 0),
  -- The earliest expiry among the Google auth cookies: when the bot goes stale.
  expires_at   timestamptz,

  -- Phase 1: a path on the leader's own filesystem.
  -- Phase 2: the Supabase Storage key, `leaders/{user_id}/auth.json`.
  storage_path text check (length(storage_path) <= 1024),

  last_error   text,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists bot_credentials_status_idx
  on public.bot_credentials (status);

comment on table public.bot_credentials is
  'Status of each Team Leader''s Google bot session. Never the session itself.';

-- ---------------------------------------------------------------------------
-- 2.8  meetings — one row per bot session in a Google Meet
-- ---------------------------------------------------------------------------
-- Written by BOT-CONTAINER, not by the dashboard.
--
-- A note on naming: the bot-container spec calls the team's label column
-- `team_name`; this schema has always called it `teams.name`. They are the same
-- column and it is not renamed here — the dashboard, the RLS policies and the
-- TypeScript types all read `name`, and renaming a column out from under a
-- running application to match a document is not a trade worth making. The view
-- in section 7 exposes the spec's spelling for anything that wants it.
create table if not exists public.meetings (
  id            uuid primary key default gen_random_uuid(),

  -- Nullable on purpose. The container will happily record a meeting for a
  -- workspace id that is not one of Astra's teams (a scratch id, a team created
  -- after the bot was summoned). The alternative -- inventing a `teams` row --
  -- is worse: that table needs a `leader_id` pointing at a real profile, so the
  -- fiction would surface on somebody's dashboard as a team they lead.
  team_id       uuid references public.teams (id) on delete set null,

  -- The raw `team_id` string from the summon payload, always present, even when
  -- it resolved to nothing. This is what `meeting_number` is sequenced against.
  team_ref      text not null check (length(team_ref) between 1 and 200),

  -- Per-team counter: "meeting #7 for Astra_dev". Assigned by the trigger in
  -- section 5, never by the application -- see the comment there.
  meeting_number integer not null,

  meet_link     text not null check (length(meet_link) <= 500),

  -- The bot session that produced this row, so a log line and a database row
  -- can be tied together without guessing from timestamps.
  session_id    uuid,

  -- Must list every value src/session.js can set, including the two that exist
  -- before the browser does ('queued', 'launching'). A session status the check
  -- rejects does not fail the meeting -- the write is fire-and-forget -- it just
  -- silently stops the dashboard ever seeing that state.
  status        text not null default 'queued'
                check (status in ('queued','launching','joining','waiting_admission',
                                  'in_call','leaving','ended','failed')),

  google_account text check (length(google_account) <= 254),

  -- Written on the way out, from the in-memory Q&A window.
  summary       text check (length(summary) <= 8000),
  error         text,

  transcript_lines   integer not null default 0 check (transcript_lines >= 0),
  questions_answered integer not null default 0 check (questions_answered >= 0),

  joined_at     timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.meetings is
  'One row per Astra bot session in a Google Meet. Written by BOT-CONTAINER.';
comment on column public.meetings.team_ref is
  'The raw team_id from the summon payload, kept even when it matches no team.';

create index if not exists meetings_team_id_idx    on public.meetings (team_id);
create index if not exists meetings_team_ref_idx   on public.meetings (team_ref);
create index if not exists meetings_created_at_idx on public.meetings (created_at desc);
create index if not exists meetings_session_id_idx on public.meetings (session_id);

-- One number per team, and no gaps caused by two bots racing.
create unique index if not exists meetings_team_ref_number_key
  on public.meetings (team_ref, meeting_number);

-- ---------------------------------------------------------------------------
-- 2.9  transcripts — one row per finalised caption line
-- ---------------------------------------------------------------------------
create table if not exists public.transcripts (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings (id) on delete cascade,

  speaker_name text not null default 'Unknown' check (length(speaker_name) <= 120),
  content      text not null check (length(content) between 1 and 8000),

  -- What this line is. Keeping the bot's own questions and answers in the same
  -- table as the speech is what makes the transcript readable end to end: a
  -- record that shows a question and then jumps to the next speaker, with no
  -- answer, reads as if the bot ignored someone.
  kind         text not null default 'speech'
               check (kind in ('speech','question','answer','system')),

  -- The browser's own clock, from the caption block. `created_at` is when the
  -- row reached Postgres, which is later and, under load, differently ordered.
  -- Order a transcript by `spoken_at`.
  spoken_at    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

comment on table public.transcripts is
  'Finalised Google Meet caption lines, plus the bot''s own questions and answers.';
comment on column public.transcripts.spoken_at is
  'Browser-side timestamp of the caption block. Order by this, not created_at.';

create index if not exists transcripts_meeting_idx
  on public.transcripts (meeting_id, spoken_at);
create index if not exists transcripts_kind_idx
  on public.transcripts (meeting_id, kind);


-- ===========================================================================
-- 3. Reconciliation, for databases built before some of the above existed
-- ===========================================================================
-- `create table if not exists` is a no-op on a table that already exists, so a
-- project set up months ago keeps whatever shape it had. These are the columns
-- and constraints that have actually changed over the life of this project;
-- each is safe to run on a database that already has them.

-- profiles.role arrived with add-roles.sql. Without it, every directory write
-- fails a policy that references a column that is not there.
alter table public.profiles
  add column if not exists role text not null default 'user';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'profiles_role_check' and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_role_check check (role in ('user', 'admin'));
  end if;
end;
$$;

-- The meetings status list gained 'queued' and 'launching' after the first
-- version of the bot container shipped. An old, narrower check would silently
-- reject those two states forever, so it is replaced rather than added to.
do $$
begin
  if exists (select 1 from pg_class where relname = 'meetings' and relnamespace = 'public'::regnamespace) then
    alter table public.meetings drop constraint if exists meetings_status_check;
    alter table public.meetings add  constraint meetings_status_check
      check (status in ('queued','launching','joining','waiting_admission',
                        'in_call','leaving','ended','failed'));
  end if;
end;
$$;


-- ===========================================================================
-- 4. Functions
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
  -- the statement in appendix C.
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

-- --- meeting_number: assigned in the database, under a lock -----------------
-- Computing `max(meeting_number) + 1` in the application is a race: two bots
-- summoned for the same team in the same second both read the same maximum and
-- both try to insert the same number. Doing it in a BEFORE INSERT trigger with
-- a transaction-scoped advisory lock keyed on the team serialises exactly the
-- inserts that could collide, and nothing else.
create or replace function public.assign_meeting_number()
returns trigger
language plpgsql
as $fn$
begin
  if new.meeting_number is not null and new.meeting_number > 0 then
    return new;                        -- caller supplied one deliberately
  end if;

  -- Released automatically at the end of the transaction; no cleanup path to
  -- get wrong, and no lock left behind if the insert fails.
  perform pg_advisory_xact_lock(hashtext('astra_meeting_number:' || new.team_ref));

  select coalesce(max(m.meeting_number), 0) + 1
    into new.meeting_number
    from public.meetings m
   where m.team_ref = new.team_ref;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- RLS helper functions
-- ---------------------------------------------------------------------------
-- All three are SECURITY DEFINER so they can read the tables they need without
-- recursing into those tables' own policies, and all three hard-code
-- (select auth.uid()) inside the body — so they can only ever answer a question
-- about the *calling* user. Passing someone else's team id tells you nothing
-- you were not already allowed to know.

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

-- A cast that cannot raise.
--
-- `meetings.team_ref` is text and usually holds a team uuid, but it is
-- deliberately allowed to hold anything the summon payload sent. A policy that
-- wrote `team_ref::uuid` would therefore throw 22P02 on the first scratch id
-- somebody used -- and it would throw while *evaluating a policy*, which means
-- the error surfaces on an unrelated query against a row the caller was never
-- going to be shown. Postgres gives no ordering guarantee that would let a
-- regex guard in the same AND protect the cast, so the guard has to live inside
-- a function.
create or replace function private.safe_uuid(p_text text)
returns uuid
language plpgsql
immutable
returns null on null input
as $fn$
begin
  return p_text::uuid;
exception when others then
  return null;
end;
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
  -- Null in, false out: private.safe_uuid() returns null for a team_ref that is
  -- not a uuid, and a null here must mean "shows nothing", never "shows all".
  select p_team_id is not null and exists (
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
revoke execute on function private.safe_uuid(text)     from public, anon;
revoke execute on function private.is_admin()           from public, anon;
revoke execute on function private.is_team_leader(uuid) from public, anon;
revoke execute on function private.is_team_member(uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.safe_uuid(text)     to authenticated;
grant execute on function private.is_admin()           to authenticated;
grant execute on function private.is_team_leader(uuid) to authenticated;
grant execute on function private.is_team_member(uuid) to authenticated;


-- ===========================================================================
-- 5. Triggers
-- ===========================================================================
-- Postgres has no `create trigger if not exists`, so each is dropped by name
-- first. That is what makes this file safe to re-run.

drop trigger if exists profiles_touch_updated_at          on public.profiles;
drop trigger if exists employees_touch_updated_at         on public.employees;
drop trigger if exists teams_touch_updated_at             on public.teams;
drop trigger if exists team_integrations_touch_updated_at on public.team_integrations;
drop trigger if exists bot_credentials_touch_updated_at   on public.bot_credentials;
drop trigger if exists meetings_touch_updated_at          on public.meetings;
drop trigger if exists employees_link_profile             on public.employees;
drop trigger if exists teams_register_leader              on public.teams;
drop trigger if exists meetings_assign_number             on public.meetings;
drop trigger if exists on_auth_user_created               on auth.users;

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
create trigger bot_credentials_touch_updated_at
  before update on public.bot_credentials
  for each row execute function public.touch_updated_at();
create trigger meetings_touch_updated_at
  before update on public.meetings
  for each row execute function public.touch_updated_at();

create trigger employees_link_profile
  before insert or update of email on public.employees
  for each row execute function public.link_employee_profile();

create trigger teams_register_leader
  after insert on public.teams
  for each row execute function public.register_team_leader();

create trigger meetings_assign_number
  before insert on public.meetings
  for each row execute function public.assign_meeting_number();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ===========================================================================
-- 6. Row Level Security
-- ===========================================================================
-- Every policy wraps auth.uid() in a scalar subquery — (select auth.uid()) — so
-- Postgres evaluates it once per statement instead of once per row.

alter table public.profiles          enable row level security;
alter table public.employees         enable row level security;
alter table public.teams             enable row level security;
alter table public.team_members      enable row level security;
alter table public.team_integrations enable row level security;
alter table public.pre_context_runs  enable row level security;
alter table public.bot_credentials   enable row level security;
alter table public.meetings          enable row level security;
alter table public.transcripts       enable row level security;

-- Dropped by name so this file can be re-run. Names that only ever existed in
-- older versions are listed too, so an upgrade removes them rather than leaving
-- a stale, more permissive policy in place beside the new one.
drop policy if exists profiles_select_authenticated        on public.profiles;
drop policy if exists profiles_insert_self                 on public.profiles;
drop policy if exists profiles_update_self                 on public.profiles;
drop policy if exists employees_select_authenticated       on public.employees;
drop policy if exists employees_insert_admin               on public.employees;
drop policy if exists employees_update_admin               on public.employees;
drop policy if exists employees_delete_admin               on public.employees;
drop policy if exists employees_insert_authenticated       on public.employees;  -- pre-roles
drop policy if exists employees_update_authenticated       on public.employees;  -- pre-roles
drop policy if exists employees_delete_own                 on public.employees;  -- pre-roles
drop policy if exists teams_select_visible                 on public.teams;
drop policy if exists teams_insert_as_leader               on public.teams;
drop policy if exists teams_update_leader                  on public.teams;
drop policy if exists teams_delete_leader                  on public.teams;
drop policy if exists team_members_select_visible          on public.team_members;
drop policy if exists team_members_insert_leader           on public.team_members;
drop policy if exists team_members_update_leader           on public.team_members;
drop policy if exists team_members_delete_leader           on public.team_members;
drop policy if exists team_integrations_all_leader         on public.team_integrations;
drop policy if exists pre_context_runs_select_members      on public.pre_context_runs;
drop policy if exists pre_context_runs_insert_leader       on public.pre_context_runs;
drop policy if exists bot_credentials_select_authenticated on public.bot_credentials;
drop policy if exists bot_credentials_insert_self          on public.bot_credentials;
drop policy if exists bot_credentials_update_self          on public.bot_credentials;
drop policy if exists bot_credentials_delete_self          on public.bot_credentials;
drop policy if exists meetings_select_members              on public.meetings;
drop policy if exists transcripts_select_members           on public.transcripts;

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

-- --- bot_credentials --------------------------------------------------------
-- Readable by any signed-in user: this row is metadata about a bot account -- a
-- status, a timestamp, and the bot's own email address -- and a team member has
-- to be able to see whether their leader's bot is ready *before* the standup.
create policy bot_credentials_select_authenticated on public.bot_credentials
  for select to authenticated using (true);

-- Only you can claim or change your own. A leader cannot mark someone else's
-- bot authenticated, which would be a way to make a team look ready when it is
-- not.
create policy bot_credentials_insert_self on public.bot_credentials
  for insert to authenticated with check (user_id = (select auth.uid()));

create policy bot_credentials_update_self on public.bot_credentials
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy bot_credentials_delete_self on public.bot_credentials
  for delete to authenticated using (user_id = (select auth.uid()));

-- --- meetings and transcripts -----------------------------------------------
-- The container writes these with the service role key, which bypasses RLS
-- entirely. These policies exist for the DASHBOARD: a team member opening a
-- past meeting reads these tables as themselves, and without policies they
-- would see nothing at all.
create policy meetings_select_members on public.meetings
  for select to authenticated
  using (
    -- The normal case: the container resolved the team and linked the row.
    (
      team_id is not null
      and ((select private.is_team_member(team_id)) or (select private.is_team_leader(team_id)))
    )
    -- And the case that would otherwise vanish. `team_id` is null whenever the
    -- lookup failed at summon time -- a slow database, a team created seconds
    -- earlier -- while `team_ref` still holds the id the extension sent. Judging
    -- only on `team_id` would make a meeting recorded during a thirty-second
    -- database blip invisible to its own team permanently, with a full
    -- transcript sitting in the row.
    or (
      team_id is null
      and (select private.is_team_member(private.safe_uuid(team_ref)))
    )
  );

-- A transcript is visible exactly when its meeting is — and that has to mean
-- the meeting is visible TO THIS CALLER, not merely that it exists. `exists
-- (select 1 from meetings ...)` inside a policy is evaluated with the caller's
-- own privileges, so meetings' policy does apply and the subquery returns
-- nothing for a meeting they cannot see. Spelling that out because it looks
-- like a hole and is not one; re-stating the team check here would be a second
-- place to get it wrong.
create policy transcripts_select_members on public.transcripts
  for select to authenticated
  using (exists (select 1 from public.meetings m where m.id = transcripts.meeting_id));


-- ===========================================================================
-- 7. Views
-- ===========================================================================
-- The bot-container spec's `team_name` spelling, for anything that wants the
-- hierarchy flattened. `teams.name` remains the real column.
create or replace view public.meeting_transcripts as
  select
    t.id                as team_id,
    t.name              as team_name,
    m.id                as meeting_id,
    m.meeting_number,
    m.meet_link,
    m.summary,
    m.status,
    m.joined_at,
    m.ended_at,
    tr.id               as transcript_id,
    tr.speaker_name,
    tr.content,
    tr.kind,
    tr.spoken_at,
    tr.created_at
  from public.meetings m
  left join public.teams t        on t.id = m.team_id
  left join public.transcripts tr on tr.meeting_id = m.id;

comment on view public.meeting_transcripts is
  'Flattened teams -> meetings -> transcripts, with the spec''s team_name spelling.';


-- ===========================================================================
-- 8. Grants  (PostgREST checks table privileges BEFORE RLS is ever consulted)
-- ===========================================================================
-- PostgREST resolves the API key to a Postgres role and runs the query as that
-- role, so a missing GRANT fails with "permission denied for schema public"
-- long before any policy is considered. Three roles need naming:
--
--   anon           the publishable/anon key, signed-out visitors
--   authenticated  the publishable/anon key once a session exists — the app
--   service_role   the secret/service_role key — the pre-context engine and
--                  BOT-CONTAINER
--
-- service_role matters even though it bypasses RLS: bypassing row *policies* is
-- not the same as holding table *privileges*.
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete
  on public.profiles, public.employees, public.teams,
     public.team_members, public.team_integrations, public.pre_context_runs,
     public.bot_credentials
  to authenticated;

-- Read-only for the dashboard: meetings and transcripts are written by the
-- container alone, and nothing in the app has any business editing a
-- transcript after the fact.
grant select on public.meetings            to authenticated;
grant select on public.transcripts         to authenticated;
grant select on public.meeting_transcripts to authenticated, service_role;

grant all privileges
  on public.profiles, public.employees, public.teams,
     public.team_members, public.team_integrations, public.pre_context_runs,
     public.bot_credentials, public.meetings, public.transcripts
  to service_role;

-- Sequences: none of the tables use one today (every key is a uuid), but a
-- future `generated always as identity` column would fail for these roles
-- without this, in a way that is tedious to diagnose.
grant usage, select on all sequences in schema public to authenticated, service_role;


-- ===========================================================================
-- 9. Tell PostgREST, and check the result
-- ===========================================================================
-- PostgREST caches the schema and does not notice a CREATE TABLE on its own.
-- Until it reloads, every request for a new table fails with
--   PGRST205: Could not find the table 'public.x' in the schema cache
-- which looks exactly like the migration never ran. This makes the file
-- self-sufficient; the dashboard button (Settings -> API -> Reload schema
-- cache) does the same thing.
notify pgrst, 'reload schema';

-- Nine tables, one view. If a row is missing here, something above failed.
select
  c.relname                                              as object,
  case c.relkind when 'r' then 'table' else 'view' end   as kind,
  c.relrowsecurity                                       as rls,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relname in (
    'profiles','employees','teams','team_members','team_integrations',
    'pre_context_runs','bot_credentials','meetings','transcripts',
    'meeting_transcripts'
  )
order by c.relkind desc, c.relname;


-- ===========================================================================
--   APPENDIX A — clean slate  (DESTRUCTIVE, commented out on purpose)
-- ===========================================================================
-- Uncomment and run ONLY when you want every Astra object and every row it
-- holds gone: teams, rosters, integration credentials, meeting transcripts,
-- the lot. There is no undo, and `cascade` means the damage reaches further
-- than the list suggests.
--
-- Then run this whole file again to rebuild.
--
-- drop trigger if exists on_auth_user_created on auth.users;
--
-- drop view  if exists public.meeting_transcripts;
-- drop table if exists public.transcripts       cascade;
-- drop table if exists public.meetings          cascade;
-- drop table if exists public.bot_credentials   cascade;
-- drop table if exists public.pre_context_runs  cascade;
-- drop table if exists public.team_integrations cascade;
-- drop table if exists public.team_members      cascade;
-- drop table if exists public.teams             cascade;
-- drop table if exists public.employees         cascade;
-- drop table if exists public.profiles          cascade;
--
-- drop function if exists public.handle_new_user()       cascade;
-- drop function if exists public.link_employee_profile() cascade;
-- drop function if exists public.register_team_leader()  cascade;
-- drop function if exists public.assign_meeting_number() cascade;
-- drop function if exists public.touch_updated_at()      cascade;
-- drop function if exists private.is_admin()             cascade;
-- drop function if exists private.is_team_leader(uuid)   cascade;
-- drop function if exists private.is_team_member(uuid)   cascade;


-- ===========================================================================
--   APPENDIX B — seed data  (optional, commented out on purpose)
-- ===========================================================================
-- From astra-platform/supabase/seed.sql. Run it only AFTER you have signed up
-- in the app at least once — the demo team needs a real auth user to lead it.
--
-- REPLACE 'you@example.com' BELOW with the email you signed up with. It is a
-- literal rather than a psql variable because the Supabase SQL Editor is not
-- psql and would reject a backslash command.
--
-- The GitHub and Jira handles are fictional. Replace them with real ones before
-- generating pre-context: those lookups filter on exactly these strings, and
-- invented handles produce a confident, empty result.
--
-- insert into public.employees
--   (full_name, email, title, github_username, jira_account_id, slack_user_id, created_by)
-- values
--   ('Ada Lovelace',     'ada@astra.dev',      'Principal Engineer', 'adalovelace', '5b10a2844c20165700ede21g', 'U01ADA0001', null),
--   ('Grace Hopper',     'grace@astra.dev',    'Tech Lead',          'gracehopper', '5b10a2844c20165700ede21h', 'U01GRC0002', null),
--   ('Alan Turing',      'alan@astra.dev',     'Backend Engineer',   'alanturing',  '5b10a2844c20165700ede21i', 'U01ALN0003', null),
--   ('Katherine Johnson','kat@astra.dev',      'Frontend Engineer',  'katjohnson',  '5b10a2844c20165700ede21j', 'U01KAT0004', null),
--   ('Linus Torvalds',   'linus@astra.dev',    'Platform / SRE',     'torvalds',    '5b10a2844c20165700ede21k', 'U01LIN0005', null),
--   ('Margaret Hamilton','margaret@astra.dev', 'QA Lead',            'mhamilton',   '5b10a2844c20165700ede21l', 'U01MAR0006', null),
--   ('Barbara Liskov',   'barbara@astra.dev',  'Product Manager',    null,          '5b10a2844c20165700ede21m', 'U01BAR0007', null),
--   ('Radia Perlman',    'radia@astra.dev',    'Designer',           null,          null,                       'U01RAD0008', null)
-- on conflict do nothing;
--
-- insert into public.teams (name, description, leader_id, sprint_name)
-- select
--   'Platform Squad',
--   'Owns the ingestion pipeline and the public API.',
--   p.id,
--   'Sprint 24'
-- from public.profiles p
-- where lower(p.email) = lower('you@example.com')
-- on conflict do nothing;


-- ===========================================================================
--   APPENDIX C — administering roles
-- ===========================================================================
-- The first account to sign up is made an admin automatically (see
-- handle_new_user in section 4). To promote or demote anyone else:
--
--   update public.profiles set role = 'admin' where lower(email) = 'someone@company.com';
--   update public.profiles set role = 'user'  where lower(email) = 'someone@company.com';
--
-- To see who currently holds it:
--
--   select email, role, created_at from public.profiles order by role, email;
--
-- There is deliberately no UI for this. Granting the ability to edit the
-- cross-walk is the one action in Astra that changes what every team's bot is
-- told, so it is a decision someone makes at the database, on purpose.
-- ===========================================================================

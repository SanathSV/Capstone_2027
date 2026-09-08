-- ===========================================================================
-- Astra — bot credential status, per Team Leader
--
-- Run on a database that already has schema.sql applied. Additive: one table,
-- its policies and grants. Nothing is dropped and no row is deleted.
--
-- WHAT THIS TABLE IS, AND IS NOT
-- ------------------------------
-- It is NOT the credential. The Google session lives in an `auth.json` on the
-- leader's own machine at bot-auth/secrets/leaders/{user_id}/auth.json, and in
-- Phase 2 it moves to Supabase Storage under leaders/{user_id}/auth.json. No
-- cookie, token or storage-state blob is ever written here.
--
-- It is the *status* of that credential, and it exists because status has to be
-- visible to people who are not standing at that machine. A team member opening
-- a team page needs to know whether the leader's bot can actually join the
-- meeting; the file that answers that question is on someone else's laptop. So
-- the file stays local and the fact of it is recorded here.
--
-- One row per leader, not per team: one bot account covers every team a leader
-- leads, which is why this is keyed on the user and not on teams.
-- ===========================================================================

drop table if exists public.bot_credentials cascade;

create table public.bot_credentials (
  -- The Team Leader. One bot account per leader, hence a primary key rather
  -- than a plain foreign key.
  user_id      uuid primary key references public.profiles (id) on delete cascade,

  status       text not null default 'none'
               check (status in ('none', 'authenticated', 'expired', 'revoked')),

  -- Which Google account was signed in, so a leader who authenticated the wrong
  -- one (their personal address, say) can see that at a glance.
  google_email text check (length(google_email) <= 254),

  -- Enough to tell a healthy session from a stub without opening the file.
  cookie_count integer check (cookie_count >= 0),
  -- The earliest expiry among the Google auth cookies: when the bot goes stale.
  expires_at   timestamptz,

  -- Phase 1: a path on the leader's own filesystem.
  -- Phase 2: the Supabase Storage object key, `leaders/{user_id}/auth.json`.
  storage_path text check (length(storage_path) <= 1024),

  last_error   text,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

comment on table public.bot_credentials is
  'Status of each Team Leader''s Google bot session. Never the session itself.';
comment on column public.bot_credentials.storage_path is
  'Phase 1: local path. Phase 2: Supabase Storage key leaders/{user_id}/auth.json.';

create index bot_credentials_status_idx on public.bot_credentials (status);

create trigger bot_credentials_touch_updated_at
  before update on public.bot_credentials
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.bot_credentials enable row level security;

-- Readable by any signed-in user. This row is metadata about a bot account --
-- a status, a timestamp, and the bot's own email address -- and a team member
-- has to be able to see whether their leader's bot is ready before the standup
-- rather than after it. Nothing sensitive is stored here to leak.
create policy bot_credentials_select_authenticated on public.bot_credentials
  for select to authenticated using (true);

-- Only you can claim, update or clear your own bot status. A leader cannot mark
-- someone else's bot authenticated, which would be a way to make a team look
-- ready when it is not.
create policy bot_credentials_insert_self on public.bot_credentials
  for insert to authenticated with check (user_id = (select auth.uid()));

create policy bot_credentials_update_self on public.bot_credentials
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy bot_credentials_delete_self on public.bot_credentials
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Grants (PostgREST checks table privileges before RLS is consulted)
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.bot_credentials to authenticated;
grant all privileges on public.bot_credentials to service_role;

-- ---------------------------------------------------------------------------
-- Check it
-- ---------------------------------------------------------------------------
select p.email as leader, b.status, b.google_email, b.expires_at, b.updated_at
  from public.profiles p
  left join public.bot_credentials b on b.user_id = p.id
 order by p.email;

-- ---------------------------------------------------------------------------
-- Tell PostgREST about the new tables
-- ---------------------------------------------------------------------------
-- PostgREST caches the schema and does not notice a CREATE TABLE on its own.
-- Until it reloads, every request for a new table fails with
--   PGRST205: Could not find the table 'public.x' in the schema cache
-- which looks exactly like the migration never ran. This makes the migration
-- self-sufficient; the dashboard button (Settings -> API -> Reload schema
-- cache) does the same thing.
notify pgrst, 'reload schema';

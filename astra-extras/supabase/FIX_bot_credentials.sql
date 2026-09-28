-- ===========================================================================
-- FIX: "Could not find the table 'public.bot_credentials' in the schema cache"
--
-- Paste this whole file into the Supabase SQL Editor and run it. That is the
-- entire fix.
--
-- It is idempotent and non-destructive: `create table if not exists`, policies
-- dropped and recreated, no data touched. Safe on a live database, safe to run
-- twice.
--
-- WHY THE ERROR HAPPENS
-- ---------------------
-- Two different causes produce the same message, which is what makes it
-- confusing:
--
--   1. The table really is missing. `schema.sql` drops `profiles ... cascade`,
--      and bot_credentials references profiles(id) -- so every re-run of
--      schema.sql took this table with it. (schema.sql now creates it, so that
--      is fixed going forward.)
--
--   2. The table exists, but PostgREST has not noticed. It caches the schema at
--      boot and does not watch for DDL, so a freshly created table is invisible
--      to the API until the cache reloads -- which looks exactly like the
--      migration never ran.
--
-- The last line handles case 2; everything above handles case 1.
-- ===========================================================================

create table if not exists public.bot_credentials (
  user_id      uuid primary key references public.profiles (id) on delete cascade,

  status       text not null default 'none'
               check (status in ('none', 'authenticated', 'expired', 'revoked')),

  google_email text check (length(google_email) <= 254),
  cookie_count integer check (cookie_count >= 0),
  expires_at   timestamptz,

  -- Phase 1: a path on the leader's machine.
  -- Phase 2: the Supabase Storage key, leaders/{user_id}/auth.json.
  storage_path text check (length(storage_path) <= 1024),

  last_error   text,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists bot_credentials_status_idx
  on public.bot_credentials (status);

-- The trigger only exists if touch_updated_at() does; guard so this file can be
-- run on its own.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'touch_updated_at')
     and not exists (
       select 1 from pg_trigger where tgname = 'bot_credentials_touch_updated_at'
     )
  then
    create trigger bot_credentials_touch_updated_at
      before update on public.bot_credentials
      for each row execute function public.touch_updated_at();
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.bot_credentials enable row level security;

drop policy if exists bot_credentials_select_authenticated on public.bot_credentials;
drop policy if exists bot_credentials_insert_self          on public.bot_credentials;
drop policy if exists bot_credentials_update_self          on public.bot_credentials;
drop policy if exists bot_credentials_delete_self          on public.bot_credentials;

-- Readable by any signed-in user: a team member has to see whether the leader's
-- bot is ready *before* the standup. Only a status, a timestamp and the bot's
-- own email address are stored here -- never a cookie.
create policy bot_credentials_select_authenticated on public.bot_credentials
  for select to authenticated using (true);

-- Only you can claim or change your own, so nobody can make a team look ready
-- when it is not.
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
-- Confirm, then tell PostgREST
-- ---------------------------------------------------------------------------
select
  'bot_credentials exists' as check,
  count(*)                 as rows
from public.bot_credentials;

-- THE LINE THAT ACTUALLY CLEARS THE ERROR.
-- Same effect as Dashboard -> Settings -> API -> "Reload schema cache".
-- Give it a few seconds to take, then reload the Astra Settings page.
notify pgrst, 'reload schema';

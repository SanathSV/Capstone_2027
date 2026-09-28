-- ===========================================================================
-- Astra — add the [ user/admin ] role model
--
-- Run this on a database that already has schema.sql applied. It is additive:
-- it adds one column, one helper and three policies. No table is dropped and no
-- row is deleted, so your teams, directory and run history all survive.
--
-- After it: only admins can add, edit or remove people in the resource pool.
-- Everyone can still read it, lead teams, and generate pre-context.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists role text not null default 'user';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_check'
  ) then
    alter table public.profiles
      add constraint profiles_role_check check (role in ('user', 'admin'));
  end if;
end;
$$;

create index if not exists profiles_admin_idx
  on public.profiles (id) where role = 'admin';

comment on column public.profiles.role is
  'user = read the directory; admin = manage it. Promote with the UPDATE at the bottom of this file.';

-- ---------------------------------------------------------------------------
-- 2. Promote the first account, so the directory is not left unmanageable
-- ---------------------------------------------------------------------------
-- Skipped entirely if you already have an admin.
do $$
declare
  v_email text;
begin
  if exists (select 1 from public.profiles where role = 'admin') then
    raise notice 'An admin already exists; leaving roles alone.';
    return;
  end if;

  update public.profiles
     set role = 'admin'
   where id = (select id from public.profiles order by created_at asc limit 1)
  returning email into v_email;

  if v_email is null then
    raise notice 'No profiles yet. The first person to sign up becomes the admin.';
  else
    raise notice 'Promoted % to admin.', v_email;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. New signups: first one in is the admin, everyone after is a user
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_role text;
begin
  -- Bootstrapping: without this an empty project has no admin and therefore no
  -- way to populate the resource pool at all.
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

-- ---------------------------------------------------------------------------
-- 4. The helper
-- ---------------------------------------------------------------------------
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

revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The policies
-- ---------------------------------------------------------------------------
-- Enforced in the database, not only in the UI: hiding a button prevents the
-- honest mistake, a policy prevents a hand-written fetch() from the console.
drop policy if exists employees_insert_authenticated on public.employees;
drop policy if exists employees_update_authenticated on public.employees;
drop policy if exists employees_delete_own           on public.employees;

create policy employees_insert_admin on public.employees
  for insert to authenticated
  with check (
    (select private.is_admin())
    and created_by = (select auth.uid())
  );

-- A directory nobody may add to but anybody may rewrite is not controlled:
-- changing a GitHub handle silently redirects whose commits appear in a team's
-- pre-context.
create policy employees_update_admin on public.employees
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

create policy employees_delete_admin on public.employees
  for delete to authenticated using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- 6. Check it, and promote anyone else you need
-- ---------------------------------------------------------------------------
select email, role, created_at from public.profiles order by role, email;

--   update public.profiles set role = 'admin' where lower(email) = 'someone@company.com';
--   update public.profiles set role = 'user'  where lower(email) = 'someone@company.com';

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

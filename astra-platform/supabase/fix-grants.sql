-- ===========================================================================
-- Astra — grant patch
--
-- Run this if "Generate Pre-Context" fails with:
--     permission denied for schema public
--
-- Cause: the pre-context engine is the only part of Astra that uses the
-- service_role key, and an earlier version of schema.sql granted privileges to
-- `anon` and `authenticated` but not to `service_role`. Everything else in the
-- app therefore worked and only that one button failed.
--
-- Safe to run on a live database: it only adds privileges. No data is touched,
-- nothing is dropped. Re-running it is a no-op.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Diagnose — what can each role actually do right now?
-- ---------------------------------------------------------------------------
select
  r.rolname                                                        as role,
  has_schema_privilege(r.rolname, 'public', 'USAGE')               as usage_on_public,
  has_table_privilege(r.rolname, 'public.team_integrations', 'SELECT') as can_read_integrations,
  has_table_privilege(r.rolname, 'public.pre_context_runs', 'INSERT')  as can_log_runs
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

-- Expect, after the fix below:
--   anon           usage=t  read=f  log=f      (RLS also blocks it; that is fine)
--   authenticated  usage=t  read=t  log=t      (RLS then narrows it per team)
--   service_role   usage=t  read=t  log=t

-- ---------------------------------------------------------------------------
-- 2. Fix
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete
  on public.profiles, public.employees, public.teams,
     public.team_members, public.team_integrations, public.pre_context_runs
  to authenticated;

grant all privileges
  on public.profiles, public.employees, public.teams,
     public.team_members, public.team_integrations, public.pre_context_runs
  to service_role;

grant usage, select on all sequences in schema public to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Re-run the query in section 1 to confirm.
-- ---------------------------------------------------------------------------

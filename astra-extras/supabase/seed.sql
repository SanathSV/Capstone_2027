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

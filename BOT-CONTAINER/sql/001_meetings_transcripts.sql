-- ===========================================================================
-- Astra BOT-CONTAINER — meetings and transcripts
--
-- Paste this whole file into the Supabase SQL Editor and run it. Idempotent
-- and non-destructive: `create table if not exists`, policies dropped and
-- recreated, no existing row touched. Safe on the live Astra database.
--
-- THE HIERARCHY
-- -------------
--     teams (id, name)          <- already exists; astra-platform owns it
--       └── meetings            <- one row per bot session
--             └── transcripts   <- one row per finalised caption line
--
-- A note on `teams`: the spec calls its label column `team_name`; the live
-- table calls it `name`. They are the same column and this migration does not
-- rename it — astra-platform's dashboard, RLS policies and TypeScript types all
-- read `name`, and renaming a column out from under a running application to
-- match a document is not a trade worth making. A view is provided at the
-- bottom for anyone who wants the spec's spelling.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- meetings
-- ---------------------------------------------------------------------------
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

  -- Per-team counter: "meeting #7 for Astra_dev". Assigned by the trigger
  -- below, never by the application -- see the comment there.
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

-- Widen the constraint on a database that ran an earlier version of this file.
-- `create table if not exists` above is a no-op there, so the old, narrower
-- check would survive and reject 'launching' forever.
alter table public.meetings drop constraint if exists meetings_status_check;
alter table public.meetings add  constraint meetings_status_check
  check (status in ('queued','launching','joining','waiting_admission',
                    'in_call','leaving','ended','failed'));

create index if not exists meetings_team_id_idx    on public.meetings (team_id);
create index if not exists meetings_team_ref_idx   on public.meetings (team_ref);
create index if not exists meetings_created_at_idx on public.meetings (created_at desc);
create index if not exists meetings_session_id_idx on public.meetings (session_id);

-- One number per team, and no gaps caused by two bots racing.
create unique index if not exists meetings_team_ref_number_key
  on public.meetings (team_ref, meeting_number);

-- ---------------------------------------------------------------------------
-- meeting_number: assigned in the database, under a lock
-- ---------------------------------------------------------------------------
-- Computing `max(meeting_number) + 1` in the application is a race: two bots
-- summoned for the same team in the same second both read the same maximum and
-- both try to insert the same number. Doing it in a BEFORE INSERT trigger with
-- a transaction-scoped advisory lock keyed on the team serialises exactly the
-- inserts that could collide, and nothing else.
create or replace function public.assign_meeting_number()
returns trigger
language plpgsql
as $$
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
$$;

drop trigger if exists meetings_assign_number on public.meetings;
create trigger meetings_assign_number
  before insert on public.meetings
  for each row execute function public.assign_meeting_number();

-- `touch_updated_at()` belongs to astra-platform's schema.sql. Guarded so this
-- file can be run against a database that does not have it.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'touch_updated_at')
     and not exists (select 1 from pg_trigger where tgname = 'meetings_touch_updated_at')
  then
    create trigger meetings_touch_updated_at
      before update on public.meetings
      for each row execute function public.touch_updated_at();
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- transcripts
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

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- The container writes with the service role key, which bypasses RLS entirely.
-- These policies exist for the *dashboard*: a team member opening a past
-- meeting reads these tables as themselves, and without policies they would
-- see nothing at all.
alter table public.meetings    enable row level security;
alter table public.transcripts enable row level security;

drop policy if exists meetings_select_members    on public.meetings;
drop policy if exists transcripts_select_members on public.transcripts;

-- `private.is_team_member` / `is_team_leader` come from astra-platform's
-- schema.sql. Where they are absent the policy falls back to leadership checked
-- inline, so this file still works standalone.
do $$
declare
  have_helpers boolean;
begin
  select exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname = 'is_team_member'
  ) into have_helpers;

  if have_helpers then
    execute $p$
      create policy meetings_select_members on public.meetings
        for select to authenticated
        using (
          team_id is not null
          and (private.is_team_member(team_id) or private.is_team_leader(team_id))
        )
    $p$;
  else
    execute $p$
      create policy meetings_select_members on public.meetings
        for select to authenticated
        using (
          exists (
            select 1 from public.teams t
             where t.id = meetings.team_id
               and t.leader_id = (select auth.uid())
          )
        )
    $p$;
  end if;
end;
$$;

-- A transcript is visible exactly when its meeting is. Re-stating the team
-- check here would be a second place to get wrong.
create policy transcripts_select_members on public.transcripts
  for select to authenticated
  using (
    exists (select 1 from public.meetings m where m.id = transcripts.meeting_id)
  );

-- ---------------------------------------------------------------------------
-- Grants (PostgREST checks table privileges before RLS is consulted)
-- ---------------------------------------------------------------------------
grant select on public.meetings    to authenticated;
grant select on public.transcripts to authenticated;
grant all privileges on public.meetings    to service_role;
grant all privileges on public.transcripts to service_role;

-- ---------------------------------------------------------------------------
-- The spec's spelling, for anything that wants `team_name`
-- ---------------------------------------------------------------------------
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
  left join public.teams t   on t.id = m.team_id
  left join public.transcripts tr on tr.meeting_id = m.id;

comment on view public.meeting_transcripts is
  'Flattened teams -> meetings -> transcripts, with the spec''s team_name spelling.';

grant select on public.meeting_transcripts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Confirm, then tell PostgREST
-- ---------------------------------------------------------------------------
select 'meetings'    as table, count(*) as rows from public.meetings
union all
select 'transcripts' as table, count(*) as rows from public.transcripts;

-- PostgREST caches the schema at boot and does not watch for DDL, so a freshly
-- created table is invisible to the API until this fires -- which looks exactly
-- like the migration never ran (PGRST205). Same effect as the dashboard's
-- Settings -> API -> "Reload schema cache" button.
notify pgrst, 'reload schema';

-- Astra — development seed data
-- Apply after schema.sql:  psql "$DATABASE_URL" -f migrations/schema.sql -f migrations/seed.sql
--
-- Row-level security is enforced here too. Each block sets app.current_team_id
-- to the UUID it is about to insert, which is exactly how the API creates a team.
-- Re-running is safe: every statement is idempotent on its natural key.

BEGIN;

-- ===========================================================================
-- Team 1 — Capstone Core (fully configured; this is what the dashboard shows)
-- ===========================================================================

SET LOCAL app.current_team_id = 'a1b2c3d4-0001-4000-8000-000000000001';

INSERT INTO teams (id, name, slug, jira_project_key, github_repo, plan)
VALUES (
    'a1b2c3d4-0001-4000-8000-000000000001',
    'Capstone Core',
    'capstone-core',
    'ASTRA',
    'SanathSV/astra',
    'pro'
)
ON CONFLICT (id) DO UPDATE
SET name             = EXCLUDED.name,
    jira_project_key = EXCLUDED.jira_project_key,
    github_repo      = EXCLUDED.github_repo,
    plan             = EXCLUDED.plan;

-- --- Roster: Google Meet name -> Jira account -> GitHub handle --------------

INSERT INTO team_members
    (id, team_id, meet_display_name, jira_account_id, jira_display_name, github_handle, email)
VALUES
    ('b1000000-0000-4000-8000-000000000001',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Alex Smith',        '5b10ac8d82e05b22cc7d4ef5', 'Alex Smith',        'alex-dev',      'alex.smith@capstone.dev'),
    ('b1000000-0000-4000-8000-000000000002',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Sanath Venkatesh',  '5b10ac8d82e05b22cc7d4ef6', 'Sanath V',          'SanathSV',      'sanath@capstone.dev'),
    ('b1000000-0000-4000-8000-000000000003',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Priya Raghavan',    '5b10ac8d82e05b22cc7d4ef7', 'Priya Raghavan',    'praghavan',     'priya@capstone.dev'),
    ('b1000000-0000-4000-8000-000000000004',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Daniel Osei',       '5b10ac8d82e05b22cc7d4ef8', 'Daniel Osei',       'dosei-dev',     'daniel@capstone.dev'),
    ('b1000000-0000-4000-8000-000000000005',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Mei Tanaka',        '5b10ac8d82e05b22cc7d4ef9', 'Mei Tanaka',        'mei-t',         'mei@capstone.dev'),
    -- Deactivated: kept so historic action items still resolve to a name.
    ('b1000000-0000-4000-8000-000000000006',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Jordan Blake',      '5b10ac8d82e05b22cc7d4efa', 'Jordan Blake',      'jblake',        'jordan@capstone.dev')
ON CONFLICT (team_id, meet_display_name) DO UPDATE
SET jira_account_id = EXCLUDED.jira_account_id,
    github_handle   = EXCLUDED.github_handle,
    email           = EXCLUDED.email;

UPDATE team_members
SET is_active = false
WHERE id = 'b1000000-0000-4000-8000-000000000006';

-- --- Integrations -----------------------------------------------------------
-- credential_ref points at the secret store; no raw token is ever written here.

INSERT INTO integrations
    (team_id, provider, status, domain, config, credential_ref,
     last_tested_at, last_test_latency_ms, last_test_message)
VALUES
    ('a1b2c3d4-0001-4000-8000-000000000001', 'jira', 'active',
     'capstone-core.atlassian.net',
     '{"project_key": "ASTRA", "issue_type": "Task", "auto_create": true}'::jsonb,
     'vault://astra/capstone-core/jira',
     now() - interval '2 hours', 214, 'Authenticated as Astra Bot'),

    ('a1b2c3d4-0001-4000-8000-000000000001', 'github', 'active',
     'github.com/capstone-core',
     '{"org": "capstone-core", "default_repo": "SanathSV/astra", "link_commits": true}'::jsonb,
     'vault://astra/capstone-core/github',
     now() - interval '2 hours', 168, 'Token valid, 3 repositories visible'),

    ('a1b2c3d4-0001-4000-8000-000000000001', 'google_workspace', 'error',
     'capstone.dev',
     '{"calendar_scope": "readonly", "auto_join": true}'::jsonb,
     'vault://astra/capstone-core/google',
     now() - interval '35 minutes', NULL, 'Service account key expired')
ON CONFLICT (team_id, provider) DO UPDATE
SET status            = EXCLUDED.status,
    domain            = EXCLUDED.domain,
    config            = EXCLUDED.config,
    credential_ref    = EXCLUDED.credential_ref,
    last_test_message = EXCLUDED.last_test_message;

-- --- Meeting sessions -------------------------------------------------------

INSERT INTO meeting_sessions
    (id, team_id, title, meeting_code, status, started_at, ended_at,
     participant_count, transcript_words, trigger_count, transcript_url)
VALUES
    ('c1000000-0000-4000-8000-000000000001',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Sprint 14 Standup', 'hqx-mnbv-trz', 'live',
     now() - interval '18 minutes', NULL, 7, 2140, 4, NULL),

    ('c1000000-0000-4000-8000-000000000002',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Capstone Architecture Review', 'kjd-ptra-wqe', 'processing',
     now() - interval '3 hours', now() - interval '2 hours',
     5, 11480, 12, 's3://astra-transcripts/kjd-ptra-wqe.json'),

    ('c1000000-0000-4000-8000-000000000003',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Bot Capture Post-mortem', 'vbn-qwer-plm', 'completed',
     now() - interval '1 day', now() - interval '1 day' + interval '47 minutes',
     4, 8320, 8, 's3://astra-transcripts/vbn-qwer-plm.json'),

    ('c1000000-0000-4000-8000-000000000004',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Integrations Sync — Jira', 'trf-lkju-xzc', 'completed',
     now() - interval '2 days', now() - interval '2 days' + interval '31 minutes',
     3, 5210, 5, 's3://astra-transcripts/trf-lkju-xzc.json'),

    ('c1000000-0000-4000-8000-000000000005',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'Extension Permissions Review', 'opl-ghyu-mnb', 'failed',
     now() - interval '3 days', now() - interval '3 days' + interval '8 minutes',
     6, 0, 0, NULL)
ON CONFLICT (id) DO UPDATE
SET status           = EXCLUDED.status,
    transcript_words = EXCLUDED.transcript_words,
    trigger_count    = EXCLUDED.trigger_count;

-- --- Action items -----------------------------------------------------------

INSERT INTO action_items
    (id, team_id, session_id, assignee_member_id, summary, detail, status,
     jira_issue_key, source_quote, confidence)
VALUES
    ('d1000000-0000-4000-8000-000000000001',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'c1000000-0000-4000-8000-000000000001',
     'b1000000-0000-4000-8000-000000000001',
     'Fix the flaky caption-capture retry in the bot',
     'Retries fire before Meet finishes rendering the caption container.',
     'pending', NULL,
     'Alex, can you take the caption retry bug before Friday?', 0.94),

    ('d1000000-0000-4000-8000-000000000002',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'c1000000-0000-4000-8000-000000000001',
     'b1000000-0000-4000-8000-000000000003',
     'Draft the RLS test plan for the backend',
     NULL,
     'pending', NULL,
     'Priya said she would write up how we test tenant isolation.', 0.81),

    ('d1000000-0000-4000-8000-000000000003',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'c1000000-0000-4000-8000-000000000002',
     'b1000000-0000-4000-8000-000000000002',
     'Split the transcript worker out of the API process',
     'Long transcriptions block request handlers; move to a queue consumer.',
     'synced', 'ASTRA-142',
     'We agreed the worker cannot live inside the API container.', 0.97),

    ('d1000000-0000-4000-8000-000000000004',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'c1000000-0000-4000-8000-000000000002',
     'b1000000-0000-4000-8000-000000000004',
     'Add Upstash Redis connection pooling',
     NULL,
     'synced', 'ASTRA-143',
     'Daniel will wire up pooling so we stop exhausting connections.', 0.89),

    ('d1000000-0000-4000-8000-000000000005',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'c1000000-0000-4000-8000-000000000003',
     'b1000000-0000-4000-8000-000000000005',
     'Document the Meet join failure modes',
     'Waiting-room timeout, denied entry, and codec negotiation failure.',
     'synced', 'ASTRA-131',
     'Mei is going to document every way the join can fail.', 0.92),

    -- Unassigned: the speaker was not in the roster, so it needs manual review.
    ('d1000000-0000-4000-8000-000000000006',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'c1000000-0000-4000-8000-000000000003',
     NULL,
     'Confirm the extension permission scope with legal',
     'Speaker could not be matched to a roster entry.',
     'pending', NULL,
     'Someone needs to check the permissions wording with legal.', 0.63),

    ('d1000000-0000-4000-8000-000000000007',
     'a1b2c3d4-0001-4000-8000-000000000001',
     'c1000000-0000-4000-8000-000000000004',
     'b1000000-0000-4000-8000-000000000001',
     'Rotate the Jira API token before the demo',
     NULL,
     'dismissed', NULL,
     'We should rotate that token, though it may already be handled.', 0.55)
ON CONFLICT (id) DO UPDATE
SET status         = EXCLUDED.status,
    jira_issue_key = EXCLUDED.jira_issue_key;

-- ===========================================================================
-- Team 2 — Platform Guild (second tenant; exists to prove RLS actually isolates)
-- ===========================================================================

SET LOCAL app.current_team_id = 'a1b2c3d4-0002-4000-8000-000000000002';

INSERT INTO teams (id, name, slug, jira_project_key, github_repo, plan)
VALUES (
    'a1b2c3d4-0002-4000-8000-000000000002',
    'Platform Guild',
    'platform-guild',
    'PLAT',
    'capstone-core/platform',
    'pro'
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO team_members
    (team_id, meet_display_name, jira_account_id, jira_display_name, github_handle, email)
VALUES
    ('a1b2c3d4-0002-4000-8000-000000000002',
     'Riley Chen', '6c20bd9e93f16c33dd8e5f01', 'Riley Chen', 'rchen-platform', 'riley@capstone.dev'),
    ('a1b2c3d4-0002-4000-8000-000000000002',
     'Tomas Aalto', '6c20bd9e93f16c33dd8e5f02', 'Tomas Aalto', 'taalto', 'tomas@capstone.dev')
ON CONFLICT (team_id, meet_display_name) DO NOTHING;

INSERT INTO integrations (team_id, provider, status, domain, config)
VALUES
    ('a1b2c3d4-0002-4000-8000-000000000002', 'jira', 'not_linked', NULL,
     '{"project_key": "PLAT"}'::jsonb)
ON CONFLICT (team_id, provider) DO NOTHING;

INSERT INTO meeting_sessions
    (id, team_id, title, meeting_code, status, started_at, ended_at,
     participant_count, transcript_words, trigger_count)
VALUES
    ('c2000000-0000-4000-8000-000000000001',
     'a1b2c3d4-0002-4000-8000-000000000002',
     'Platform Weekly', 'zxc-vbnm-asd', 'completed',
     now() - interval '4 days', now() - interval '4 days' + interval '52 minutes',
     9, 9870, 6)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Verify isolation:
--   SET app.current_team_id = 'a1b2c3d4-0001-4000-8000-000000000001';
--   SELECT count(*) FROM meeting_sessions;  -- 5, never 6

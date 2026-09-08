-- Astra — core schema
-- PostgreSQL 15+ (Supabase compatible). Apply before seed.sql.
--
-- Tenancy model: every table carries `team_id` and is protected by row-level
-- security. The API opens each transaction with
--     SET LOCAL app.current_team_id = '<uuid>';
-- and the policies below reduce every query to that team's rows. Connections
-- must therefore use a role WITHOUT the BYPASSRLS attribute.
--
-- Creating a team works under the same rule because the application generates
-- the team UUID itself: it sets app.current_team_id to that new UUID first, so
-- the INSERT satisfies the WITH CHECK. There is no provisioning escape hatch.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'integration_provider') THEN
        CREATE TYPE integration_provider AS ENUM ('jira', 'github', 'google_workspace');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'integration_status') THEN
        CREATE TYPE integration_status AS ENUM ('not_linked', 'active', 'error');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_status') THEN
        CREATE TYPE session_status AS ENUM ('live', 'processing', 'completed', 'failed');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'action_item_status') THEN
        CREATE TYPE action_item_status AS ENUM ('pending', 'synced', 'dismissed', 'failed');
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Tenancy helper
-- ---------------------------------------------------------------------------

-- Returns the team scoping the current transaction, or NULL when unset.
-- The `true` argument makes the lookup return NULL instead of raising when the
-- setting is missing, so an unscoped connection sees zero rows rather than an error.
CREATE OR REPLACE FUNCTION app_current_team_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('app.current_team_id', true), '')::uuid;
$$;

-- Keeps `updated_at` honest without the application having to remember.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teams (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name              text        NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
    slug              text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
    -- Uppercase Jira project key, e.g. ASTRA. NULL until the team links Jira.
    jira_project_key  text        CHECK (jira_project_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
    -- owner/repository, e.g. SanathSV/astra.
    github_repo       text        CHECK (github_repo ~ '^[\w.-]+/[\w.-]+$'),
    plan              text        NOT NULL DEFAULT 'trial',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- team_members — the Meet -> Jira -> GitHub identity mapping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS team_members (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            uuid        NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    -- Must match the display name Google Meet reports, or speaker attribution fails.
    meet_display_name  text        NOT NULL CHECK (char_length(meet_display_name) > 0),
    jira_account_id    text,
    jira_display_name  text,
    -- Alphanumeric with single internal hyphens, max 39 chars. Kept identical to
    -- the Pydantic pattern in app/schemas/team.py so both layers agree.
    github_handle      text        CHECK (
                                       github_handle ~ '^[a-zA-Z0-9](-?[a-zA-Z0-9])*$'
                                       AND char_length(github_handle) <= 39
                                   ),
    email              text,
    is_active          boolean     NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT team_members_unique_meet_name UNIQUE (team_id, meet_display_name)
);

CREATE INDEX IF NOT EXISTS team_members_team_id_idx ON team_members (team_id);

-- ---------------------------------------------------------------------------
-- integrations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integrations (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id               uuid                 NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    provider              integration_provider NOT NULL,
    status                integration_status   NOT NULL DEFAULT 'not_linked',
    -- Host only: your-team.atlassian.net, github.com/your-org, your-company.com.
    domain                text,
    -- Non-secret provider settings (org id, scopes, webhook path, ...).
    config                jsonb                NOT NULL DEFAULT '{}'::jsonb,
    -- Pointer into the secret store. Raw tokens are NEVER stored in Postgres.
    credential_ref        text,
    last_tested_at        timestamptz,
    last_test_latency_ms  integer CHECK (last_test_latency_ms >= 0),
    last_test_message     text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT integrations_one_per_provider UNIQUE (team_id, provider)
);

CREATE INDEX IF NOT EXISTS integrations_team_id_idx ON integrations (team_id);

-- ---------------------------------------------------------------------------
-- meeting_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meeting_sessions (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id            uuid           NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    title              text           NOT NULL,
    -- Google Meet code, e.g. hqx-mnbv-trz.
    meeting_code       text           NOT NULL CHECK (meeting_code ~ '^[a-z]{3}-[a-z]{4}-[a-z]{3}$'),
    status             session_status NOT NULL DEFAULT 'live',
    started_at         timestamptz    NOT NULL DEFAULT now(),
    ended_at           timestamptz,
    participant_count  integer        NOT NULL DEFAULT 0 CHECK (participant_count >= 0),
    transcript_words   integer        NOT NULL DEFAULT 0 CHECK (transcript_words >= 0),
    trigger_count      integer        NOT NULL DEFAULT 0 CHECK (trigger_count >= 0),
    transcript_url     text,
    created_at         timestamptz    NOT NULL DEFAULT now(),
    updated_at         timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT meeting_sessions_end_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS meeting_sessions_team_started_idx
    ON meeting_sessions (team_id, started_at DESC);

-- Partial index: the /sessions/active endpoint only ever scans unfinished calls.
CREATE INDEX IF NOT EXISTS meeting_sessions_active_idx
    ON meeting_sessions (team_id, started_at DESC)
    WHERE status IN ('live', 'processing');

-- At most one live capture per meeting code, across all teams — the bot joins once.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_sessions_one_live_per_code
    ON meeting_sessions (meeting_code)
    WHERE status = 'live';

-- ---------------------------------------------------------------------------
-- action_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS action_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id             uuid               NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    session_id          uuid               NOT NULL REFERENCES meeting_sessions (id) ON DELETE CASCADE,
    -- NULL when the speaker could not be matched to a roster entry.
    assignee_member_id  uuid               REFERENCES team_members (id) ON DELETE SET NULL,
    summary             text               NOT NULL CHECK (char_length(summary) > 0),
    detail              text,
    status              action_item_status NOT NULL DEFAULT 'pending',
    jira_issue_key      text               CHECK (jira_issue_key ~ '^[A-Z][A-Z0-9]{1,9}-\d+$'),
    -- Verbatim transcript line the item was extracted from, for auditability.
    source_quote        text,
    confidence          numeric(3, 2)      CHECK (confidence BETWEEN 0 AND 1),
    created_at          timestamptz        NOT NULL DEFAULT now(),
    updated_at          timestamptz        NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_items_session_idx ON action_items (session_id);
CREATE INDEX IF NOT EXISTS action_items_team_status_idx ON action_items (team_id, status);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'teams', 'team_members', 'integrations', 'meeting_sessions', 'action_items'
    ]
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_set_updated_at', target);
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            target || '_set_updated_at', target
        );
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- FORCE applies the policies to the table owner too, so a misconfigured
-- connection string cannot quietly read across tenants.

ALTER TABLE teams            ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_items     ENABLE ROW LEVEL SECURITY;

ALTER TABLE teams            FORCE ROW LEVEL SECURITY;
ALTER TABLE team_members     FORCE ROW LEVEL SECURITY;
ALTER TABLE integrations     FORCE ROW LEVEL SECURITY;
ALTER TABLE meeting_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE action_items     FORCE ROW LEVEL SECURITY;

-- teams is keyed on `id` rather than `team_id`.
DROP POLICY IF EXISTS teams_tenant_isolation ON teams;
CREATE POLICY teams_tenant_isolation ON teams
    USING (id = app_current_team_id())
    WITH CHECK (id = app_current_team_id());

DROP POLICY IF EXISTS team_members_tenant_isolation ON team_members;
CREATE POLICY team_members_tenant_isolation ON team_members
    USING (team_id = app_current_team_id())
    WITH CHECK (team_id = app_current_team_id());

DROP POLICY IF EXISTS integrations_tenant_isolation ON integrations;
CREATE POLICY integrations_tenant_isolation ON integrations
    USING (team_id = app_current_team_id())
    WITH CHECK (team_id = app_current_team_id());

DROP POLICY IF EXISTS meeting_sessions_tenant_isolation ON meeting_sessions;
CREATE POLICY meeting_sessions_tenant_isolation ON meeting_sessions
    USING (team_id = app_current_team_id())
    WITH CHECK (team_id = app_current_team_id());

DROP POLICY IF EXISTS action_items_tenant_isolation ON action_items;
CREATE POLICY action_items_tenant_isolation ON action_items
    USING (team_id = app_current_team_id())
    WITH CHECK (team_id = app_current_team_id());

COMMIT;

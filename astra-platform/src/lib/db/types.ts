/**
 * Row shapes for the tables created by supabase/schema.sql.
 *
 * Hand-written rather than generated so the file stays readable, but kept in
 * exact lockstep with the DDL — if you add a column there, add it here.
 */

export type Uuid = string;

export interface Profile {
  id: Uuid;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Employee {
  id: Uuid;
  profile_id: Uuid | null;
  full_name: string;
  email: string;
  title: string | null;
  github_username: string | null;
  jira_account_id: string | null;
  slack_user_id: string | null;
  created_by: Uuid | null;
  created_at: string;
  updated_at: string;
}

export interface Team {
  id: Uuid;
  name: string;
  description: string | null;
  leader_id: Uuid;
  sprint_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: Uuid;
  team_id: Uuid;
  employee_id: Uuid;
  sprint_role: string;
  is_lead: boolean;
  created_at: string;
}

/** A roster row as the UI wants it: the seat plus the human in it. */
export interface TeamMemberWithEmployee extends TeamMember {
  employee: Employee;
}

/**
 * Stored form. Every `*_token` field is AES-256-GCM ciphertext; nothing here is
 * ever sent to the browser as written. See `IntegrationsView` for the redacted
 * shape the client actually receives.
 */
export interface TeamIntegrations {
  team_id: Uuid;
  slack_bot_token: string | null;
  slack_channel_id: string | null;
  github_token: string | null;
  github_repo_url: string | null;
  jira_base_url: string | null;
  jira_project_key: string | null;
  jira_email: string | null;
  jira_api_token: string | null;
  updated_at: string;
}

/** Decrypted, server-side only. Never serialise this into a response. */
export interface TeamIntegrationsPlain {
  slackBotToken: string | null;
  slackChannelId: string | null;
  githubToken: string | null;
  githubRepoUrl: string | null;
  jiraBaseUrl: string | null;
  jiraProjectKey: string | null;
  jiraEmail: string | null;
  jiraApiToken: string | null;
}

/**
 * What the settings form gets back: which integrations are configured, and the
 * non-secret fields in full. Secrets collapse to a boolean.
 */
export interface IntegrationsView {
  slack: { configured: boolean; channelId: string | null; hasToken: boolean };
  github: { configured: boolean; repoUrl: string | null; hasToken: boolean };
  jira: {
    configured: boolean;
    baseUrl: string | null;
    projectKey: string | null;
    email: string | null;
    hasToken: boolean;
  };
  updatedAt: string | null;
}

export type PreContextStatus = "success" | "partial" | "failed";

export interface PreContextRun {
  id: Uuid;
  team_id: Uuid;
  generated_by: Uuid | null;
  status: PreContextStatus;
  payload: unknown;
  sources: Record<string, SourceOutcome>;
  error: string | null;
  token_estimate: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface SourceOutcome {
  ok: boolean;
  ms: number;
  /** Present when ok === false. Human-readable, safe to show in the UI. */
  error?: string;
  /** Present when ok === true: how many objects came back before compaction. */
  fetched?: number;
  skipped?: string;
}

/** Dashboard shape: a team plus the bits the card renders. */
export interface TeamSummary extends Team {
  leader: Pick<Profile, "id" | "email" | "full_name"> | null;
  member_count: number;
  my_role: string | null;
  i_lead: boolean;
}

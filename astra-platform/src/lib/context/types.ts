/**
 * The shape of the payload handed to the bot container.
 *
 * This is a wire contract, not an internal type: it is serialised into a
 * ConfigMap / env file and mounted into the ephemeral Meet bot at launch, so
 * every field name here is short on purpose. The bot has a finite context
 * window and this JSON is spent from it before a single word is transcribed —
 * see `compaction.ts` for the budget that keeps it small.
 */

export const PRE_CONTEXT_SCHEMA = "astra.precontext/v1" as const;

/** One human, and every handle they answer to. The cross-walk map. */
export interface RosterEntry {
  /** Short stable key used to reference this person elsewhere in the payload. */
  ref: string;
  name: string;
  role: string;
  email?: string;
  gh?: string;
  jira?: string;
  slack?: string;
  lead?: true;
}

export interface GitHubPullRequest {
  num: number;
  title: string;
  /** Roster ref when the author is on the team, otherwise the raw login. */
  author: string;
  draft?: true;
  age_days: number;
  /** Review state summary, e.g. "approved", "changes_requested", "pending". */
  reviews?: string;
  labels?: string[];
  url: string;
}

export interface GitHubCommit {
  sha: string;
  msg: string;
  author: string;
  at: string;
}

export interface GitHubContext {
  repo: string;
  default_branch?: string;
  description?: string;
  language?: string;
  open_prs: GitHubPullRequest[];
  recent_commits: GitHubCommit[];
  /** Commits in the window, per roster ref. Cheap signal, one line of JSON. */
  commits_by_member?: Record<string, number>;
  window_days: number;
  /** Set when the team has GitHub handles that produced nothing in the window. */
  quiet_members?: string[];
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  type?: string;
  priority?: string;
  /** Roster ref, or the display name for someone outside the team. */
  assignee?: string;
  points?: number;
  updated: string;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  goal?: string;
  start?: string;
  end?: string;
  /** Whole days left, negative when the sprint is already over. */
  days_left?: number;
}

export interface JiraContext {
  base_url: string;
  project: string;
  board?: { id: number; name: string };
  sprint?: JiraSprint;
  issues: JiraIssue[];
  /** Issue counts by status category, so the bot can summarise without maths. */
  status_counts?: Record<string, number>;
  /** Roster refs with nothing assigned in the active sprint. */
  unassigned_members?: string[];
}

export interface SlackContext {
  channel_id: string;
  channel_name?: string;
  /** Roster refs confirmed present in the channel. */
  members_present?: string[];
  /** Team members whose Slack ID is not in the channel — usually a typo. */
  members_missing?: string[];
}

export interface PreContextMeta {
  generated_at: string;
  duration_ms: number;
  /** Per source: ok/failed, timing, and why it failed. */
  sources: Record<string, { ok: boolean; ms: number; error?: string; skipped?: string }>;
  /** What compaction dropped, so a thin payload is never mysterious. */
  truncated: string[];
  /** ~4 chars per token. A budgeting hint for whoever launches the bot. */
  token_estimate: number;
  bytes: number;
}

export interface PreContextPayload {
  schema: typeof PRE_CONTEXT_SCHEMA;
  team: {
    id: string;
    name: string;
    sprint?: string;
    description?: string;
    leader?: string;
  };
  roster: RosterEntry[];
  github?: GitHubContext;
  jira?: JiraContext;
  slack?: SlackContext;
  /** A handful of pre-computed facts, so the bot does not have to derive them. */
  digest: string[];
  meta: PreContextMeta;
}

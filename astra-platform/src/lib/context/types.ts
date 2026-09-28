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
  /**
   * Roster refs whose review this PR is waiting on. Structured rather than a
   * prose summary because the analysis counts them: three PRs pointing at the
   * same person is a bottleneck, and that is only computable from a list.
   */
  reviewers?: string[];
  labels?: string[];
  url: string;
}

export interface GitHubCommit {
  sha: string;
  msg: string;
  author: string;
  at: string;
  /**
   * The branch this commit was first seen on, default branch first. So a commit
   * already merged reads as "main" and unmerged work carries the branch it
   * lives on — which is the thing someone is about to talk about in a standup.
   */
  branch?: string;
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
  /** How many branches were actually scanned, and how many exist. */
  branches_scanned?: number;
  branches_total?: number;
  /**
   * Branches with commits in the window that are not on the default branch —
   * unmerged work in flight, newest first. The single most useful GitHub fact
   * for a standup after the PR list.
   */
  active_branches?: { name: string; commits: number; authors: string[] }[];
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

/**
 * The derived layer: what the harvest MEANS.
 *
 * Everything here is computed from the raw sections below it, deterministically
 * and once, so the bot spends its context on judgement rather than arithmetic.
 */
export interface SprintHealth {
  /** Completion measured against elapsed time, not in isolation. */
  verdict: "ahead" | "on_track" | "behind" | "at_risk" | "unknown";
  /** One sentence, safe to read out loud. */
  note: string;
  goal?: string;
  days_left?: number;
  elapsed_pct?: number;
  issues_total: number;
  issues_done: number;
  issues_done_pct: number;
  points_total?: number;
  points_done?: number;
  points_done_pct?: number;
}

/** One row per person, shaped like the meeting: it goes around the room. */
export interface MemberAnalytics {
  ref: string;
  name: string;
  role: string;
  commits: number;
  branches?: string[];
  prs_open: number;
  prs_stale: number;
  /** How many open PRs are waiting on THIS person to review. */
  reviews_requested?: number;
  issues: number;
  in_progress: number;
  done: number;
  points?: number;
  /** Short phrases worth raising about this person, if any. */
  signals?: string[];
}

export interface Risk {
  kind:
    | "sprint_pace"
    | "stale_pr"
    | "stalled_issue"
    | "wip_overload"
    | "review_bottleneck"
    | "idle_member"
    | "claimed_but_quiet"
    | "no_sprint_work"
    | "config";
  severity: "high" | "medium" | "low";
  /** A roster ref, an issue key, or a PR number. */
  subject?: string;
  detail: string;
}

export interface Analysis {
  sprint?: SprintHealth;
  per_member: MemberAnalytics[];
  /** Most serious first. */
  risks: Risk[];
  /** The agenda, in order. Sentences, meant to be read aloud. */
  talking_points: string[];
  totals: {
    members: number;
    commits: number;
    open_prs: number;
    stale_prs: number;
    issues: number;
    in_progress: number;
  };
  /**
   * Whether every configured source answered.
   *
   * False means absences are unreliable — a missing person may simply be a
   * source that failed — so the bot should hedge rather than assert silence.
   */
  complete: boolean;
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
  /**
   * The derived layer. Read this before the raw sections: it is the same
   * facts, already reasoned about.
   */
  analysis?: Analysis;
  /** A handful of pre-computed facts, so the bot does not have to derive them. */
  digest: string[];
  meta: PreContextMeta;
}

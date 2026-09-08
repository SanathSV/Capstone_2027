import { collectGitHub } from "./github";
import { collectJira } from "./jira";
import { collectSlack } from "./slack";
import { enforceBudget, estimateTokens, LIMITS, prune, truncate } from "./compaction";
import { PRE_CONTEXT_SCHEMA } from "./types";
import type { PreContextPayload, RosterEntry } from "./types";
import type {
  Team,
  TeamIntegrationsPlain,
  TeamMemberWithEmployee,
  PreContextStatus,
  SourceOutcome,
} from "@/lib/db/types";

/**
 * The "Generate Pre-Context" engine.
 *
 * One call fans out to every configured integration in parallel, folds the
 * results onto the team roster, compacts the result to fit a bot container's
 * context budget, and hands back a single JSON object.
 *
 * Partial failure is the normal case, not an exception: a team may have GitHub
 * configured and Jira not, or a Jira token may have expired this morning. Each
 * source therefore fails independently and records why in `meta.sources`, and
 * the run is reported as `partial` rather than thrown away. A standup with
 * GitHub context and no Jira context is still a much better standup.
 */

/** Stable, short, human-readable person key: "grace", "grace2" on collision. */
function makeRefs(members: TeamMemberWithEmployee[]): Map<string, string> {
  const used = new Set<string>();
  const refs = new Map<string, string>();

  for (const member of members) {
    const base =
      member.employee.full_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 12) || "member";
    let ref = base;
    let n = 2;
    while (used.has(ref)) ref = `${base}${n++}`;
    used.add(ref);
    refs.set(member.employee.id, ref);
  }
  return refs;
}

export function buildRoster(members: TeamMemberWithEmployee[]): RosterEntry[] {
  const refs = makeRefs(members);

  return members.map((member) => {
    const e = member.employee;
    const entry: RosterEntry = {
      ref: refs.get(e.id)!,
      name: e.full_name,
      role: member.sprint_role,
    };
    if (e.email) entry.email = e.email;
    if (e.github_username) entry.gh = e.github_username;
    if (e.jira_account_id) entry.jira = e.jira_account_id;
    if (e.slack_user_id) entry.slack = e.slack_user_id;
    if (member.is_lead) entry.lead = true;
    return entry;
  });
}

/**
 * Facts the bot would otherwise have to derive mid-sentence. Cheap to compute
 * here, expensive to compute in a model's head while someone is talking.
 */
function buildDigest(payload: PreContextPayload): string[] {
  const lines: string[] = [];
  const { roster, github, jira, team } = payload;

  lines.push(
    `${team.name}: ${roster.length} member(s)` +
      (team.sprint ? `, sprint "${team.sprint}"` : ""),
  );

  if (jira?.sprint) {
    const s = jira.sprint;
    const window =
      typeof s.days_left === "number"
        ? s.days_left >= 0
          ? `${s.days_left}d remaining`
          : `ended ${Math.abs(s.days_left)}d ago`
        : "no end date";
    lines.push(`Jira sprint "${s.name}" (${s.state}, ${window}).`);
    if (s.goal) lines.push(`Sprint goal: ${s.goal}`);
  }

  if (jira?.status_counts) {
    const parts = Object.entries(jira.status_counts).map(([k, v]) => `${v} ${k}`);
    lines.push(`Sprint issues by status: ${parts.join(", ")}.`);
  }

  if (github) {
    lines.push(
      `${github.repo}: ${github.open_prs.length} open PR(s) from this team, ` +
        `${github.recent_commits.length} commit(s) in the last ${github.window_days}d` +
        (github.branches_scanned
          ? ` across ${github.branches_scanned} branch(es)`
          : "") +
        ".",
    );

    if (github.active_branches?.length) {
      lines.push(
        `Unmerged work in flight: ${github.active_branches
          .slice(0, 6)
          .map((b) => `${b.name} (${b.authors.join(", ")}, ${b.commits} commit(s))`)
          .join("; ")}.`,
      );
    }
    const stale = github.open_prs.filter((pr) => pr.age_days >= 7);
    if (stale.length) {
      lines.push(
        `Open more than a week: ${stale
          .slice(0, 5)
          .map((pr) => `#${pr.num} (${pr.author}, ${pr.age_days}d)`)
          .join(", ")}.`,
      );
    }
    if (github.quiet_members?.length) {
      lines.push(`No commits in the window from: ${github.quiet_members.join(", ")}.`);
    }
  }

  if (jira?.unassigned_members?.length) {
    lines.push(`No sprint issues assigned to: ${jira.unassigned_members.join(", ")}.`);
  }

  if (payload.slack?.members_missing?.length) {
    lines.push(
      `Slack IDs not found in the channel (check the directory): ` +
        `${payload.slack.members_missing.join(", ")}.`,
    );
  }

  return lines;
}

export interface AggregateInput {
  team: Team;
  leaderName: string | null;
  members: TeamMemberWithEmployee[];
  integrations: TeamIntegrationsPlain;
}

export interface AggregateResult {
  payload: PreContextPayload;
  status: PreContextStatus;
  sources: Record<string, SourceOutcome>;
}

/** Runs one source, timing it and converting a throw into a recorded failure. */
async function runSource<T extends { fetched: number; truncated: string[] }>(
  name: string,
  skipReason: string | null,
  work: () => Promise<T>,
): Promise<{ result: T | null; outcome: SourceOutcome }> {
  if (skipReason) {
    return { result: null, outcome: { ok: true, ms: 0, skipped: skipReason } };
  }
  const started = Date.now();
  try {
    const result = await work();
    return {
      result,
      outcome: { ok: true, ms: Date.now() - started, fetched: result.fetched },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[astra:precontext] ${name} failed:`, message);
    return {
      result: null,
      outcome: { ok: false, ms: Date.now() - started, error: message },
    };
  }
}

export async function generatePreContext(
  input: AggregateInput,
): Promise<AggregateResult> {
  const started = Date.now();
  const { team, members, integrations } = input;
  const roster = buildRoster(members);
  const truncated: string[] = [];

  const githubReady = Boolean(integrations.githubToken && integrations.githubRepoUrl);
  const jiraReady = Boolean(
    integrations.jiraBaseUrl &&
      integrations.jiraProjectKey &&
      integrations.jiraEmail &&
      integrations.jiraApiToken,
  );
  const slackReady = Boolean(integrations.slackBotToken && integrations.slackChannelId);

  // Fan out. Three independent networks, so sequential calls would triple the
  // time the leader stares at a spinner for no benefit.
  const [github, jira, slack] = await Promise.all([
    runSource("GitHub", githubReady ? null : "GitHub is not configured for this team", () =>
      collectGitHub(integrations.githubRepoUrl!, integrations.githubToken!, roster),
    ),
    runSource("Jira", jiraReady ? null : "Jira is not configured for this team", () =>
      collectJira(
        integrations.jiraBaseUrl!,
        integrations.jiraProjectKey!,
        integrations.jiraEmail!,
        integrations.jiraApiToken!,
        roster,
      ),
    ),
    runSource("Slack", slackReady ? null : "Slack is not configured for this team", () =>
      collectSlack(integrations.slackBotToken!, integrations.slackChannelId!, roster),
    ),
  ]);

  for (const source of [github, jira, slack]) {
    if (source.result) truncated.push(...source.result.truncated);
  }

  const payload: PreContextPayload = {
    schema: PRE_CONTEXT_SCHEMA,
    team: {
      id: team.id,
      name: team.name,
      ...(team.sprint_name ? { sprint: team.sprint_name } : {}),
      ...(team.description
        ? { description: truncate(team.description, LIMITS.descriptionChars) }
        : {}),
      ...(input.leaderName ? { leader: input.leaderName } : {}),
    },
    roster,
    ...(github.result ? { github: github.result.context } : {}),
    ...(jira.result ? { jira: jira.result.context } : {}),
    ...(slack.result ? { slack: slack.result.context } : {}),
    digest: [],
    meta: {
      generated_at: new Date().toISOString(),
      duration_ms: 0,
      sources: {
        github: github.outcome,
        jira: jira.outcome,
        slack: slack.outcome,
      },
      truncated,
      token_estimate: 0,
      bytes: 0,
    },
  };

  // Always at least one line (the team header), so this never prunes away —
  // but be explicit rather than relying on buildDigest never returning [].
  payload.digest = buildDigest(payload) ?? [];

  // Prune, then budget, then measure — measuring before the shrink would report
  // a size the container never sees.
  //
  // `meta` is deliberately exempt from pruning and put back whole. Everywhere
  // else an empty array means "nothing to say" and dropping the key saves
  // tokens, but in meta the empty array IS the statement: `truncated: []` means
  // "nothing was dropped", and both the UI and enforceBudget index into it.
  // Letting prune eat it turned a clean run into a TypeError.
  const pruned = prune(payload);
  pruned.meta = payload.meta;
  const budgeted = enforceBudget(pruned);
  const serialised = JSON.stringify(budgeted);
  budgeted.meta.bytes = Buffer.byteLength(serialised, "utf8");
  budgeted.meta.token_estimate = estimateTokens(serialised);
  budgeted.meta.duration_ms = Date.now() - started;

  const outcomes = [github.outcome, jira.outcome, slack.outcome];
  const attempted = outcomes.filter((o) => !o.skipped);
  const failed = attempted.filter((o) => !o.ok);

  const status: PreContextStatus =
    attempted.length === 0
      ? "partial" // nothing configured: roster-only context is still usable
      : failed.length === 0
        ? "success"
        : failed.length === attempted.length
          ? "failed"
          : "partial";

  return {
    payload: budgeted,
    status,
    sources: {
      github: github.outcome,
      jira: jira.outcome,
      slack: slack.outcome,
    },
  };
}

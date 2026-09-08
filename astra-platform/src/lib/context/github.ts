import { fetchJson, IntegrationError } from "./http";
import type { GitHubCommit, GitHubContext, GitHubPullRequest, RosterEntry } from "./types";
import { LIMITS, truncate } from "./compaction";

/**
 * GitHub half of the context engine.
 *
 * Everything is filtered through the team roster: a repository with 400 open
 * PRs is noise, the 6 opened by people in this standup are signal. That
 * filtering happens here rather than in the payload builder so we never carry
 * a large intermediate list around.
 */

const API = "https://api.github.com";

interface GhRepo {
  full_name: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  open_issues_count: number;
}

interface GhUser {
  login: string;
}

interface GhPull {
  number: number;
  title: string;
  draft: boolean;
  created_at: string;
  html_url: string;
  user: GhUser | null;
  labels: { name: string }[];
  requested_reviewers: GhUser[] | null;
}

interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: GhUser | null;
}

/** Pull `owner/repo` out of any of the URL forms people actually paste. */
export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const cleaned = url
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const match = cleaned.match(
    /(?:github\.com[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (!match) {
    throw new IntegrationError(
      "GitHub",
      `"${url}" is not a GitHub repository URL. Expected https://github.com/owner/repo.`,
    );
  }
  return { owner: match[1], repo: match[2] };
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "astra-precontext",
  };
}

function daysBetween(iso: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 86_400_000));
}

export interface GitHubResult {
  context: GitHubContext;
  /** Objects seen before roster filtering and compaction — for the audit row. */
  fetched: number;
  truncated: string[];
}

export async function collectGitHub(
  repoUrl: string,
  token: string,
  roster: RosterEntry[],
  windowDays = LIMITS.commitWindowDays,
): Promise<GitHubResult> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const base = { source: "GitHub", headers: headers(token) };
  const truncated: string[] = [];
  const problems: string[] = [];
  const now = Date.now();

  // login (lowercased) -> roster ref, so results fold back onto real people.
  const byLogin = new Map<string, RosterEntry>();
  for (const person of roster) {
    if (person.gh) byLogin.set(person.gh.toLowerCase(), person);
  }

  const since = new Date(now - windowDays * 86_400_000).toISOString();

  // One repo call plus two list calls, each mapping to a different fine-grained
  // token permission: Metadata, Pull requests, and Contents respectively.
  //
  // allSettled rather than all, because those permissions are granted
  // separately and are routinely granted incompletely. A token with Contents
  // but not Pull requests should still give the standup its commit history —
  // losing every GitHub fact because one checkbox is unticked is a worse
  // outcome than a payload that says which half is missing.
  const [repoInfo, pulls, commits] = await Promise.allSettled([
    fetchJson<GhRepo>(`${API}/repos/${owner}/${repo}`, {
      ...base,
      resource: "the repository",
    }),
    fetchJson<GhPull[]>(
      `${API}/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
      { ...base, resource: "the pull request list" },
    ),
    fetchJson<GhCommit[]>(
      `${API}/repos/${owner}/${repo}/commits?since=${encodeURIComponent(since)}&per_page=100`,
      { ...base, resource: "the commit history" },
    ),
  ]);

  function settled<T>(
    outcome: PromiseSettledResult<T | null>,
    label: string,
  ): T | null {
    if (outcome.status === "fulfilled") return outcome.value;
    const message =
      outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    problems.push(message);
    truncated.push(`github: ${label} unavailable — ${message}`);
    return null;
  }

  const repoData = settled(repoInfo, "repository metadata");
  const pullData = settled(pulls, "open pull requests");
  const commitData = settled(commits, "commit history");

  // Both lists gone means the token is not usable for this repository at all.
  // Reporting that as a GitHub failure is honest; reporting an empty repo is not.
  if (pullData === null && commitData === null) {
    throw new IntegrationError("GitHub", problems[problems.length - 1] ?? "GitHub failed.");
  }

  const allPulls = pullData ?? [];
  const allCommits = commitData ?? [];
  const fetched = allPulls.length + allCommits.length;

  // --- open PRs, team-authored first -------------------------------------
  const teamPulls = allPulls.filter((pr) =>
    pr.user ? byLogin.has(pr.user.login.toLowerCase()) : false,
  );
  // If nobody on the roster has a GitHub handle configured yet, showing the
  // repository's real PR list beats showing an empty one.
  const pullSource = byLogin.size > 0 ? teamPulls : allPulls;
  if (byLogin.size > 0 && allPulls.length > teamPulls.length) {
    truncated.push(
      `github: ${allPulls.length - teamPulls.length} open PR(s) not authored by this team`,
    );
  }

  const openPrs: GitHubPullRequest[] = pullSource
    .slice(0, LIMITS.pullRequests)
    .map((pr) => {
      const login = pr.user?.login ?? "unknown";
      const entry = byLogin.get(login.toLowerCase());
      const reviewers = (pr.requested_reviewers ?? []).map(
        (r) => byLogin.get(r.login.toLowerCase())?.ref ?? r.login,
      );
      const item: GitHubPullRequest = {
        num: pr.number,
        title: truncate(pr.title, LIMITS.titleChars),
        author: entry?.ref ?? login,
        age_days: daysBetween(pr.created_at, now),
        url: pr.html_url,
      };
      if (pr.draft) item.draft = true;
      if (reviewers.length) item.reviews = `awaiting ${reviewers.join(", ")}`;
      const labels = pr.labels.map((l) => l.name).slice(0, 4);
      if (labels.length) item.labels = labels;
      return item;
    });

  if (pullSource.length > openPrs.length) {
    truncated.push(`github: ${pullSource.length - openPrs.length} older open PR(s)`);
  }

  // --- recent commits ------------------------------------------------------
  const commitsByMember: Record<string, number> = {};
  const teamCommits = allCommits.filter((c) => {
    const login = c.author?.login?.toLowerCase();
    return login ? byLogin.has(login) : false;
  });
  const commitSource = byLogin.size > 0 ? teamCommits : allCommits;

  for (const c of commitSource) {
    const ref = byLogin.get(c.author?.login?.toLowerCase() ?? "")?.ref;
    if (ref) commitsByMember[ref] = (commitsByMember[ref] ?? 0) + 1;
  }

  const recentCommits: GitHubCommit[] = commitSource
    .slice(0, LIMITS.commits)
    .map((c) => ({
      sha: c.sha.slice(0, 7),
      // Only the subject line: commit bodies are where the token budget goes
      // to die, and a standup never needs the "why" paragraph.
      msg: truncate(c.commit.message.split("\n")[0], LIMITS.commitMsgChars),
      author:
        byLogin.get(c.author?.login?.toLowerCase() ?? "")?.ref ??
        c.author?.login ??
        c.commit.author?.name ??
        "unknown",
      at: (c.commit.author?.date ?? "").slice(0, 10),
    }));

  if (commitSource.length > recentCommits.length) {
    truncated.push(
      `github: ${commitSource.length - recentCommits.length} older commit(s) in the ${windowDays}d window`,
    );
  }

  // Silence is itself a standup signal, so name it explicitly rather than
  // leaving the bot to notice an absence. Only claim it when we could actually
  // read the history — otherwise "nobody committed" would be a lie told by a
  // permissions error.
  const quiet =
    commitData === null
      ? []
      : roster.filter((p) => p.gh && !commitsByMember[p.ref]).map((p) => p.ref);

  const context: GitHubContext = {
    repo: repoData?.full_name ?? `${owner}/${repo}`,
    open_prs: openPrs,
    recent_commits: recentCommits,
    window_days: windowDays,
  };
  if (repoData?.default_branch) context.default_branch = repoData.default_branch;
  if (repoData?.description) {
    context.description = truncate(repoData.description, LIMITS.descriptionChars);
  }
  if (repoData?.language) context.language = repoData.language;
  if (Object.keys(commitsByMember).length) context.commits_by_member = commitsByMember;
  if (quiet.length) context.quiet_members = quiet;

  return { context, fetched, truncated };
}

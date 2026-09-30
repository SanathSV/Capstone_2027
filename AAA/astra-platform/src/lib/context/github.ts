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

interface GhBranch {
  name: string;
  commit: { sha: string };
}

/** A commit plus the branch we first saw it on. */
interface DatedCommit {
  commit: GhCommit;
  branch: string;
  time: number;
}

/**
 * Runs `work` over `items` with at most `limit` in flight.
 *
 * A repository with 25 branches means 25 commit requests. Firing them all at
 * once invites a secondary rate limit from GitHub (which is separate from the
 * hourly quota and triggers on burst concurrency), while doing them one at a
 * time would make the button feel broken. Eight is comfortably under the limit
 * and keeps the whole scan inside a couple of seconds.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await work(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
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
  const [repoInfo, pulls, branchList] = await Promise.allSettled([
    fetchJson<GhRepo>(`${API}/repos/${owner}/${repo}`, {
      ...base,
      resource: "the repository",
    }),
    fetchJson<GhPull[]>(
      `${API}/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
      { ...base, resource: "the pull request list" },
    ),
    fetchJson<GhBranch[]>(
      `${API}/repos/${owner}/${repo}/branches?per_page=100`,
      { ...base, resource: "the branch list" },
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
  const branchData = settled(branchList, "branch list");

  const defaultBranch = repoData?.default_branch ?? "HEAD";

  // --- commits, across every branch ---------------------------------------
  //
  // `GET /commits` with no `sha` returns the default branch and nothing else,
  // which hides exactly the work a standup is about: unmerged commits sitting
  // on feature branches. So each branch is queried by name.
  //
  // The default branch goes first deliberately. Branches share history, so most
  // commits appear on several of them; whichever branch claims a SHA first owns
  // it. Seeding with the default branch means merged work reads as "main" and
  // only genuinely unmerged commits carry a feature branch name.
  const branchNames = (branchData ?? []).map((b) => b.name);
  const ordered = [
    defaultBranch,
    ...branchNames.filter((name) => name !== defaultBranch),
  ];
  const scanned = ordered.slice(0, LIMITS.branches);

  if (ordered.length > scanned.length) {
    truncated.push(
      `github: ${ordered.length - scanned.length} further branch(es) not scanned ` +
        `(cap is ${LIMITS.branches})`,
    );
  }

  const perBranch = await mapWithConcurrency(scanned, 8, async (branch) => ({
    branch,
    commits:
      (await fetchJson<GhCommit[]>(
        `${API}/repos/${owner}/${repo}/commits` +
          `?sha=${encodeURIComponent(branch)}` +
          `&since=${encodeURIComponent(since)}&per_page=100`,
        { ...base, resource: "the commit history", allowNotFound: true },
      )) ?? [],
  }));

  const seen = new Set<string>();
  const dated: DatedCommit[] = [];
  let branchFailures = 0;

  for (const outcome of perBranch) {
    if (outcome.status === "rejected") {
      branchFailures++;
      continue;
    }
    for (const commit of outcome.value.commits) {
      if (seen.has(commit.sha)) continue; // already claimed by an earlier branch
      seen.add(commit.sha);
      dated.push({
        commit,
        branch: outcome.value.branch,
        time: Date.parse(commit.commit.author?.date ?? "") || 0,
      });
    }
  }

  // Every branch call failing is a real failure; some failing is worth a note.
  const commitScanFailed = scanned.length > 0 && branchFailures === scanned.length;
  if (branchFailures > 0 && !commitScanFailed) {
    truncated.push(`github: ${branchFailures} branch(es) could not be read`);
  }

  // Nothing readable at all means the token is not usable for this repository.
  // Reporting that as a GitHub failure is honest; reporting an empty repo is not.
  if (pullData === null && (commitScanFailed || branchData === null)) {
    throw new IntegrationError("GitHub", problems[problems.length - 1] ?? "GitHub failed.");
  }

  // Newest first, across all branches rather than within each one.
  dated.sort((a, b) => b.time - a.time);

  const allPulls = pullData ?? [];
  const allCommits = dated.map((d) => d.commit);
  const branchOf = new Map(dated.map((d) => [d.commit.sha, d.branch]));
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
      if (reviewers.length) item.reviewers = reviewers;
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

  // Commits by people who are not in the resource pool are dropped on purpose —
  // the payload is about this standup, not the repository. But dropping them
  // silently is how "why are none of Souriesh's commits here?" becomes an hour
  // of debugging, so say it: the roster, not the harvest, is what excluded them.
  if (byLogin.size > 0 && allCommits.length > teamCommits.length) {
    const outsiders = [
      ...new Set(
        allCommits
          .filter((c) => !byLogin.has(c.author?.login?.toLowerCase() ?? ""))
          .map((c) => c.author?.login ?? c.commit.author?.name ?? "unknown"),
      ),
    ];
    truncated.push(
      `github: ${allCommits.length - teamCommits.length} commit(s) by ` +
        `${outsiders.slice(0, 5).join(", ")} — not in the resource pool, so not on this team`,
    );
  }

  for (const c of commitSource) {
    const ref = byLogin.get(c.author?.login?.toLowerCase() ?? "")?.ref;
    if (ref) commitsByMember[ref] = (commitsByMember[ref] ?? 0) + 1;
  }

  const recentCommits: GitHubCommit[] = commitSource
    .slice(0, LIMITS.commits)
    .map((c) => {
      const branch = branchOf.get(c.sha);
      const item: GitHubCommit = {
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
      };
      // The default branch is the boring answer, and stamping it on most of the
      // list would cost tokens to say nothing. Only unmerged work is labelled.
      if (branch && branch !== defaultBranch) item.branch = branch;
      return item;
    });

  if (commitSource.length > recentCommits.length) {
    truncated.push(
      `github: ${commitSource.length - recentCommits.length} older commit(s) in the ${windowDays}d window`,
    );
  }

  // Silence is itself a standup signal, so name it explicitly rather than
  // leaving the bot to notice an absence.
  //
  // But only when the scan was COMPLETE. "Nobody heard from Kat this week" is a
  // sentence that gets said out loud in a standup, and it must never be an
  // artefact of an unreadable branch list, a branch that 403'd, or the branch
  // cap. A partial scan cannot distinguish "did not commit" from "committed
  // somewhere we could not look", so in that case it says nothing at all.
  const scanComplete =
    branchData !== null && branchFailures === 0 && ordered.length <= LIMITS.branches;

  const quiet = scanComplete
    ? roster.filter((p) => p.gh && !commitsByMember[p.ref]).map((p) => p.ref)
    : [];

  // Which branches carry unmerged work, and who is on them. A standup asks
  // "what are you working on"; this is the answer, one line per branch.
  const branchActivity = new Map<string, { commits: number; authors: Set<string> }>();
  for (const { commit, branch } of dated) {
    if (branch === defaultBranch) continue;
    const entry = byLogin.get(commit.author?.login?.toLowerCase() ?? "");
    // Only count the team's own work, unless no handles are configured at all.
    if (byLogin.size > 0 && !entry) continue;
    const bucket = branchActivity.get(branch) ?? { commits: 0, authors: new Set<string>() };
    bucket.commits++;
    bucket.authors.add(entry?.ref ?? commit.author?.login ?? "unknown");
    branchActivity.set(branch, bucket);
  }

  const activeBranches = [...branchActivity.entries()]
    .map(([name, v]) => ({ name, commits: v.commits, authors: [...v.authors] }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 12);

  const context: GitHubContext = {
    repo: repoData?.full_name ?? `${owner}/${repo}`,
    open_prs: openPrs,
    recent_commits: recentCommits,
    window_days: windowDays,
  };
  if (scanned.length) context.branches_scanned = scanned.length;
  if (ordered.length) context.branches_total = ordered.length;
  if (activeBranches.length) context.active_branches = activeBranches;
  if (repoData?.default_branch) context.default_branch = repoData.default_branch;
  if (repoData?.description) {
    context.description = truncate(repoData.description, LIMITS.descriptionChars);
  }
  if (repoData?.language) context.language = repoData.language;
  if (Object.keys(commitsByMember).length) context.commits_by_member = commitsByMember;
  if (quiet.length) context.quiet_members = quiet;

  return { context, fetched, truncated };
}

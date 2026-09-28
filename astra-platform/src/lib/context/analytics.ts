import type {
  Analysis,
  MemberAnalytics,
  PreContextPayload,
  Risk,
  RosterEntry,
  SprintHealth,
} from "./types";

/**
 * Turns the harvest into an analysis.
 *
 * The rest of the engine answers "what is there". This file answers "what does
 * it mean", and it exists because of where the payload is spent: inside a bot
 * that has to say something useful *while someone is still talking*. Asking a
 * model to count issues, compare a burn rate against elapsed sprint time, and
 * notice that a PR has been open eleven days — mid-sentence, from a flat list —
 * is asking it to do arithmetic under time pressure, which is exactly when
 * models invent numbers.
 *
 * So the arithmetic happens here, once, deterministically, and the payload
 * carries conclusions rather than raw material. It is also cheaper: a
 * per-member rollup is a fraction of the tokens the underlying lists cost.
 *
 * The discipline throughout is that an ABSENCE IS NOT A FINDING unless the scan
 * that would have found it actually completed. "Nobody heard from Kat" must
 * never be an artefact of a branch we could not read, so every risk of that
 * shape is gated on `complete`.
 */

/** A PR open this long is worth raising out loud. */
const STALE_PR_DAYS = 7;
const VERY_STALE_PR_DAYS = 14;
/** More than this many issues in progress at once is thrash, not throughput. */
const WIP_LIMIT = 3;
/** An "In Progress" issue untouched this long has stalled. */
const STALLED_ISSUE_DAYS = 5;
/** Being asked for this many reviews makes one person the bottleneck. */
const REVIEW_BOTTLENECK = 3;
/** How far behind schedule counts as behind, in percentage points. */
const BEHIND_TOLERANCE = 15;

const MAX_RISKS = 12;
const MAX_TALKING_POINTS = 8;

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function daysSince(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
}

/** Status categories Jira uses; anything else is treated as in-flight. */
function isDone(status: string): boolean {
  return /^(done|closed|resolved|complete)/i.test(status);
}
function isInProgress(status: string): boolean {
  return /(progress|review|testing|qa)/i.test(status);
}

/**
 * Sprint health: are we where the calendar says we should be?
 *
 * The comparison that matters is completion against *elapsed time*, not
 * completion on its own. "60% done" is excellent on day three and alarming on
 * day nine, and only one of those is worth a standup.
 */
function analyseSprint(payload: PreContextPayload): SprintHealth | undefined {
  const sprint = payload.jira?.sprint;
  const issues = payload.jira?.issues ?? [];
  if (!sprint && issues.length === 0) return undefined;

  const done = issues.filter((i) => isDone(i.status)).length;
  const issuesDonePct = pct(done, issues.length);

  const pointed = issues.filter((i) => typeof i.points === "number");
  const totalPoints = pointed.reduce((sum, i) => sum + (i.points ?? 0), 0);
  const donePoints = pointed
    .filter((i) => isDone(i.status))
    .reduce((sum, i) => sum + (i.points ?? 0), 0);
  const pointsDonePct = totalPoints > 0 ? pct(donePoints, totalPoints) : undefined;

  let elapsedPct: number | undefined;
  if (sprint?.start && sprint?.end) {
    const start = Date.parse(sprint.start);
    const end = Date.parse(sprint.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      elapsedPct = Math.max(
        0,
        Math.min(100, Math.round(((Date.now() - start) / (end - start)) * 100)),
      );
    }
  }

  // Points are the better signal when the team actually estimates; issue count
  // is the fallback, and it over-reports when one epic sits next to ten typos.
  const progress = pointsDonePct ?? issuesDonePct;

  let verdict: SprintHealth["verdict"] = "unknown";
  let note: string;

  if (elapsedPct === undefined) {
    verdict = "unknown";
    note = `${progress}% of the sprint's work is done. No start/end dates on the sprint, so there is nothing to compare that against.`;
  } else if (progress >= elapsedPct) {
    verdict = "ahead";
    note = `${progress}% complete with ${elapsedPct}% of the sprint elapsed — ahead of the line.`;
  } else if (elapsedPct - progress <= BEHIND_TOLERANCE) {
    verdict = "on_track";
    note = `${progress}% complete with ${elapsedPct}% elapsed — roughly on track.`;
  } else if (typeof sprint?.days_left === "number" && sprint.days_left <= 2) {
    verdict = "at_risk";
    note = `${progress}% complete with ${elapsedPct}% elapsed and ${sprint.days_left} day(s) left — the remainder will not land without a scope decision.`;
  } else {
    verdict = "behind";
    note = `${progress}% complete with ${elapsedPct}% elapsed — ${elapsedPct - progress} points behind the line.`;
  }

  const health: SprintHealth = {
    verdict,
    note,
    issues_total: issues.length,
    issues_done: done,
    issues_done_pct: issuesDonePct,
  };
  if (elapsedPct !== undefined) health.elapsed_pct = elapsedPct;
  if (pointsDonePct !== undefined) {
    health.points_total = totalPoints;
    health.points_done = donePoints;
    health.points_done_pct = pointsDonePct;
  }
  if (typeof sprint?.days_left === "number") health.days_left = sprint.days_left;
  if (sprint?.goal) health.goal = sprint.goal;

  return health;
}

/**
 * One row per person: what they shipped, what they are holding, what is stuck.
 *
 * This is the payload's most useful object by some distance, because it is
 * shaped like the meeting. A standup goes around the room; so does this.
 */
function analyseMembers(payload: PreContextPayload, complete: boolean): MemberAnalytics[] {
  const { roster, github, jira } = payload;

  const byRef = new Map<string, MemberAnalytics>();
  for (const person of roster) {
    byRef.set(person.ref, {
      ref: person.ref,
      name: person.name,
      role: person.role,
      commits: 0,
      prs_open: 0,
      prs_stale: 0,
      issues: 0,
      in_progress: 0,
      done: 0,
    });
  }

  // --- GitHub ---
  for (const [ref, count] of Object.entries(github?.commits_by_member ?? {})) {
    const m = byRef.get(ref);
    if (m) m.commits = count;
  }

  for (const pr of github?.open_prs ?? []) {
    const m = byRef.get(pr.author);
    if (!m) continue;
    m.prs_open++;
    if (pr.age_days >= STALE_PR_DAYS) m.prs_stale++;
  }

  for (const branch of github?.active_branches ?? []) {
    for (const author of branch.authors) {
      const m = byRef.get(author);
      if (!m) continue;
      (m.branches ??= []).push(branch.name);
    }
  }

  // Review load lands on the reviewer, not the author — it is the reviewer's
  // standup item.
  for (const pr of github?.open_prs ?? []) {
    for (const reviewer of pr.reviewers ?? []) {
      const m = byRef.get(reviewer);
      if (m) m.reviews_requested = (m.reviews_requested ?? 0) + 1;
    }
  }

  // --- Jira ---
  for (const issue of jira?.issues ?? []) {
    const m = issue.assignee ? byRef.get(issue.assignee) : undefined;
    if (!m) continue;
    m.issues++;
    if (isDone(issue.status)) m.done++;
    else if (isInProgress(issue.status)) m.in_progress++;
    if (typeof issue.points === "number") m.points = (m.points ?? 0) + issue.points;
  }

  // --- derived per-person signals ---
  for (const m of byRef.values()) {
    const signals: string[] = [];

    const touchedGitHub = m.commits > 0 || m.prs_open > 0;
    if (complete && !touchedGitHub && m.issues === 0) {
      signals.push("no activity in either GitHub or Jira this window");
    } else if (complete && !touchedGitHub && m.in_progress > 0) {
      // The most useful correlation in the payload: work claimed in Jira with
      // nothing to show for it in the repository.
      signals.push(`${m.in_progress} issue(s) in progress but no commits or PRs`);
    }

    if (m.in_progress > WIP_LIMIT) {
      signals.push(`${m.in_progress} issues in progress at once`);
    }
    if (m.prs_stale > 0) {
      signals.push(`${m.prs_stale} PR(s) open more than ${STALE_PR_DAYS} days`);
    }
    if ((m.reviews_requested ?? 0) >= REVIEW_BOTTLENECK) {
      signals.push(`${m.reviews_requested} reviews waiting on them`);
    }

    if (signals.length) m.signals = signals;
  }

  // Busiest first: the people with the most in flight are the ones a standup
  // spends its time on.
  return [...byRef.values()].sort(
    (a, b) =>
      b.in_progress + b.prs_open - (a.in_progress + a.prs_open) ||
      b.commits - a.commits ||
      a.ref.localeCompare(b.ref),
  );
}

/** Everything worth flagging, most serious first. */
function analyseRisks(
  payload: PreContextPayload,
  members: MemberAnalytics[],
  health: SprintHealth | undefined,
  complete: boolean,
): Risk[] {
  const risks: Risk[] = [];
  const { github, jira, slack } = payload;

  if (health?.verdict === "at_risk" || health?.verdict === "behind") {
    risks.push({
      kind: "sprint_pace",
      severity: health.verdict === "at_risk" ? "high" : "medium",
      detail: health.note,
    });
  }

  for (const pr of github?.open_prs ?? []) {
    if (pr.age_days < STALE_PR_DAYS) continue;
    risks.push({
      kind: "stale_pr",
      severity: pr.age_days >= VERY_STALE_PR_DAYS ? "high" : "medium",
      subject: `#${pr.num}`,
      detail:
        `PR #${pr.num} "${pr.title}" (${pr.author}) has been open ${pr.age_days} days` +
        (pr.reviewers?.length ? `, waiting on ${pr.reviewers.join(", ")}` : "") +
        (pr.draft ? " and is still a draft" : "") +
        ".",
    });
  }

  for (const issue of jira?.issues ?? []) {
    if (!isInProgress(issue.status)) continue;
    const idle = issue.updated ? daysSince(issue.updated) : null;
    if (idle !== null && idle >= STALLED_ISSUE_DAYS) {
      risks.push({
        kind: "stalled_issue",
        severity: idle >= STALLED_ISSUE_DAYS * 2 ? "high" : "medium",
        subject: issue.key,
        detail: `${issue.key} "${issue.summary}" has been ${issue.status} with no update for ${idle} days${issue.assignee ? ` (${issue.assignee})` : ""}.`,
      });
    }
  }

  for (const m of members) {
    if (m.in_progress > WIP_LIMIT) {
      risks.push({
        kind: "wip_overload",
        severity: "medium",
        subject: m.ref,
        detail: `${m.name} has ${m.in_progress} issues in progress at once — more than they can finish in parallel.`,
      });
    }
    if ((m.reviews_requested ?? 0) >= REVIEW_BOTTLENECK) {
      risks.push({
        kind: "review_bottleneck",
        severity: "medium",
        subject: m.ref,
        detail: `${m.reviews_requested} pull requests are waiting on ${m.name} to review.`,
      });
    }
    // Only assertable when the scans that would have shown activity all ran.
    if (complete && m.signals?.some((s) => s.startsWith("no activity"))) {
      risks.push({
        kind: "idle_member",
        severity: "low",
        subject: m.ref,
        detail: `No commits, PRs or sprint issues for ${m.name} in this window.`,
      });
    }
    if (complete && m.in_progress > 0 && m.commits === 0 && m.prs_open === 0) {
      risks.push({
        kind: "claimed_but_quiet",
        severity: "medium",
        subject: m.ref,
        detail: `${m.name} has ${m.in_progress} issue(s) in progress but nothing in the repository — worth asking what is blocking them.`,
      });
    }
  }

  if (jira?.unassigned_members?.length && complete) {
    risks.push({
      kind: "no_sprint_work",
      severity: "low",
      detail: `No sprint issues assigned to: ${jira.unassigned_members.join(", ")}.`,
    });
  }

  // A configuration problem rather than a delivery one, but it silently
  // degrades every future run, so it is worth surfacing where people look.
  if (slack?.members_missing?.length) {
    risks.push({
      kind: "config",
      severity: "low",
      detail: `Slack IDs not found in the channel (check the resource pool): ${slack.members_missing.join(", ")}.`,
    });
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  return risks.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, MAX_RISKS);
}

/**
 * The agenda: what a facilitator would actually raise, in order.
 *
 * Deliberately sentences rather than data. This is the one field the bot can
 * read out more or less verbatim, which is what makes it worth spending tokens
 * on when the same facts already exist in structured form above.
 */
function buildTalkingPoints(
  payload: PreContextPayload,
  members: MemberAnalytics[],
  health: SprintHealth | undefined,
  risks: Risk[],
): string[] {
  const points: string[] = [];

  if (health?.goal) points.push(`Sprint goal: ${health.goal}`);
  if (health) points.push(health.note);

  // At most two of any one kind.
  //
  // Without this the agenda degrades into six near-identical "PR open N days"
  // lines, which crowds out the stalled issue and the overloaded person — the
  // items nobody would otherwise notice. A standup wants breadth of problem,
  // not a sorted list of the same problem, so the rest are rolled into one
  // counted line and remain individually available under `risks`.
  const quota = new Map<string, number>();
  const takeVaried = (severity: Risk["severity"], perKind: number) => {
    let elided = 0;
    for (const risk of risks.filter((r) => r.severity === severity)) {
      const used = quota.get(risk.kind) ?? 0;
      if (used >= perKind) {
        elided++;
        continue;
      }
      quota.set(risk.kind, used + 1);
      points.push(risk.detail);
    }
    if (elided > 0) {
      points.push(`Plus ${elided} more ${severity}-severity item(s) — see the risk list.`);
    }
  };

  takeVaried("high", 2);

  const shipping = members.filter((m) => m.done > 0 || m.commits > 0).slice(0, 3);
  if (shipping.length) {
    points.push(
      `Moving: ${shipping
        .map(
          (m) =>
            `${m.name} (${[
              m.commits ? `${m.commits} commit(s)` : null,
              m.done ? `${m.done} issue(s) done` : null,
            ]
              .filter(Boolean)
              .join(", ")})`,
        )
        .join("; ")}.`,
    );
  }

  takeVaried("medium", 1);

  // The sprint verdict arrives twice by construction — once as the headline and
  // again as the `sprint_pace` risk that reports the same sentence. Every line
  // here is spent from the bot's context, so pay for each one once.
  const seen = new Set<string>();
  return points
    .filter((line) => {
      const key = line.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_TALKING_POINTS);
}

/**
 * Builds the whole analysis.
 *
 * `complete` says whether every configured source answered. It gates every
 * conclusion drawn from an absence — without it a failed GitHub call would be
 * reported to the meeting as a team that did no work.
 */
export function analyse(payload: PreContextPayload, complete: boolean): Analysis {
  const sprint = analyseSprint(payload);
  const per_member = analyseMembers(payload, complete);
  const risks = analyseRisks(payload, per_member, sprint, complete);
  const talking_points = buildTalkingPoints(payload, per_member, sprint, risks);

  const analysis: Analysis = {
    per_member,
    risks,
    talking_points,
    totals: {
      members: payload.roster.length,
      commits: per_member.reduce((n, m) => n + m.commits, 0),
      open_prs: payload.github?.open_prs.length ?? 0,
      stale_prs: per_member.reduce((n, m) => n + m.prs_stale, 0),
      issues: payload.jira?.issues.length ?? 0,
      in_progress: per_member.reduce((n, m) => n + m.in_progress, 0),
    },
    // Says out loud whether absences in this analysis can be trusted, so the
    // bot can hedge when a source failed instead of asserting silence.
    complete,
  };
  if (sprint) analysis.sprint = sprint;
  return analysis;
}

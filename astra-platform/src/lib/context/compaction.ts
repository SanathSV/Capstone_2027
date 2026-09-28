import type { PreContextPayload } from "./types";

/**
 * Context engineering, in one place.
 *
 * The payload is injected into the bot container at launch and sits in the
 * model's context for the whole meeting. Raw API output does not fit that
 * budget: a busy repository returns hundreds of PRs, a Jira board thousands of
 * issues, and most of it is irrelevant to a fifteen-minute standup. So every
 * adapter trims against these limits as it goes, and `finalise()` does a last
 * pass over the assembled object.
 *
 * The limits below are deliberately in one exported constant: raising the
 * budget is a single edit, and the payload records what it dropped so a thin
 * result is never mistaken for an empty backlog.
 */
export const LIMITS = {
  /** Open PRs kept, newest-updated first. */
  pullRequests: 20,
  /** Commits kept from the window. */
  commits: 30,
  /** Jira issues kept from the active sprint. */
  issues: 50,
  /** How far back commit history is fetched. */
  commitWindowDays: 14,
  /**
   * Branches scanned for commits, most recently updated first.
   *
   * `GET /commits` without a `sha` only ever returns the default branch, which
   * is precisely the wrong half of the picture for a standup: the work being
   * discussed is almost always still on a feature branch. So every branch is
   * scanned, and this caps how many — one extra request each, and a repository
   * with 300 stale branches should not turn one click into 300 calls.
   */
  branches: 25,
  /** Character ceilings — long text is where the token budget disappears. */
  titleChars: 110,
  commitMsgChars: 100,
  summaryChars: 110,
  descriptionChars: 200,
  /**
   * Hard ceiling on the serialised payload. A ConfigMap tops out at 1 MiB and
   * the model's budget bites long before that, so 96 KB is the practical line.
   */
  maxBytes: 96 * 1024,
} as const;

/** Single-line, ellipsised, whitespace-collapsed. */
export function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** ~4 characters per token is close enough for a budgeting hint. */
export function estimateTokens(serialised: string): number {
  return Math.ceil(serialised.length / 4);
}

/**
 * Drops nulls, undefineds and empty arrays/objects recursively.
 *
 * `"reviews": null` costs tokens and teaches the model nothing; an absent key
 * says the same thing for free.
 *
 * NOTE: do not run this over the `meta` block. There, an empty array is the
 * message — `truncated: []` means "nothing was dropped" — and consumers read
 * `meta.truncated.length` directly. `generatePreContext` reattaches the
 * original meta after pruning for exactly this reason.
 */
export function prune<T>(value: T): T {
  if (Array.isArray(value)) {
    const items = value.map(prune).filter((v) => v !== undefined && v !== null);
    return items as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = prune(raw);
      if (cleaned === null || cleaned === undefined) continue;
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      if (
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        Object.keys(cleaned as object).length === 0
      ) {
        continue;
      }
      out[key] = cleaned;
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Last-resort shrink, applied only if the payload is still over budget after
 * per-source trimming — a 40-person team can blow the ceiling on roster alone.
 *
 * Order matters: commits are the most redundant thing in the payload (the PR
 * list already says what is in flight), issues the least, because the sprint
 * board *is* the standup agenda.
 */
export function enforceBudget(payload: PreContextPayload): PreContextPayload {
  const size = () => Buffer.byteLength(JSON.stringify(payload), "utf8");

  const steps: { name: string; apply: () => boolean }[] = [
    {
      name: "commits halved",
      apply: () => {
        const commits = payload.github?.recent_commits;
        if (!commits || commits.length <= 5) return false;
        const keep = Math.max(5, Math.floor(commits.length / 2));
        payload.github!.recent_commits = commits.slice(0, keep);
        return true;
      },
    },
    {
      name: "PR list halved",
      apply: () => {
        const prs = payload.github?.open_prs;
        if (!prs || prs.length <= 5) return false;
        payload.github!.open_prs = prs.slice(0, Math.max(5, Math.floor(prs.length / 2)));
        return true;
      },
    },
    {
      name: "issues halved",
      apply: () => {
        const issues = payload.jira?.issues;
        if (!issues || issues.length <= 10) return false;
        payload.jira!.issues = issues.slice(0, Math.max(10, Math.floor(issues.length / 2)));
        return true;
      },
    },
  ];

  // Defensive: a payload assembled by something other than generatePreContext
  // (a replay of a stored run, say) may not carry the array we push into.
  if (!Array.isArray(payload.meta?.truncated)) {
    payload.meta = { ...payload.meta, truncated: [] };
  }

  let guard = 12; // every step shrinks or reports false, but never loop forever
  while (size() > LIMITS.maxBytes && guard-- > 0) {
    const step = steps.find((s) => s.apply());
    if (!step) break; // nothing left to shed
    payload.meta.truncated.push(`budget: ${step.name} to fit ${LIMITS.maxBytes / 1024}KB`);
  }

  return payload;
}

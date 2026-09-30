import type { PreContextPayload } from "./types";

/**
 * Renders the payload as Markdown.
 *
 * JSON is a poor way to spend a context window. Every object repeats its keys
 * on every row, and braces, quotes and commas are all tokens that carry no
 * meaning to a reader — a thirty-commit list pays for `"author":` thirty times.
 * A table states each column name once.
 *
 * It is also what the model is best at. Markdown tables and headings are
 * overwhelmingly what these models saw during training; a nested JSON object
 * has to be parsed before it can be reasoned about, and parsing costs
 * attention that the meeting needs.
 *
 * So the structured payload remains the internal representation — the analysis
 * is computed from it, the audit row stores it — and this is what actually
 * ships to the bot.
 *
 * The one rule throughout: **omit empty sections entirely**. A heading with
 * "none" under it costs tokens to say nothing, and an absent section already
 * says it. Anything genuinely ambiguous (a source that failed rather than
 * returned nothing) is stated in the Notes section at the end.
 */

/** Escapes the pipe that would otherwise break a table row. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(headers: string[], rows: unknown[][]): string[] {
  if (rows.length === 0) return [];
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
}

export function renderPreContextMarkdown(payload: PreContextPayload): string {
  const out: string[] = [];
  const { team, roster, github, jira, slack, analysis, meta } = payload;

  // --- header --------------------------------------------------------------
  out.push(`# ${team.name}`);
  const facts: string[] = [];
  if (team.sprint) facts.push(`**Sprint:** ${team.sprint}`);
  if (team.leader) facts.push(`**Leader:** ${team.leader}`);
  if (facts.length) out.push(facts.join(" · "));
  if (team.description) out.push(`\n${team.description}`);

  // --- the verdict, first, because it is the most useful line --------------
  if (analysis?.sprint) {
    out.push("", "## Sprint");
    if (analysis.sprint.goal) out.push(`**Goal:** ${analysis.sprint.goal}`);
    out.push(analysis.sprint.note);
  } else if (jira?.sprint) {
    out.push("", "## Sprint");
    const s = jira.sprint;
    out.push(
      `**${s.name}** (${s.state})` +
        (typeof s.days_left === "number"
          ? s.days_left >= 0
            ? ` · ${s.days_left}d remaining`
            : ` · ended ${Math.abs(s.days_left)}d ago`
          : ""),
    );
    if (s.goal) out.push(`**Goal:** ${s.goal}`);
  }

  // --- the agenda ----------------------------------------------------------
  if (analysis?.talking_points?.length) {
    out.push("", "## Agenda");
    analysis.talking_points.forEach((point, i) => out.push(`${i + 1}. ${point}`));
  }

  // --- the room ------------------------------------------------------------
  // Per-member analytics when we have them, the plain cross-walk when we do
  // not. Never both: they are the same people, and the roster's handles are
  // only interesting to a human debugging the setup, not to the bot mid-meeting.
  if (analysis?.per_member?.length) {
    out.push("", "## Team");
    out.push(
      ...table(
        ["Person", "Role", "Commits", "PRs", "Reviews", "Doing", "Done"],
        analysis.per_member.map((m) => [
          m.name,
          m.role,
          m.commits || "—",
          m.prs_open ? `${m.prs_open}${m.prs_stale ? ` (${m.prs_stale} stale)` : ""}` : "—",
          m.reviews_requested || "—",
          m.in_progress || "—",
          m.done || "—",
        ]),
      ),
    );
    const flagged = analysis.per_member.filter((m) => m.signals?.length);
    if (flagged.length) {
      out.push("");
      for (const m of flagged) out.push(`- **${m.name}**: ${m.signals!.join("; ")}`);
    }
  } else if (roster.length) {
    out.push("", "## Team");
    out.push(...table(["Person", "Role"], roster.map((p) => [p.name, p.role])));
  }

  // --- risks ---------------------------------------------------------------
  if (analysis?.risks?.length) {
    out.push("", "## Risks");
    for (const risk of analysis.risks) {
      out.push(`- **${risk.severity}** · ${risk.detail}`);
    }
  }

  // --- github --------------------------------------------------------------
  if (github) {
    out.push("", `## GitHub — ${github.repo}`);

    if (github.open_prs?.length) {
      out.push("", "### Open pull requests");
      out.push(
        ...table(
          ["#", "Title", "Author", "Age", "Waiting on"],
          github.open_prs.map((pr) => [
            pr.num,
            `${pr.title}${pr.draft ? " _(draft)_" : ""}`,
            pr.author,
            `${pr.age_days}d`,
            pr.reviewers?.join(", "),
          ]),
        ),
      );
    }

    if (github.active_branches?.length) {
      out.push("", "### Unmerged work");
      out.push(
        ...table(
          ["Branch", "Commits", "Who"],
          github.active_branches.map((b) => [b.name, b.commits, b.authors.join(", ")]),
        ),
      );
    }

    if (github.recent_commits?.length) {
      out.push("", `### Commits (last ${github.window_days}d)`);
      out.push(
        ...table(
          ["Date", "Who", "Branch", "Message"],
          github.recent_commits.map((c) => [c.at, c.author, c.branch ?? "main", c.msg]),
        ),
      );
    }
  }

  // --- jira ----------------------------------------------------------------
  if (jira?.issues?.length) {
    out.push("", `## Jira — ${jira.project}`);
    if (jira.status_counts) {
      out.push(
        Object.entries(jira.status_counts)
          .map(([k, v]) => `${v} ${k}`)
          .join(" · "),
      );
    }
    out.push("");
    out.push(
      ...table(
        ["Key", "Status", "Assignee", "Pts", "Summary"],
        jira.issues.map((i) => [i.key, i.status, i.assignee, i.points, i.summary]),
      ),
    );
  }

  // --- notes ---------------------------------------------------------------
  // Everything that would otherwise be an unexplained absence.
  const notes: string[] = [];

  if (analysis && !analysis.complete) {
    notes.push(
      "At least one source failed. Nothing here should be read as proof that " +
        "someone did no work — it may be a gap in the data.",
    );
  }
  for (const [name, outcome] of Object.entries(meta?.sources ?? {})) {
    if (outcome.skipped) notes.push(`${name}: ${outcome.skipped}`);
    else if (!outcome.ok) notes.push(`${name} FAILED: ${outcome.error}`);
  }
  if (github?.quiet_members?.length) {
    notes.push(`No commits in the window from: ${github.quiet_members.join(", ")}.`);
  }
  if (jira?.unassigned_members?.length) {
    notes.push(`No sprint issues assigned to: ${jira.unassigned_members.join(", ")}.`);
  }
  if (slack?.members_missing?.length) {
    notes.push(
      `Slack IDs not found in the channel: ${slack.members_missing.join(", ")}.`,
    );
  }
  for (const line of meta?.truncated ?? []) notes.push(line);

  if (notes.length) {
    out.push("", "## Notes");
    for (const note of notes) out.push(`- ${note}`);
  }

  // A single trailing line so the bot knows how old this is and what produced it.
  out.push(
    "",
    `_Generated ${meta?.generated_at ?? "unknown"} · Astra pre-context._`,
  );

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

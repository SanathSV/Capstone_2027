"use client";

import type { Analysis, Risk } from "@/lib/context/types";

/**
 * The analysis, rendered.
 *
 * Deliberately not a chart. The data here is a handful of counts and a list of
 * sentences: the job is "read this before the meeting", not "explore a
 * dataset", and a bar chart of four people's commit counts would be decoration
 * that costs more space than the numbers themselves.
 *
 * The one graphical element is the sprint meter, because it encodes the single
 * comparison that is genuinely hard to read as text — completion *against
 * elapsed time*. Severity is carried by an icon and a word as well as colour,
 * never colour alone.
 */

const SEVERITY = {
  high: {
    label: "High",
    ring: "border-signal-red/30 bg-signal-red/5",
    text: "text-signal-red",
    glyph: "▲",
  },
  medium: {
    label: "Medium",
    ring: "border-signal-amber/30 bg-signal-amber/5",
    text: "text-signal-amber",
    glyph: "▲",
  },
  low: {
    label: "Low",
    ring: "border-ink-700 bg-ink-900/60",
    text: "text-slate-400",
    glyph: "●",
  },
} as const;

const VERDICT = {
  ahead: { label: "Ahead", text: "text-signal-green", bar: "bg-signal-green" },
  on_track: { label: "On track", text: "text-signal-green", bar: "bg-signal-green" },
  behind: { label: "Behind", text: "text-signal-amber", bar: "bg-signal-amber" },
  at_risk: { label: "At risk", text: "text-signal-red", bar: "bg-signal-red" },
  unknown: { label: "Unknown", text: "text-slate-400", bar: "bg-slate-500" },
} as const;

export function AnalysisView({ analysis }: { analysis: Analysis }) {
  const { sprint, per_member, risks, talking_points, totals, complete } = analysis;

  return (
    <div className="space-y-4">
      {!complete && (
        <p className="rounded-lg border border-signal-amber/30 bg-signal-amber/5 px-4 py-2.5 text-[11px] leading-relaxed text-signal-amber">
          At least one source failed, so this analysis draws no conclusions from
          absences — &ldquo;nobody heard from X&rdquo; would be a gap in the data rather
          than a fact.
        </p>
      )}

      {sprint && <SprintMeter sprint={sprint} />}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Members" value={totals.members} />
        <Stat label="Commits" value={totals.commits} />
        <Stat label="Open PRs" value={totals.open_prs} />
        <Stat label="Stale PRs" value={totals.stale_prs} warn={totals.stale_prs > 0} />
        <Stat label="Sprint issues" value={totals.issues} />
        <Stat label="In progress" value={totals.in_progress} />
      </div>

      {talking_points.length > 0 && (
        <section className="rounded-lg border border-astra-500/25 bg-astra-500/5 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-astra-300">
            Agenda
          </h3>
          <ol className="space-y-1.5">
            {talking_points.map((point, i) => (
              <li key={i} className="flex gap-2.5 text-xs leading-relaxed text-slate-200">
                <span className="font-mono text-[10px] text-astra-400">{i + 1}</span>
                {point}
              </li>
            ))}
          </ol>
        </section>
      )}

      {per_member.length > 0 && <MemberTable members={per_member} />}

      {risks.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Risks ({risks.length})
          </h3>
          <ul className="space-y-1.5">
            {risks.map((risk, i) => (
              <RiskRow key={i} risk={risk} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Two bars on one baseline: how much of the sprint has elapsed, and how much of
 * the work is done. The gap between them IS the finding, which is why they are
 * stacked rather than side by side — a reader compares lengths from a shared
 * left edge far more accurately than across a gap.
 */
function SprintMeter({ sprint }: { sprint: NonNullable<Analysis["sprint"]> }) {
  const verdict = VERDICT[sprint.verdict] ?? VERDICT.unknown;
  const done = sprint.points_done_pct ?? sprint.issues_done_pct;
  const elapsed = sprint.elapsed_pct;

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900/60 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Sprint health
        </h3>
        <span className={`text-xs font-medium ${verdict.text}`}>
          {verdict.label}
          {typeof sprint.days_left === "number" && (
            <span className="ml-2 font-normal text-slate-500">
              {sprint.days_left >= 0
                ? `${sprint.days_left}d left`
                : `ended ${Math.abs(sprint.days_left)}d ago`}
            </span>
          )}
        </span>
      </div>

      <div className="space-y-2">
        <Meter
          label="Work done"
          value={done}
          barClass={verdict.bar}
          caption={
            sprint.points_total
              ? `${sprint.points_done}/${sprint.points_total} points`
              : `${sprint.issues_done}/${sprint.issues_total} issues`
          }
        />
        {typeof elapsed === "number" && (
          <Meter
            label="Time elapsed"
            value={elapsed}
            barClass="bg-slate-500"
            caption="of the sprint window"
          />
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-300">{sprint.note}</p>
      {sprint.goal && (
        <p className="mt-2 border-t border-ink-700 pt-2 text-xs leading-relaxed text-slate-400">
          <span className="text-slate-500">Goal: </span>
          {sprint.goal}
        </p>
      )}
    </section>
  );
}

function Meter({
  label,
  value,
  barClass,
  caption,
}: {
  label: string;
  value: number;
  barClass: string;
  caption: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-[11px] text-slate-500">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-800">
        <div
          // 4px rounded end, anchored to the baseline at the left.
          className={`h-full rounded-full ${barClass}`}
          style={{ width: `${Math.max(1, Math.min(100, value))}%` }}
        />
      </div>
      <span className="w-32 shrink-0 text-right text-[11px] text-slate-500">
        <span className="font-mono text-slate-300">{value}%</span> · {caption}
      </span>
    </div>
  );
}

/** The room, in order. Busiest first — that is who the standup spends time on. */
function MemberTable({ members }: { members: Analysis["per_member"] }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Per person
      </h3>
      <div className="overflow-x-auto rounded-lg border border-ink-700">
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="border-b border-ink-700 bg-ink-900/60 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 text-right font-medium">Commits</th>
              <th className="px-3 py-2 text-right font-medium">PRs</th>
              <th className="px-3 py-2 text-right font-medium">Reviews</th>
              <th className="px-3 py-2 text-right font-medium">In progress</th>
              <th className="px-3 py-2 text-right font-medium">Done</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {members.map((m) => (
              <tr key={m.ref} className="align-top">
                <td className="px-3 py-2">
                  <div className="text-slate-200">{m.name}</div>
                  <div className="text-[10px] text-slate-500">{m.role}</div>
                  {m.signals?.map((signal, i) => (
                    <div key={i} className="mt-1 text-[10px] leading-relaxed text-signal-amber">
                      {signal}
                    </div>
                  ))}
                </td>
                <Num value={m.commits} />
                <Num value={m.prs_open} warn={m.prs_stale > 0} suffix={m.prs_stale ? ` (${m.prs_stale} stale)` : ""} />
                <Num value={m.reviews_requested ?? 0} />
                <Num value={m.in_progress} />
                <Num value={m.done} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Num({
  value,
  warn,
  suffix = "",
}: {
  value: number;
  warn?: boolean;
  suffix?: string;
}) {
  return (
    <td
      className={`px-3 py-2 text-right font-mono ${
        warn ? "text-signal-amber" : value === 0 ? "text-slate-600" : "text-slate-300"
      }`}
    >
      {value}
      {suffix && <span className="text-[10px]">{suffix}</span>}
    </td>
  );
}

function RiskRow({ risk }: { risk: Risk }) {
  const look = SEVERITY[risk.severity];
  return (
    <li className={`flex gap-2.5 rounded-lg border px-3 py-2 ${look.ring}`}>
      <span className={`text-[10px] leading-5 ${look.text}`} aria-hidden="true">
        {look.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className={`text-[10px] font-medium uppercase tracking-wide ${look.text}`}>
            {look.label}
          </span>
          <span className="font-mono text-[10px] text-slate-500">{risk.kind}</span>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-300">{risk.detail}</p>
      </div>
    </li>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2">
      <div
        className={`font-mono text-lg leading-tight ${
          warn ? "text-signal-amber" : "text-slate-100"
        }`}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

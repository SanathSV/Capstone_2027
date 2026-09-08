"use client";

import { InlineSpinner, useNavigation } from "./Navigation";
import type { TeamSummary } from "@/lib/db/types";

/**
 * A team card on the dashboard.
 *
 * A client component because it wants the pending state in two places at once —
 * the card border and a spinner beside the name — which is more than
 * `ProgressLink`'s built-in affordance covers. `useNavigation()` is the escape
 * hatch for exactly this; the alternative, passing a render prop down from the
 * server page, is what caused "Functions are not valid as a child of Client
 * Components".
 *
 * The team itself arrives as plain serialisable data, so the page above stays a
 * server component and the query never moves to the browser.
 */
export function TeamCard({ team }: { team: TeamSummary }) {
  const { pendingHref, navigate } = useNavigation();
  const href = `/teams/${team.id}`;
  const pending = pendingHref === href;

  return (
    <a
      href={href}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
      className={`card pressable group flex flex-col gap-3 p-5 hover:border-astra-500/50 hover:bg-ink-800/80 ${
        pending ? "border-astra-500/60 bg-ink-800" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 font-medium text-white group-hover:text-astra-300">
          {team.name}
          {pending && <InlineSpinner className="h-3.5 w-3.5 text-astra-400" />}
        </h3>
        {team.i_lead ? (
          <span className="chip border-astra-500/30 bg-astra-500/10 text-astra-300">
            Leader
          </span>
        ) : (
          team.my_role && <span className="chip">{team.my_role}</span>
        )}
      </div>

      {team.description && (
        <p className="line-clamp-2 text-xs leading-relaxed text-slate-500">
          {team.description}
        </p>
      )}

      {team.sprint_name && (
        <p className="flex items-center gap-1.5 text-xs text-signal-violet">
          <SprintIcon />
          {team.sprint_name}
        </p>
      )}

      <div className="mt-auto flex items-center gap-3 border-t border-ink-700 pt-3 text-xs text-slate-500">
        <span>
          {team.member_count} member{team.member_count === 1 ? "" : "s"}
        </span>
        {!team.i_lead && team.leader && (
          <>
            <span className="text-ink-600">·</span>
            <span className="truncate">
              led by {team.leader.full_name ?? team.leader.email}
            </span>
          </>
        )}
      </div>
    </a>
  );
}

function SprintIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2.5" strokeLinecap="round" />
    </svg>
  );
}

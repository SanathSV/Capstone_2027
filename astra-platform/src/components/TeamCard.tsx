"use client";

import { InlineSpinner, useNavigation } from "./Navigation";
import { ChatButton } from "./TeamChat";
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
      className={`card-interactive pressable group relative flex flex-col gap-3 overflow-hidden p-6 ${
        pending ? "border-astra-300/50 bg-ink-800" : ""
      }`}
    >
      {/* A hairline of accent along the top edge, revealed on hover. Material
          uses a state layer for this; a top rule reads better on a card in a
          grid because it marks WHICH card without shifting any layout. */}
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-astra-500 to-signal-violet transition-opacity duration-200 ${
          pending ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      />

      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[15px] font-medium text-slate-100 transition-colors group-hover:text-astra-300">
          {team.name}
          {pending && <InlineSpinner className="h-3.5 w-3.5 text-astra-300" />}
        </h3>
        {team.i_lead ? (
          <span className="chip shrink-0 border-astra-300/25 bg-astra-500/15 text-astra-300">
            Leader
          </span>
        ) : (
          team.my_role && <span className="chip">{team.my_role}</span>
        )}
      </div>

      {team.description && (
        <p className="line-clamp-2 text-[13px] leading-relaxed text-slate-400">
          {team.description}
        </p>
      )}

      {team.sprint_name && (
        <p className="flex items-center gap-1.5 text-xs text-signal-violet">
          <SprintIcon />
          {team.sprint_name}
        </p>
      )}

      <div className="mt-auto flex items-center gap-2 border-t border-ink-700/70 pt-4 text-xs text-slate-400">
        <span>
          {team.member_count} member{team.member_count === 1 ? "" : "s"}
        </span>
        {!team.i_lead && team.leader && (
          <>
            <span className="text-slate-600">·</span>
            <span className="truncate">
              led by {team.leader.full_name ?? team.leader.email}
            </span>
          </>
        )}
        <span className="ml-auto shrink-0">
          <ChatButton teamId={team.id} />
        </span>
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

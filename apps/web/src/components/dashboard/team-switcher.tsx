"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { teams, type Team } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

/** Active-team dropdown. Selection is local until the teams API lands. */
export function TeamSwitcher() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Team>(teams[0]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-8 items-center gap-2 rounded-lg border border-slate-800/80 bg-slate-900/60 px-2.5",
          "text-xs font-medium text-slate-200 backdrop-blur-xl transition-colors",
          "hover:border-slate-700 hover:text-white",
        )}
      >
        <span className="flex h-4 w-4 items-center justify-center rounded bg-gradient-to-br from-indigo to-emerald/80 text-[9px] font-bold text-white">
          {active.initials}
        </span>
        <span className="max-w-[140px] truncate">{active.name}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-slate-500" aria-hidden />
      </button>

      {open ? (
        <ul
          role="listbox"
          className={cn(
            "absolute left-0 top-10 z-40 w-60 animate-slide-up overflow-hidden rounded-xl",
            "border border-slate-800/80 bg-slate-900/95 p-1 shadow-panel backdrop-blur-xl",
          )}
        >
          {teams.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                role="option"
                aria-selected={team.id === active.id}
                onClick={() => {
                  setActive(team);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-800/70"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-800 text-[9px] font-bold text-slate-300">
                  {team.initials}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs font-medium text-slate-100">{team.name}</span>
                  <span className="truncate text-[11px] text-slate-600">{team.plan}</span>
                </span>
                {team.id === active.id ? (
                  <Check className="h-3.5 w-3.5 text-indigo" aria-hidden />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

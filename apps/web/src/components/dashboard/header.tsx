"use client";

import { usePathname } from "next/navigation";
import { ChevronRight, Command } from "lucide-react";

import { GatewayStatus } from "@/components/dashboard/gateway-status";
import { TeamSwitcher } from "@/components/dashboard/team-switcher";
import { breadcrumbsFor } from "@/lib/navigation";

export function Header() {
  const pathname = usePathname();
  const crumbs = breadcrumbsFor(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-slate-800/80 bg-canvas/80 px-6 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-3">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={crumb} className="flex min-w-0 items-center gap-1.5">
                {index > 0 ? (
                  <ChevronRight className="h-3 w-3 shrink-0 text-slate-700" aria-hidden />
                ) : null}
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "truncate font-medium text-white" : "truncate text-slate-500"}
                >
                  {crumb}
                </span>
              </span>
            );
          })}
        </nav>

        <span className="h-4 w-px bg-slate-800" aria-hidden />
        <TeamSwitcher />
      </div>

      <div className="flex items-center gap-3">
        <GatewayStatus />
        <QuickSummonHint />
      </div>
    </header>
  );
}

/** Keyboard affordance for the (not yet built) command palette. */
function QuickSummonHint() {
  return (
    <div className="hidden items-center gap-2 rounded-lg border border-slate-800/80 bg-slate-900/60 px-2.5 py-1.5 backdrop-blur-xl md:flex">
      <span className="text-xs text-slate-500">Quick Summon</span>
      <kbd className="flex items-center gap-0.5 rounded border border-slate-700/70 bg-slate-800/80 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
        <Command className="h-2.5 w-2.5" aria-hidden />K
      </kbd>
    </div>
  );
}

import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";

export interface StatTileProps {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  /** Renders the value in emerald — used for the live-session count. */
  emphasis?: boolean;
}

export function StatTile({ label, value, hint, icon: Icon, emphasis = false }: StatTileProps) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
            {label}
          </span>
          <span
            className={`text-2xl font-semibold tracking-tight ${
              emphasis ? "text-emerald" : "text-white"
            }`}
          >
            {value}
          </span>
        </div>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800/80 bg-slate-950/60">
          <Icon className="h-4 w-4 text-slate-500" aria-hidden />
        </span>
      </div>
      <p className="mt-3 text-xs text-slate-600">{hint}</p>
    </Card>
  );
}

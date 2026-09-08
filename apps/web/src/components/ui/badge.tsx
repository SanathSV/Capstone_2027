import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "active" | "indigo" | "warning" | "danger";

const tones: Record<BadgeTone, string> = {
  neutral: "border-slate-700/70 bg-slate-800/60 text-slate-400",
  active: "border-emerald/30 bg-emerald/10 text-emerald",
  indigo: "border-indigo/30 bg-indigo/10 text-indigo",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  danger: "border-red-500/30 bg-red-500/10 text-red-400",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Adds a leading dot — pulsing for the `active` tone. */
  dot?: boolean;
}

export function Badge({ className, tone = "neutral", dot = false, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
        "text-[11px] font-medium leading-5 tracking-tight",
        tones[tone],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span className="relative flex h-1.5 w-1.5">
          {tone === "active" ? (
            <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-emerald" />
          ) : null}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

/** Glowing gradient badge used in the sidebar header. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex h-8 w-8 shrink-0 items-center justify-center", className)}>
      <span className="absolute inset-0 rounded-lg bg-gradient-to-br from-indigo via-indigo/70 to-emerald opacity-90 blur-[6px]" />
      <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo to-emerald/80 shadow-glow">
        <Sparkles className="h-4 w-4 text-white" aria-hidden />
      </span>
    </span>
  );
}

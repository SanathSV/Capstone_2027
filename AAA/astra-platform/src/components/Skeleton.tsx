/**
 * Loading placeholders.
 *
 * These mirror the *shape* of the content they stand in for — a team card
 * skeleton is card-sized, a roster skeleton has rows — so the page does not
 * jump when the real data lands. A spinner in the middle of an empty page
 * would be less work and worse: it tells you something is happening but not
 * what is about to appear.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-ink-700/60 ${className}`}
      aria-hidden="true"
    />
  );
}

export function SkeletonCard() {
  return (
    <div className="card flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <div className="mt-2 flex gap-3 border-t border-ink-700 pt-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-28" />
      </div>
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-ink-700">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-2 w-12" />
        </div>
      ))}
    </div>
  );
}

/**
 * The page heading, shown while a route loads. Repeating it in the skeleton
 * keeps the header from popping into place a beat after everything else.
 */
export function SkeletonHeader() {
  return (
    <div className="mb-8 space-y-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-3.5 w-96 max-w-full" />
    </div>
  );
}

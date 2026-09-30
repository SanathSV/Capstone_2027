import { SkeletonHeader, SkeletonCard } from "@/components/Skeleton";

/**
 * Shown the instant a navigation to /dashboard starts, so a click always has a
 * visible consequence even when the query behind it is slow.
 */
export default function DashboardLoading() {
  return (
    <>
      <SkeletonHeader />
      {[0, 1].map((section) => (
        <section key={section} className="mb-10">
          <div className="mb-4 h-4 w-40 animate-pulse rounded bg-ink-700/60" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: section === 0 ? 3 : 2 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

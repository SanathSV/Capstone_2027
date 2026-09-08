import { SkeletonHeader, SkeletonRows, Skeleton } from "@/components/Skeleton";

export default function TeamLoading() {
  return (
    <>
      <SkeletonHeader />
      <div className="space-y-6">
        {/* The pre-context panel: the tallest thing on the page, so its
            placeholder is what stops the layout jumping. */}
        <div className="card overflow-hidden">
          <div className="flex items-start justify-between gap-4 border-b border-ink-700 bg-gradient-to-r from-astra-500/10 to-transparent p-5">
            <div className="space-y-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-80 max-w-full" />
            </div>
            <Skeleton className="h-9 w-44 rounded-lg" />
          </div>
          <div className="p-5">
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card overflow-hidden">
            <div className="border-b border-ink-700 p-5">
              <Skeleton className="h-4 w-24" />
            </div>
            <SkeletonRows rows={4} />
          </div>
          <div className="card overflow-hidden">
            <div className="border-b border-ink-700 p-5">
              <Skeleton className="h-4 w-28" />
            </div>
            <SkeletonRows rows={3} />
          </div>
        </div>
      </div>
    </>
  );
}

import { SkeletonHeader, SkeletonRows, Skeleton } from "@/components/Skeleton";

export default function DirectoryLoading() {
  return (
    <>
      <SkeletonHeader />
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="card space-y-4 p-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton className="h-9 w-full rounded-lg" />
          <div className="card overflow-hidden">
            <SkeletonRows rows={6} />
          </div>
        </div>
      </div>
    </>
  );
}

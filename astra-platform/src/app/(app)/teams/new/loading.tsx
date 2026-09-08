import { SkeletonHeader, Skeleton } from "@/components/Skeleton";

export default function NewTeamLoading() {
  return (
    <>
      <SkeletonHeader />
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-1 items-center gap-2">
              <Skeleton className="h-6 w-6 rounded-full" />
              <Skeleton className="h-3 w-20" />
              {i < 2 && <span className="h-px flex-1 bg-ink-700" />}
            </div>
          ))}
        </div>
        <div className="card space-y-5 p-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-2.5 w-28" />
              <Skeleton className={i === 1 ? "h-24 w-full rounded-lg" : "h-9 w-full rounded-lg"} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

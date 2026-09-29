import { Skeleton } from "@/components/ui/skeleton";

export function PageSkeleton({ rows = 8, tiles = 0 }: { rows?: number; tiles?: number }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-56" />
      {tiles > 0 && <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{Array.from({ length: tiles }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>}
      <div className="space-y-2">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { VideoSummary } from "../api/types";
import type { PagedState } from "../discovery/usePagedQuery";
import { EmptyState, ErrorState, GRID_CLASS, LoadingGrid } from "./StateViews";
import { VideoCard, type CardVariant } from "./VideoCard";

export function VideoGrid({
  items,
  onPlay,
  variant = "grid",
  className,
}: {
  items: VideoSummary[];
  onPlay?: (video: VideoSummary) => void;
  variant?: CardVariant;
  className?: string;
}) {
  return (
    <div className={cn(variant === "grid" ? GRID_CLASS : "flex flex-col gap-4", className)}>
      {items.map((video) => (
        <VideoCard key={`${video.source}:${video.id}`} video={video} onPlay={onPlay} variant={variant} />
      ))}
    </div>
  );
}

/** Loads the next page when the sentinel scrolls into view, like YouTube's endless lists. */
function AutoLoad({ onVisible, disabled }: { onVisible: () => void; disabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;
  useEffect(() => {
    const node = ref.current;
    if (!node || disabled || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) callback.current();
    }, { rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [disabled]);
  return <div ref={ref} aria-hidden="true" />;
}

/** A paged result list with loading, empty, error and real "load more" states. */
export function PagedResults({
  state,
  emptyTitle,
  emptyBody,
  onPlay,
  variant = "grid",
}: {
  state: PagedState;
  emptyTitle: string;
  emptyBody?: ReactNode;
  onPlay?: (video: VideoSummary) => void;
  variant?: CardVariant;
}) {
  if (state.loading) return <LoadingGrid variant={variant} count={variant === "grid" ? 8 : 5} />;
  if (state.error && state.items.length === 0) return <ErrorState error={state.error} onRetry={state.retry} />;
  if (state.page && state.items.length === 0) return <EmptyState title={emptyTitle}>{emptyBody}</EmptyState>;
  return (
    <>
      <VideoGrid items={state.items} onPlay={onPlay} variant={variant} />
      {state.error ? <ErrorState error={state.error} onRetry={state.loadMore} /> : null}
      {state.hasMore && !state.error ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <AutoLoad onVisible={state.loadMore} disabled={state.loadingMore} />
          {state.loadingMore ? (
            <span className="spinner small text-muted-foreground" role="status" aria-label="Loading more" />
          ) : (
            <Button variant="secondary" onClick={state.loadMore}>
              Load more
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}

import type { ReactNode } from "react";

import type { VideoSummary } from "../api/types";
import type { PagedState } from "../discovery/usePagedQuery";
import { VideoCard } from "./VideoCard";
import { EmptyState, ErrorState, LoadingGrid } from "./StateViews";

export function VideoGrid({ items, onPlay }: { items: VideoSummary[]; onPlay?: (video: VideoSummary) => void }) {
  return (
    <div className="grid">
      {items.map((video) => (
        <VideoCard key={`${video.source}:${video.id}`} video={video} onPlay={onPlay} />
      ))}
    </div>
  );
}

/** A paged result list with loading, empty, error and real "load more" states. */
export function PagedResults({
  state,
  emptyTitle,
  emptyBody,
  onPlay,
}: {
  state: PagedState;
  emptyTitle: string;
  emptyBody?: ReactNode;
  onPlay?: (video: VideoSummary) => void;
}) {
  if (state.loading) return <LoadingGrid />;
  if (state.error && state.items.length === 0) return <ErrorState error={state.error} onRetry={state.retry} />;
  if (state.page && state.items.length === 0) return <EmptyState title={emptyTitle}>{emptyBody}</EmptyState>;
  return (
    <>
      <VideoGrid items={state.items} onPlay={onPlay} />
      {state.error ? <ErrorState error={state.error} onRetry={state.loadMore} /> : null}
      {state.hasMore && !state.error ? (
        <div className="load-more">
          <button type="button" className="button ghost" onClick={state.loadMore} disabled={state.loadingMore}>
            {state.loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </>
  );
}

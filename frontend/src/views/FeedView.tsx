import { useCallback } from "react";

import { ChipBar } from "@/components/ChipBar";
import { VideoShelf } from "@/components/Shelf";
import { EmptyState, ErrorState, LoadingGrid } from "@/components/StateViews";
import { feedsApi } from "@/feeds/api";
import { FEEDS, useEnabledFeeds } from "@/feeds/feeds";
import { useLibrary } from "@/library/LibraryContext";
import { useCachedRequest } from "@/lib/useCachedRequest";

import { homeChips } from "./HomeView";
import { NotFoundView } from "./LibraryView";

/** One public YouTube topic page (Music, News, Live, Gaming) as shelves. */
export function FeedView({ id }: { id: string }) {
  const feed = FEEDS.find((f) => f.id === id);
  const { searches } = useLibrary();
  const { feeds } = useEnabledFeeds();
  const fetcher = useCallback((signal: AbortSignal) => feedsApi.get(id, signal), [id]);
  const { data, error, loading, retry } = useCachedRequest(feed ? `feed:${id}` : null, fetcher);
  if (!feed) return <NotFoundView />;
  const Icon = feed.icon;
  const shelves = data?.shelves.filter((s) => s.items.length > 0) ?? [];

  return (
    <div className="px-4 pb-12 sm:px-6">
      <ChipBar label="Topics" chips={homeChips(id, searches.slice(0, 4).map((s) => s.query), feeds)} />
      <header className="flex items-center gap-4 border-b border-border pb-6 pt-4 sm:gap-6">
        <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-secondary sm:size-20" aria-hidden="true">
          <Icon className="size-8 sm:size-10" strokeWidth={1.5} />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold sm:text-4xl">{feed.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{feed.blurb}</p>
        </div>
      </header>

      {loading ? <LoadingGrid count={8} className="pt-6" label={`Loading ${feed.title}…`} /> : null}
      {error ? <ErrorState error={error} onRetry={retry} /> : null}
      {data && shelves.length === 0 ? (
        <EmptyState title="Nothing to show right now">
          YouTube’s {feed.title} page had no videos that yt-canvas can play. Try again later.
        </EmptyState>
      ) : null}
      {shelves.map((shelf, i) => (
        <VideoShelf key={`${i}:${shelf.title}`} title={shelf.title ?? `More ${feed.title.toLowerCase()}`} items={shelf.items} rows={2} />
      ))}
    </div>
  );
}

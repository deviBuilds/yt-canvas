import { ChevronRight, History } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChipBar, type Chip } from "@/components/ChipBar";
import { useColumns, VideoShelf } from "@/components/Shelf";
import { EmptyState, LoadingGrid } from "@/components/StateViews";
import { AutoLoad, VideoGrid } from "@/components/VideoGrid";
import { feedsApi } from "@/feeds/api";
import { feedPath, FEEDS, useEnabledFeeds } from "@/feeds/feeds";
import { useCachedRequest } from "@/lib/useCachedRequest";

import { videoKey, type VideoSummary } from "../api/types";
import { discoveryApi } from "../discovery/api";
import { useLibrary } from "../library/LibraryContext";
import { Link, searchPath } from "../router/router";

/** Fixed keyword searches offered as chips; each one is an ordinary YouTube search. */
export const TOPIC_SHORTCUTS = [
  "Blender open movies",
  "NASA space footage",
  "Nature documentary",
  "Jazz live session",
  "Cooking basics",
  "Programming conference talks",
  "Classical music performance",
  "Science explained",
];

export function homeChips(activeFeed: string | null, searches: string[] = [], feeds = FEEDS): Chip[] {
  const seen = new Set<string>();
  const queries = [...searches, ...TOPIC_SHORTCUTS].filter((q) => {
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [
    { key: "all", label: "All", to: "/", active: activeFeed === null },
    ...feeds.map((feed) => ({ key: feed.id, label: feed.title, to: feedPath(feed.id), active: activeFeed === feed.id })),
    ...queries.map((q) => ({ key: `q:${q}`, label: q, to: searchPath(q) })),
  ];
}

function ViewAll({ to, label = "View all" }: { to: string; label?: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="text-link">
      <Link to={to}>
        {label} <ChevronRight />
      </Link>
    </Button>
  );
}

const NONE: VideoSummary[] = [];

// Each source of home videos, loaded once per session (see useCachedRequest).
function useFeedItems(id: string | null) {
  const fetcher = useCallback((signal: AbortSignal) => feedsApi.get(id ?? "", signal), [id]);
  const { data, loading } = useCachedRequest(id ? `feed:${id}` : null, fetcher);
  const items = useMemo(() => (data ? data.shelves.flatMap((shelf) => shelf.items) : NONE), [data]);
  return { items, loading };
}

function useChannelItems(ref: string | null) {
  const fetcher = useCallback((signal: AbortSignal) => discoveryApi.channel(ref ?? "", 0, signal), [ref]);
  const { data, loading } = useCachedRequest(ref ? `channel:${ref}` : null, fetcher);
  return { items: data?.items ?? NONE, loading };
}

function useSearchItems(query: string | null) {
  const fetcher = useCallback((signal: AbortSignal) => discoveryApi.search(query ?? "", 0, signal), [query]);
  const { data, loading } = useCachedRequest(query ? `search:${query}` : null, fetcher);
  return { items: data?.items ?? NONE, loading };
}

/** Round-robin over the sources, like YouTube's mixed home feed; drops repeats and what can't play. */
function interleave(lists: VideoSummary[][], skip: Set<string>): VideoSummary[] {
  const out: VideoSummary[] = [];
  const seen = new Set(skip);
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const video = list[i];
      if (!video || !video.available || video.live_status === "is_live" || video.live_status === "is_upcoming") continue;
      const key = videoKey(video);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(video);
    }
  }
  return out;
}

/** Channels the user watched most often in this browser, most-watched first. */
function topChannels(history: Array<{ video: VideoSummary }>, limit: number) {
  const counts = new Map<string, { name: string; count: number }>();
  for (const { video } of history) {
    const ref = video.channel?.ref;
    if (video.source !== "youtube" || !ref) continue;
    const entry = counts.get(ref) ?? { name: video.channel?.name ?? ref, count: 0 };
    entry.count++;
    counts.set(ref, entry);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([ref, { name }]) => ({ ref, name }));
}

// Show what has loaded after this long rather than waiting on a slow source.
const SETTLE_MS = 5000;

/**
 * YouTube's home: one continuous grid of videos, with "Continue watching" as a
 * special shelf after the first row. The grid mixes YouTube's public Music,
 * News, Live and Gaming pages with "more from" channels and the latest search
 * from this browser's history; yt-canvas never signs in, so nothing here is
 * YouTube's personal recommendation.
 */
export function HomeView() {
  const library = useLibrary();
  const { continueWatching, history, searches } = library;
  const { feeds, known } = useEnabledFeeds();
  // Wait for the server's list so a disabled feed is never requested.
  const feedOn = (id: string) => (known && feeds.some((feed) => feed.id === id) ? id : null);
  const channels = useMemo(() => topChannels(history, 2), [history]);

  const sources = [
    useChannelItems(channels[0]?.ref ?? null),
    useFeedItems(feedOn("music")),
    useFeedItems(feedOn("news")),
    useSearchItems(searches[0]?.query ?? null),
    useChannelItems(channels[1]?.ref ?? null),
    useFeedItems(feedOn("live")),
    useFeedItems(feedOn("gaming")),
  ];
  const lists = sources.map((source) => source.items);
  const settled = known && sources.every((source) => !source.loading);
  const watched = useMemo(() => new Set(history.map((h) => videoKey(h.video))), [history]);

  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Fix the order once everything has loaded (or SETTLE_MS passed), so cards don't
  // jump around; anything that arrives later goes to the end.
  const [order, setOrder] = useState<VideoSummary[] | null>(null);
  useEffect(() => {
    if (!settled && !timedOut) return;
    const mixed = interleave(lists, watched);
    setOrder((previous) => {
      if (!previous) return mixed;
      const have = new Set(previous.map(videoKey));
      const extra = mixed.filter((video) => !have.has(videoKey(video)));
      return extra.length ? [...previous, ...extra] : previous;
    });
    // ``lists`` holds memoized arrays, so their identities are the real dependencies.
  }, [settled, timedOut, watched, ...lists]);

  const { ref, columns } = useColumns();
  const [rows, setRows] = useState(4);
  const inProgress = useMemo(() => new Set(continueWatching.map((h) => videoKey(h.video))), [continueWatching]);
  const videos = (order ?? []).filter((video) => !inProgress.has(videoKey(video)));
  const first = videos.slice(0, columns);
  const rest = videos.slice(columns, columns * rows);
  const progress = useMemo(() => {
    const map = new Map(continueWatching.map((h) => [videoKey(h.video), h.duration ? h.position / h.duration : null]));
    return (video: VideoSummary) => map.get(videoKey(video)) ?? null;
  }, [continueWatching]);

  return (
    <div className="px-4 pb-12 sm:px-6">
      <ChipBar label="Topics" chips={homeChips(null, searches.slice(0, 4).map((s) => s.query), feeds)} />
      <div ref={ref}>
        {order === null ? <LoadingGrid count={columns * 2} className="pt-6" /> : null}
        {first.length > 0 ? <VideoGrid items={first} className="pt-6" /> : null}

        {continueWatching.length > 0 ? (
          <VideoShelf
            title="Continue watching"
            icon={<History className="size-6" aria-hidden="true" />}
            items={continueWatching.map((h) => h.video)}
            rows={1}
            progressFor={progress}
            onRemove={(video) => library.removeFromHistory(video)}
            removeLabel="Remove from history"
            action={<ViewAll to="/history" />}
          />
        ) : null}

        {rest.length > 0 ? <VideoGrid items={rest} className="pt-6" /> : null}
        {videos.length > columns * rows ? (
          <div className="py-8">
            <AutoLoad onVisible={() => setRows((n) => n + 4)} disabled={false} />
          </div>
        ) : null}

        {order !== null && videos.length === 0 && continueWatching.length === 0 ? (
          <EmptyState title="Try searching to get started">
            Start watching videos to build a feed of videos you’ll love.
          </EmptyState>
        ) : null}
      </div>
    </div>
  );
}

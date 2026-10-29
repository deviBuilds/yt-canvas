import { ChevronRight, History, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChipBar, type Chip } from "@/components/ChipBar";
import { useColumns, VideoShelf } from "@/components/Shelf";
import { EmptyState, LoadingGrid } from "@/components/StateViews";
import { AutoLoad, VideoGrid } from "@/components/VideoGrid";
import { feedsApi } from "@/feeds/api";
import { feedPath, FEEDS, useEnabledFeeds } from "@/feeds/feeds";
import { useCachedRequest } from "@/lib/useCachedRequest";
import { accountApi } from "@/account/api";
import { useMe } from "@/account/useMe";

import { videoKey, type VideoSummary } from "../api/types";
import { discoveryApi } from "../discovery/api";
import { usePagedQuery } from "../discovery/usePagedQuery";
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

export function homeChips(activeFeed: string | null, searches: string[] = [], feeds = FEEDS, accountChips: string[] = []): Chip[] {
  const seen = new Set<string>();
  const unique = (q: string) => {
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  // Signed in, the account's own home chips (each one a search here) come first, as on YouTube.
  const account = accountChips.filter(unique);
  const queries = [...searches, ...(account.length ? [] : TOPIC_SHORTCUTS)].filter(unique);
  return [
    { key: "all", label: "All", to: "/", active: activeFeed === null },
    ...account.map((q) => ({ key: `a:${q}`, label: q, to: searchPath(q) })),
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
  const { me, known: meKnown } = useMe();

  // Signed in (opt-in): YouTube's own recommendations, paged like YouTube's endless home.
  const recFetcher = useCallback((offset: number, signal: AbortSignal) => accountApi.feed("recommended", offset, signal), []);
  const rec = usePagedQuery(me.signed_in ? "me:recommended" : null, recFetcher);
  const personal = me.signed_in && !rec.error && (rec.loading || rec.items.length > 0);
  const recFailed = me.signed_in && rec.error !== null && rec.items.length === 0;

  // Otherwise (or if that fails) the mixed grid of public feeds and local picks.
  // Wait for the server's answers so nothing is requested twice or for nothing.
  const mixing = meKnown && (!me.signed_in || recFailed);
  const feedOn = (id: string) => (mixing && known && feeds.some((feed) => feed.id === id) ? id : null);
  const channels = useMemo(() => topChannels(history, 2), [history]);

  const sources = [
    useChannelItems(mixing ? (channels[0]?.ref ?? null) : null),
    useFeedItems(feedOn("music")),
    useFeedItems(feedOn("news")),
    useSearchItems(mixing ? (searches[0]?.query ?? null) : null),
    useChannelItems(mixing ? (channels[1]?.ref ?? null) : null),
    useFeedItems(feedOn("live")),
    useFeedItems(feedOn("gaming")),
  ];
  const lists = sources.map((source) => source.items);
  const settled = mixing && known && sources.every((source) => !source.loading);
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
    if (!mixing || (!settled && !timedOut)) return;
    const mixed = interleave(lists, watched);
    setOrder((previous) => {
      if (!previous) return mixed;
      const have = new Set(previous.map(videoKey));
      const extra = mixed.filter((video) => !have.has(videoKey(video)));
      return extra.length ? [...previous, ...extra] : previous;
    });
    // ``lists`` holds memoized arrays, so their identities are the real dependencies.
  }, [mixing, settled, timedOut, watched, ...lists]);

  const { ref, columns } = useColumns();
  const [rows, setRows] = useState(4);
  const inProgress = useMemo(() => new Set(continueWatching.map((h) => videoKey(h.video))), [continueWatching]);
  const source = personal ? rec.items : (order ?? []);
  const videos = source.filter((video) => !inProgress.has(videoKey(video)));
  const loading = personal ? rec.loading : order === null;
  const first = videos.slice(0, columns);
  const rest = personal ? videos.slice(columns) : videos.slice(columns, columns * rows);
  const progress = useMemo(() => {
    const map = new Map(continueWatching.map((h) => [videoKey(h.video), h.duration ? h.position / h.duration : null]));
    return (video: VideoSummary) => map.get(videoKey(video)) ?? null;
  }, [continueWatching]);

  return (
    <div className="px-4 pb-12 sm:px-6">
      <ChipBar
        label="Topics"
        chips={homeChips(null, searches.slice(0, 4).map((s) => s.query), feeds, me.signed_in ? me.chips : [])}
      />
      <div ref={ref}>
        {recFailed ? (
          <div className="mt-4 flex items-start gap-3 rounded-xl bg-secondary px-4 py-3 text-sm" role="status">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
            <p>
              Couldn’t load your YouTube recommendations: {rec.error?.message} Showing public videos instead.{" "}
              <Link to="/signin" className="text-link">
                Sign-in status
              </Link>
            </p>
          </div>
        ) : null}
        {loading ? <LoadingGrid count={columns * 2} className="pt-6" /> : null}
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
        {personal && rec.hasMore ? (
          <div className="flex justify-center py-8">
            <AutoLoad onVisible={rec.loadMore} disabled={rec.loadingMore} />
            {rec.loadingMore ? <span className="spinner small text-muted-foreground" role="status" aria-label="Loading more" /> : null}
          </div>
        ) : null}
        {!personal && videos.length > columns * rows ? (
          <div className="py-8">
            <AutoLoad onVisible={() => setRows((n) => n + 4)} disabled={false} />
          </div>
        ) : null}

        {!loading && videos.length === 0 && continueWatching.length === 0 ? (
          <EmptyState title="Try searching to get started">
            Start watching videos to build a feed of videos you’ll love.
          </EmptyState>
        ) : null}
      </div>
    </div>
  );
}

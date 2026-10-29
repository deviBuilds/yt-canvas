import { ChevronRight } from "lucide-react";
import { useCallback, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { ChipBar, type Chip } from "@/components/ChipBar";
import { Shelf, VideoShelf } from "@/components/Shelf";
import { LoadingGrid } from "@/components/StateViews";
import { feedsApi } from "@/feeds/api";
import { feedPath, FEEDS, useEnabledFeeds } from "@/feeds/feeds";
import { useCachedRequest } from "@/lib/useCachedRequest";

import type { VideoSummary } from "../api/types";
import { discoveryApi } from "../discovery/api";
import { useLibrary } from "../library/LibraryContext";
import { channelPath, Link, searchPath } from "../router/router";

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

function ShelfError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <Shelf title={title}>
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground" role="alert">
        <span>{message}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Shelf>
  );
}

function LoadingShelf({ title }: { title: string }) {
  return (
    <Shelf title={title}>
      <LoadingGrid count={4} label={`Loading ${title}…`} />
    </Shelf>
  );
}

/** The first shelf of a public YouTube feed, with a link to the whole feed. */
function FeedPreview({ id }: { id: string }) {
  const feed = FEEDS.find((f) => f.id === id)!;
  const fetcher = useCallback((signal: AbortSignal) => feedsApi.get(id, signal), [id]);
  const { data, error, loading, retry } = useCachedRequest(`feed:${id}`, fetcher);
  const Icon = feed.icon;
  if (loading) return <LoadingShelf title={feed.title} />;
  if (error) return <ShelfError title={feed.title} message={`Couldn't load ${feed.title} from YouTube: ${error.message}`} onRetry={retry} />;
  const shelf = data?.shelves.find((s) => s.items.length > 0);
  if (!shelf) return null;
  return (
    <VideoShelf
      title={shelf.title ?? feed.title}
      icon={<Icon className="size-6" aria-hidden="true" />}
      subtitle={`${feed.title} on YouTube`}
      items={shelf.items}
      rows={1}
      action={<ViewAll to={feedPath(id)} label={`More ${feed.title.toLowerCase()}`} />}
    />
  );
}

/** "More from <channel>": recommendations built only from this browser's history. */
function ChannelRecommendation({ channelRef, name, exclude }: { channelRef: string; name: string; exclude: Set<string> }) {
  const fetcher = useCallback((signal: AbortSignal) => discoveryApi.channel(channelRef, 0, signal), [channelRef]);
  const { data, loading } = useCachedRequest(`channel:${channelRef}`, fetcher);
  if (loading) return <LoadingShelf title={`More from ${name}`} />;
  const items = (data?.items ?? []).filter((v) => !exclude.has(v.id));
  if (items.length === 0) return null;
  return (
    <VideoShelf
      title={`More from ${name}`}
      subtitle="Because you watched this channel"
      items={items}
      rows={1}
      action={<ViewAll to={channelPath(channelRef)} />}
    />
  );
}

function SearchRecommendation({ query, exclude }: { query: string; exclude: Set<string> }) {
  const fetcher = useCallback((signal: AbortSignal) => discoveryApi.search(query, 0, signal), [query]);
  const { data, loading } = useCachedRequest(`search:${query}`, fetcher);
  if (loading) return <LoadingShelf title={`Because you searched “${query}”`} />;
  const items = (data?.items ?? []).filter((v) => !exclude.has(v.id));
  if (items.length === 0) return null;
  return (
    <VideoShelf
      title={`Because you searched “${query}”`}
      items={items}
      rows={1}
      action={<ViewAll to={searchPath(query)} />}
    />
  );
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

export function HomeView() {
  const library = useLibrary();
  const { feeds, known } = useEnabledFeeds();
  // Wait for the server's list so a disabled feed never flashes an error.
  const feedOn = (id: string) => known && feeds.some((feed) => feed.id === id);
  const { continueWatching, favorites, history, searches } = library;
  const watched = useMemo(() => new Set(history.map((h) => h.video.id)), [history]);
  const channels = useMemo(() => topChannels(history, 2), [history]);
  const lastSearch = searches[0]?.query;
  const progress = useMemo(() => {
    const map = new Map(continueWatching.map((h) => [`${h.video.source}:${h.video.id}`, h.duration ? h.position / h.duration : null]));
    return (video: VideoSummary) => map.get(`${video.source}:${video.id}`) ?? null;
  }, [continueWatching]);

  return (
    <div className="px-4 pb-12 sm:px-6">
      <ChipBar label="Topics" chips={homeChips(null, searches.slice(0, 4).map((s) => s.query), feeds)} />

      {continueWatching.length > 0 ? (
        <VideoShelf
          title="Continue watching"
          items={continueWatching.map((h) => h.video)}
          rows={1}
          progressFor={progress}
          onRemove={(video) => library.removeFromHistory(video)}
          removeLabel="Remove from history"
          action={<ViewAll to="/history" />}
        />
      ) : null}

      {feedOn("music") ? <FeedPreview id="music" /> : null}
      {channels[0] ? <ChannelRecommendation channelRef={channels[0].ref} name={channels[0].name} exclude={watched} /> : null}
      {feedOn("news") ? <FeedPreview id="news" /> : null}
      {lastSearch ? <SearchRecommendation query={lastSearch} exclude={watched} /> : null}
      {channels[1] ? <ChannelRecommendation channelRef={channels[1].ref} name={channels[1].name} exclude={watched} /> : null}
      {feedOn("live") ? <FeedPreview id="live" /> : null}

      {favorites.length > 0 ? (
        <VideoShelf title="Favorites" items={favorites.map((f) => f.video)} rows={1} action={<ViewAll to="/favorites" />} />
      ) : null}

      {feedOn("gaming") ? <FeedPreview id="gaming" /> : null}

      <p className="pt-6 text-xs text-muted-foreground">
        Shelves come from YouTube’s public Music, News, Live and Gaming pages. “More from” and “Because you searched”
        use only the history saved in this browser. yt-canvas never signs in to YouTube, so there are no personalized
        YouTube recommendations.
      </p>
    </div>
  );
}

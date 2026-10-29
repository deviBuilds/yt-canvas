import { ExternalLink, ListVideo, Play, Shuffle } from "lucide-react";
import { useCallback, useEffect } from "react";

import { ChannelAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

import type { VideoSummary } from "../api/types";
import { EmptyState } from "../components/StateViews";
import { PagedResults } from "../components/VideoGrid";
import { Thumbnail } from "../components/VideoCard";
import { discoveryApi } from "../discovery/api";
import { usePagedQuery } from "../discovery/usePagedQuery";
import { useLibrary } from "../library/LibraryContext";
import { useQueue } from "../queue/QueueContext";
import { channelPath, Link, useRouter, watchPath } from "../router/router";

const playableOnly = (items: VideoSummary[]) =>
  items.filter((item) => item.available && item.live_status !== "is_live" && item.live_status !== "is_upcoming");

function PlayAllButton({
  items,
  label,
  listId,
  variant = "primary",
  shuffle = false,
}: {
  items: VideoSummary[];
  label: string;
  listId?: string | null;
  variant?: "primary" | "secondary";
  shuffle?: boolean;
}) {
  const queue = useQueue();
  const { navigate } = useRouter();
  const playable = playableOnly(items);
  if (playable.length === 0) return null;
  return (
    <Button
      variant={variant}
      onClick={() => {
        const list = shuffle ? [...playable].sort(() => Math.random() - 0.5) : playable;
        const first = list[0]!;
        queue.playList(list, first, { label, listId });
        navigate(watchPath(first, { list: listId }));
      }}
    >
      {shuffle ? <Shuffle /> : <Play className="fill-current" />} {shuffle ? "Shuffle" : "Play all"}
    </Button>
  );
}

export function SearchView() {
  const { params } = useRouter();
  const q = (params.get("q") ?? "").trim();
  const { addSearch } = useLibrary();
  const fetcher = useCallback((offset: number, signal: AbortSignal) => discoveryApi.search(q, offset, signal), [q]);
  const state = usePagedQuery(q ? `search:${q}` : null, fetcher);

  useEffect(() => {
    if (state.page?.offset === 0 && state.items.length > 0) addSearch(q);
  }, [state.page, state.items.length, q, addSearch]);

  if (!q) return <EmptyState title="Search YouTube">Type keywords or paste a link in the search bar above.</EmptyState>;

  return (
    <div className="px-4 pb-6 sm:px-6">
      {/* YouTube's search page opens with a sticky row of filter chips. */}
      <header className="frosted sticky top-14 z-20 -mx-4 flex h-14 items-center justify-between gap-3 px-4 sm:-mx-6 sm:px-6">
        <h1 className="sr-only">Search results for “{q}”</h1>
        <span className="flex h-8 items-center rounded-lg bg-chip-active px-3 text-sm font-medium text-chip-active-foreground" aria-hidden="true">
          All
        </span>
        <PlayAllButton items={state.items} label={`Search: ${q}`} variant="secondary" />
      </header>
      <PagedResults
        state={state}
        variant="list"
        emptyTitle="No results found"
        emptyBody={<>Nothing matched “{q}”. Try different keywords or remove search filters.</>}
      />
    </div>
  );
}

export function ChannelView() {
  const { params } = useRouter();
  const ref = params.get("ref") ?? "";
  const fetcher = useCallback((offset: number, signal: AbortSignal) => discoveryApi.channel(ref, offset, signal), [ref]);
  const state = usePagedQuery(ref ? `channel:${ref}` : null, fetcher);
  const channel = state.page?.channel;
  const name = channel?.name ?? state.page?.title ?? ref;
  const avatar = channel?.avatar_url ?? state.items.find((v) => v.channel?.avatar_url)?.channel?.avatar_url;
  const external = ref.startsWith("UC") ? `https://www.youtube.com/channel/${ref}` : `https://www.youtube.com/${ref}`;

  if (!ref) return <EmptyState title="No channel selected" />;

  return (
    <div className="mx-auto max-w-[1074px] px-4 lg:px-0">
      <header className="flex flex-col items-center gap-4 pb-1 pt-4 text-center sm:flex-row sm:items-center sm:text-left">
        <ChannelAvatar name={name} src={avatar} className="size-24 text-4xl sm:size-40 sm:text-6xl" />
        <div className="min-w-0 flex-1">
          <p className="sr-only">Channel</p>
          <h1 className="text-3xl font-bold sm:text-4xl sm:leading-[50px]">{name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{channel?.handle ?? ref}</span>
            {state.page?.total_count ? ` • ${state.page.total_count} videos` : ""}
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
            <PlayAllButton items={state.items} label={`Channel: ${name}`} />
            <Button asChild variant="secondary">
              <a href={external} target="_blank" rel="noreferrer noopener">
                <ExternalLink /> Open on YouTube
              </a>
            </Button>
          </div>
        </div>
      </header>
      <div className="mb-6 flex h-12 gap-6 border-b border-border">
        <h2 className="flex items-center border-b-2 border-foreground text-base font-medium leading-[22px]">Videos</h2>
      </div>
      <PagedResults state={state} hideChannel emptyTitle="No videos" emptyBody="This channel has no public videos to list." />
    </div>
  );
}

export function PlaylistView() {
  const { params } = useRouter();
  const listId = params.get("list") ?? "";
  const queue = useQueue();
  const fetcher = useCallback((offset: number, signal: AbortSignal) => discoveryApi.playlist(listId, offset, signal), [listId]);
  const state = usePagedQuery(listId ? `playlist:${listId}` : null, fetcher);
  const page = state.page;
  const title = page?.title ?? "Playlist";
  const owner = page?.channel;
  const cover = state.items.find((v) => v.thumbnail_url);

  if (!listId) return <EmptyState title="No playlist selected" />;

  return (
    <div className="mx-auto flex max-w-[1284px] flex-col gap-6 px-4 py-4 sm:px-6 lg:flex-row lg:items-start">
      <header className="relative overflow-hidden rounded-2xl bg-gradient-to-b from-zinc-600 to-zinc-900 p-6 text-white lg:sticky lg:top-20 lg:w-90 lg:shrink-0">
        {cover ? (
          <Thumbnail video={cover} className="mb-4 shadow-lg" />
        ) : (
          <div className="mb-4 grid aspect-video place-items-center rounded-xl bg-black/30" aria-hidden="true">
            <ListVideo className="size-10" />
          </div>
        )}
        <p className="sr-only">Playlist</p>
        <h1 className="text-2xl font-bold leading-tight">{title}</h1>
        <p className="mt-3 text-sm font-medium">
          {owner?.ref ? (
            <Link to={channelPath(owner.ref)} className="hover:underline">
              {owner.name ?? owner.ref}
            </Link>
          ) : (
            owner?.name
          )}
        </p>
        <p className="mt-1 text-xs text-white/70">
          {page?.total_count !== null && page?.total_count !== undefined ? `${page.total_count} videos` : "Playlist"}
        </p>
        <div className="mt-4 flex gap-2 [&_button]:flex-1">
          <PlayAllButton items={state.items} label={title} listId={listId} />
          <PlayAllButton items={state.items} label={title} listId={listId} variant="secondary" shuffle />
        </div>
      </header>
      <div className="min-w-0 flex-1">
        <PagedResults
          state={state}
          variant="list"
          emptyTitle="This playlist is empty"
          onPlay={(video) => queue.playList(state.items, video, { label: title, listId })}
        />
      </div>
    </div>
  );
}

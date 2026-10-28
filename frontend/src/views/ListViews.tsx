import { useCallback, useEffect } from "react";

import type { VideoSummary } from "../api/types";
import { Icon } from "../components/Icon";
import { EmptyState } from "../components/StateViews";
import { PagedResults } from "../components/VideoGrid";
import { discoveryApi } from "../discovery/api";
import { usePagedQuery } from "../discovery/usePagedQuery";
import { useLibrary } from "../library/LibraryContext";
import { useQueue } from "../queue/QueueContext";
import { channelPath, Link, useRouter, watchPath } from "../router/router";

function PlayAllButton({ items, label, listId }: { items: VideoSummary[]; label: string; listId?: string | null }) {
  const queue = useQueue();
  const { navigate } = useRouter();
  const playable = items.filter((item) => item.available && item.live_status !== "is_live" && item.live_status !== "is_upcoming");
  if (playable.length === 0) return null;
  return (
    <button
      type="button"
      className="button"
      onClick={() => {
        const first = playable[0]!;
        queue.playList(playable, first, { label, listId });
        navigate(watchPath(first, { list: listId }));
      }}
    >
      <Icon name="play" size={18} /> Play all
    </button>
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
    <div className="list-view">
      <header className="list-header">
        <div>
          <p className="eyebrow">Search results</p>
          <h1>“{q}”</h1>
          <p className="muted small">YouTube keyword results, loaded one page at a time.</p>
        </div>
        <PlayAllButton items={state.items} label={`Search: ${q}`} />
      </header>
      <PagedResults state={state} emptyTitle="No results" emptyBody={<>Nothing matched “{q}”. Try different keywords.</>} />
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
  const external = ref.startsWith("UC") ? `https://www.youtube.com/channel/${ref}` : `https://www.youtube.com/${ref}`;

  if (!ref) return <EmptyState title="No channel selected" />;

  return (
    <div className="list-view">
      <header className="list-header">
        <div className="channel-head">
          <div className="avatar" aria-hidden="true">
            {(name.replace(/^@/, "")[0] ?? "?").toUpperCase()}
          </div>
          <div>
            <p className="eyebrow">Channel</p>
            <h1>{name}</h1>
            <p className="muted small">
              {channel?.handle ?? ref} ·{" "}
              <a href={external} target="_blank" rel="noreferrer noopener" className="text-link">
                Open on YouTube <Icon name="external" size={14} />
              </a>
            </p>
          </div>
        </div>
        <PlayAllButton items={state.items} label={`Channel: ${name}`} />
      </header>
      <h2 className="section-title">Videos</h2>
      <PagedResults state={state} emptyTitle="No videos" emptyBody="This channel has no public videos to list." />
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

  if (!listId) return <EmptyState title="No playlist selected" />;

  return (
    <div className="list-view">
      <header className="list-header">
        <div>
          <p className="eyebrow">Playlist</p>
          <h1>{title}</h1>
          <p className="muted small">
            {owner?.ref ? (
              <Link to={channelPath(owner.ref)} className="text-link">
                {owner.name ?? owner.ref}
              </Link>
            ) : (
              owner?.name
            )}
            {page?.total_count !== null && page?.total_count !== undefined ? ` · ${page.total_count} videos` : ""}
          </p>
        </div>
        <PlayAllButton items={state.items} label={title} listId={listId} />
      </header>
      <PagedResults
        state={state}
        emptyTitle="This playlist is empty"
        onPlay={(video) => queue.playList(state.items, video, { label: title, listId })}
      />
    </div>
  );
}

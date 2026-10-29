import { CircleUserRound, Play } from "lucide-react";
import { useCallback } from "react";

import { accountApi } from "@/account/api";
import { PERSONAL_FEEDS } from "@/account/feeds";
import { useMe } from "@/account/useMe";
import { Button } from "@/components/ui/button";

import { EmptyState, LoadingGrid } from "../components/StateViews";
import { Thumbnail } from "../components/VideoCard";
import { PagedResults } from "../components/VideoGrid";
import { usePagedQuery } from "../discovery/usePagedQuery";
import { useQueue } from "../queue/QueueContext";
import { Link, useRouter, watchPath } from "../router/router";

type Feed = keyof typeof PERSONAL_FEEDS;

/** A signed-in YouTube list, laid out the way YouTube lays out that page. */
export function PersonalFeedView({ id }: { id: Feed }) {
  const { me, known } = useMe();
  const { title, icon: Icon } = PERSONAL_FEEDS[id];
  const queue = useQueue();
  const { navigate } = useRouter();
  const fetcher = useCallback((offset: number, signal: AbortSignal) => accountApi.feed(id, offset, signal), [id]);
  const state = usePagedQuery(me.signed_in ? `me:${id}` : null, fetcher);

  if (!known) return <LoadingGrid className="px-6 pt-6" />;
  if (!me.signed_in) {
    return (
      <EmptyState
        title={`Sign in to see ${title.toLowerCase()}`}
        action={
          <Button asChild variant="outline">
            <Link to="/signin">
              <CircleUserRound /> Sign in
            </Link>
          </Button>
        }
      >
        {me.detail ?? "yt-canvas can use your YouTube session from your browser. It's off until you turn it on."}
      </EmptyState>
    );
  }

  const playable = state.items.filter((v) => v.available && v.live_status !== "is_live" && v.live_status !== "is_upcoming");
  const playAll = () => {
    const first = playable[0];
    if (!first) return;
    queue.playList(playable, first, { label: title });
    navigate(watchPath(first));
  };

  if (id === "subscriptions") {
    return (
      <div className="px-4 pb-12 sm:px-6">
        <h1 className="pb-4 pt-6 text-xl font-bold">Latest</h1>
        <PagedResults state={state} emptyTitle="No new videos" emptyBody="Videos from channels you subscribe to show up here." />
      </div>
    );
  }

  if (id === "history") {
    return (
      <div className="mx-auto max-w-[1096px] px-4 py-6 sm:px-6">
        <h1 className="mb-6 text-3xl font-bold">Watch history</h1>
        <PagedResults state={state} variant="list" emptyTitle="This list has no videos" />
      </div>
    );
  }

  // Watch later and Liked videos use YouTube's playlist layout.
  const cover = state.items.find((v) => v.thumbnail_url);
  return (
    <div className="mx-auto flex max-w-[1284px] flex-col gap-6 px-4 py-4 sm:px-6 lg:flex-row lg:items-start">
      <header className="relative overflow-hidden rounded-2xl bg-gradient-to-b from-zinc-600 to-zinc-900 p-6 text-white lg:sticky lg:top-20 lg:w-90 lg:shrink-0">
        {cover ? (
          <Thumbnail video={cover} className="mb-4 shadow-lg" />
        ) : (
          <div className="mb-4 grid aspect-video place-items-center rounded-xl bg-black/30" aria-hidden="true">
            <Icon className="size-10" />
          </div>
        )}
        <h1 className="text-2xl font-bold leading-tight">{title}</h1>
        <p className="mt-2 text-xs text-white/70">
          {state.page?.total_count !== null && state.page?.total_count !== undefined ? `${state.page.total_count} videos · ` : ""}
          Private
        </p>
        {playable.length > 0 ? (
          <Button className="mt-4 w-full bg-white text-black hover:bg-white/85" onClick={playAll}>
            <Play className="fill-current" /> Play all
          </Button>
        ) : null}
      </header>
      <div className="min-w-0 flex-1">
        <PagedResults
          state={state}
          variant="list"
          emptyTitle="This list has no videos"
          onPlay={(video) => queue.playList(state.items, video, { label: title })}
        />
      </div>
    </div>
  );
}

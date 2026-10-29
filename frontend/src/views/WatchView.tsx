import { ExternalLink, Heart, Keyboard, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChannelAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { feedsApi } from "@/feeds/api";
import { useCachedRequest } from "@/lib/useCachedRequest";
import { cn } from "@/lib/utils";

import { videoKey, type MediaInfo, type MediaRef, type VideoSummary } from "../api/types";
import { EmptyState, LoadingGrid } from "../components/StateViews";
import { Thumbnail, VideoCard } from "../components/VideoCard";
import { discoveryApi } from "../discovery/api";
import { useLibrary } from "../library/LibraryContext";
import { formatBytes, formatTime, formatViews } from "../lib/format";
import { CanvasPlayer, type DecoderStrategy } from "../player/CanvasPlayer";
import { SHORTCUT_HELP } from "../player/shortcuts";
import { PreparationPanel } from "../preparation/PreparationPanel";
import { usePreparation } from "../preparation/usePreparation";
import { useQueue } from "../queue/QueueContext";
import { channelPath, Link, useRouter, watchPath } from "../router/router";

const DECODER_STRATEGIES: DecoderStrategy[] = ["layered", "covered", "offscreen", "hidden"];

const PROCESSING_LABELS: Record<MediaInfo["processing"], string> = {
  remux: "remuxed, no re-encoding",
  transcode: "transcoded to H.264/AAC",
  transcode_audio: "audio converted to AAC",
  transcode_video: "video transcoded to H.264",
};

function placeholder(ref: MediaRef): VideoSummary {
  return {
    source: ref.source,
    id: ref.id,
    title: ref.source === "demo" ? "Demo media" : "YouTube video",
    channel: null,
    duration_seconds: null,
    thumbnail_url: ref.source === "youtube" ? `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg` : null,
    view_count: null,
    live_status: null,
    available: true,
    unavailable_reason: null,
  };
}

/** The current queue or playlist, like YouTube's playlist panel above "Up next". */
function QueuePanel() {
  const queue = useQueue();
  const { navigate } = useRouter();
  return (
    <aside className="mb-4 overflow-hidden rounded-xl border border-border" aria-labelledby="queue-title">
      <header className="flex items-start justify-between gap-3 bg-secondary px-4 py-3">
        <div className="min-w-0">
          <h2 id="queue-title" className="text-xl font-bold">
            Up next
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {queue.label ? `${queue.label} · ` : ""}
            {queue.index + 1} / {queue.items.length}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 pt-1 text-xs font-medium">
          Autoplay
          <Switch checked={queue.autoplay} onCheckedChange={queue.setAutoplay} aria-label="Autoplay" />
        </label>
      </header>
      <ol className="max-h-[400px] overflow-y-auto py-2">
        {queue.items.map((item, i) => {
          const current = i === queue.index;
          return (
            <li
              key={videoKey(item)}
              className={cn("group flex items-center gap-1 pr-2 hover:bg-secondary", current && "bg-secondary-hover/60")}
              aria-current={current ? "true" : undefined}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 pl-1 text-left"
                onClick={() => {
                  queue.select(item);
                  navigate(watchPath(item));
                }}
              >
                <span className="flex w-6 shrink-0 justify-center text-xs text-muted-foreground">
                  {current ? <Play className="size-3 fill-current" /> : i + 1}
                </span>
                <Thumbnail video={item} className="w-24 shrink-0 rounded-lg" />
                <span className="min-w-0">
                  <span className="line-clamp-2 text-sm font-medium leading-5">{item.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.channel?.name ?? ""}
                    {item.duration_seconds ? ` · ${formatTime(item.duration_seconds)}` : ""}
                  </span>
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                aria-label={`Remove “${item.title}” from queue`}
                onClick={() => queue.remove(item)}
              >
                <X />
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="border-t border-border px-2 py-1">
        <Button variant="ghost" size="sm" onClick={queue.clear}>
          Clear queue
        </Button>
      </div>
    </aside>
  );
}

/**
 * The side column's video list: YouTube's related videos when the backend can
 * read them, otherwise more from the same channel.
 */
function useRelated(video: VideoSummary, refKey: string | null) {
  const youtube = video.source === "youtube";
  const relatedFetcher = useCallback((signal: AbortSignal) => feedsApi.related(video.id, signal), [video.id]);
  const related = useCachedRequest(youtube ? `related:${video.id}` : null, relatedFetcher);
  const channelRef = video.channel?.ref ?? null;
  const fallback = youtube && (related.error !== null || (related.data !== null && related.data.items.length === 0));
  const channelFetcher = useCallback((signal: AbortSignal) => discoveryApi.channel(channelRef ?? "", 0, signal), [channelRef]);
  const channel = useCachedRequest(fallback && channelRef ? `channel:${channelRef}` : null, channelFetcher);
  const items = useMemo(() => {
    const source = related.data?.items.length ? related.data.items : (channel.data?.items ?? []);
    return source.filter((item) => videoKey(item) !== refKey && item.available && item.live_status !== "is_live" && item.live_status !== "is_upcoming");
  }, [related.data, channel.data, refKey]);
  return { items, loading: related.loading || channel.loading, fromChannel: !related.data?.items.length && items.length > 0 };
}

function RelatedList({ items, loading, fromChannel, channelName }: { items: VideoSummary[]; loading: boolean; fromChannel: boolean; channelName?: string | null }) {
  if (loading) return <LoadingGrid variant="compact" count={6} label="Loading related videos…" />;
  if (items.length === 0) return null;
  return (
    <section aria-label="Related videos" className="flex flex-col gap-2">
      {fromChannel ? <h2 className="pb-1 text-sm font-medium">More from {channelName ?? "this channel"}</h2> : null}
      {items.map((item) => (
        <VideoCard key={videoKey(item)} video={item} variant="compact" />
      ))}
    </section>
  );
}

export function WatchView() {
  const { params, navigate } = useRouter();
  const queue = useQueue();
  const library = useLibrary();
  const demoId = params.get("demo");
  const videoId = params.get("v");
  const listId = params.get("list");
  const tParam = params.get("t");
  const decoderParam = params.get("decoder") as DecoderStrategy | null;
  const decoderStrategy = decoderParam && DECODER_STRATEGIES.includes(decoderParam) ? decoderParam : "layered";
  const forceFallback = params.get("render") === "raf";

  const ref = useMemo<MediaRef | null>(
    () => (demoId ? { source: "demo", id: demoId } : videoId ? { source: "youtube", id: videoId } : null),
    [demoId, videoId],
  );
  const refKey = ref ? videoKey(ref) : null;
  const prep = usePreparation(ref);

  const queued = ref ? queue.items.find((item) => videoKey(item) === refKey) : undefined;
  const fromHistory = ref ? library.historyFor(ref)?.video : undefined;
  const video: VideoSummary | null = prep.job?.video ?? queued ?? fromHistory ?? (ref ? placeholder(ref) : null);
  const videoRef = useRef(video);
  videoRef.current = video;

  // Where to start: an explicit ?t=, otherwise the saved position. Fixed per video.
  const [startTime, setStartTime] = useState<number | null>(null);
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    if (!ref) return;
    const explicit = tParam !== null && /^\d+$/.test(tParam) ? Number(tParam) : null;
    const saved = explicit === null ? library.resumePosition(ref) : null;
    setStartTime(explicit ?? saved);
    setResumed(saved !== null);
    // Only when the video changes, not on every history write.
  }, [refKey]);

  // Keep the queue pointed at the routed video (deep links, back/forward).
  useEffect(() => {
    if (videoRef.current) queue.select(videoRef.current);
  }, [refKey]);

  useEffect(() => {
    if (prep.job?.video) queue.update(prep.job.video);
  }, [prep.job?.video?.id, prep.job?.video?.title]);

  // ?list= from a pasted URL: load the playlist into the queue.
  useEffect(() => {
    if (!listId || queue.listId === listId) return;
    const controller = new AbortController();
    discoveryApi
      .playlist(listId, 0, controller.signal)
      .then((page) => {
        const current = videoRef.current;
        if (current) queue.playList(page.items, current, { label: page.title ?? "Playlist", listId });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [listId]);

  // Save progress every 5 s while playing, immediately on pause, and when leaving the video.
  const { recordProgress } = library;
  const lastSaved = useRef(0);
  const wasPaused = useRef(true);
  const unsaved = useRef<{ video: VideoSummary; time: number; duration: number | null } | null>(null);
  const onTimeUpdate = useCallback(
    (time: number, duration: number | null, paused: boolean) => {
      const current = videoRef.current;
      if (!current) return;
      unsaved.current = { video: current, time, duration };
      const justPaused = paused && !wasPaused.current;
      wasPaused.current = paused;
      const now = Date.now();
      if (!justPaused && now - lastSaved.current < 5000) return;
      lastSaved.current = now;
      recordProgress(current, time, duration);
    },
    [recordProgress],
  );
  useEffect(
    () => () => {
      const pending = unsaved.current;
      if (pending) recordProgress(pending.video, pending.time, pending.duration);
      unsaved.current = null;
      wasPaused.current = true;
    },
    [refKey, recordProgress],
  );

  const related = useRelated(video ?? placeholder({ source: "demo", id: "" }), refKey);
  // Like YouTube, "next" falls back to the first related video when the queue runs out.
  const upNext = queue.hasNext ? null : (related.items[0] ?? null);
  const goTo = useCallback((next: VideoSummary | null) => (next ? navigate(watchPath(next)) : undefined), [navigate]);
  const onNext = useCallback(() => {
    if (queue.hasNext) return goTo(queue.next());
    if (upNext) {
      queue.select(upNext);
      goTo(upNext);
    }
  }, [goTo, queue, upNext]);
  const onPrevious = useCallback(() => goTo(queue.previous()), [goTo, queue]);
  const onEnded = useCallback(() => {
    const current = videoRef.current;
    const duration = unsaved.current?.duration ?? current?.duration_seconds ?? null;
    unsaved.current = null; // don't let the leave-flush overwrite "finished"
    if (current && duration) recordProgress(current, duration, duration);
    if (queue.autoplay && (queue.hasNext || upNext)) onNext();
  }, [recordProgress, queue.autoplay, queue.hasNext, upNext, onNext]);

  if (!ref || !video) {
    return (
      <EmptyState
        title="No video selected"
        action={
          <Button asChild variant="primary">
            <Link to="/">Go home</Link>
          </Button>
        }
      >
        Pick something to watch from search results or your library.
      </EmptyState>
    );
  }

  const media = prep.job?.media;
  const favorite = library.isFavorite(video);
  const views = formatViews(video.view_count);
  const channelRef = video.channel?.ref;
  const channelName = video.channel?.name ?? channelRef ?? (ref.source === "demo" ? "Demo media" : "");
  const showQueue = queue.items.length > 1 || Boolean(queue.label);

  return (
    <div className="mx-auto flex max-w-[1754px] flex-col gap-4 pb-12 sm:px-4 sm:pt-3 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1 [--player-radius:0px] sm:[--player-radius:12px]">
        <CanvasPlayer
          src={prep.mediaUrl}
          title={video.title}
          artist={video.channel?.name ?? undefined}
          startTime={startTime}
          autoPlay
          globalShortcuts
          decoderStrategy={decoderStrategy}
          forceFallback={forceFallback}
          hasPrevious={queue.hasPrevious}
          hasNext={queue.hasNext || upNext !== null}
          onPrevious={onPrevious}
          onNext={onNext}
          onEnded={onEnded}
          onTimeUpdate={onTimeUpdate}
          onRetry={prep.retry}
          badge={
            ref.source === "demo" ? (
              <span className="rounded bg-black/70 px-2 py-1 text-xs font-medium tracking-wide text-white">DEMO MEDIA · generated locally</span>
            ) : null
          }
          overlay={
            <PreparationPanel
              job={prep.job}
              requestError={prep.requestError}
              reconnecting={prep.reconnecting}
              onRetry={prep.retry}
              onCancel={prep.cancel}
            />
          }
        />

        <section className="px-3 sm:px-0" aria-labelledby="watch-title">
          <h1 id="watch-title" className="mt-3 line-clamp-2 text-xl font-bold leading-7">
            {video.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {channelRef ? (
                <Link to={channelPath(channelRef)} tabIndex={-1} aria-hidden="true">
                  <ChannelAvatar name={channelName} src={video.channel?.avatar_url} className="size-10" />
                </Link>
              ) : (
                <ChannelAvatar name={channelName} src={video.channel?.avatar_url} className="size-10" />
              )}
              <div className="min-w-0">
                {channelRef ? (
                  <Link to={channelPath(channelRef)} className="block truncate text-base font-medium leading-[22px]">
                    {channelName}
                  </Link>
                ) : (
                  <span className="block truncate text-base font-medium leading-[22px]">{channelName}</span>
                )}
                {video.channel?.handle ? <span className="block truncate text-xs leading-[18px] text-muted-foreground">{video.channel.handle}</span> : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant={favorite ? "primary" : "secondary"} aria-pressed={favorite} onClick={() => library.toggleFavorite(video)}>
                <Heart className={cn(favorite && "fill-current")} /> {favorite ? "Favorited" : "Favorite"}
              </Button>
              {ref.source === "youtube" ? (
                <Button asChild variant="secondary">
                  <a href={`https://www.youtube.com/watch?v=${ref.id}`} target="_blank" rel="noreferrer noopener">
                    <ExternalLink /> YouTube
                  </a>
                </Button>
              ) : null}
            </div>
          </div>

          <div className="mt-3 rounded-xl bg-secondary p-3 text-sm">
            {views || video.published_text ? (
              <p className="font-medium">{[views, video.published_text].filter(Boolean).join("  ")}</p>
            ) : null}
            {resumed && startTime ? (
              <p className="text-muted-foreground" role="status">
                Resumed at {formatTime(startTime)} from your history.
              </p>
            ) : null}
            {media ? (
              <p className="mt-1 text-muted-foreground" data-testid="media-details">
                Prepared {media.width}×{media.height} · {media.video_codec?.toUpperCase()}/{media.audio_codec?.toUpperCase()} ·{" "}
                {PROCESSING_LABELS[media.processing]} · {formatBytes(media.size_bytes)} · rendered to canvas
              </p>
            ) : null}
            {ref.source === "demo" ? (
              <p className="mt-2">
                This is locally generated <strong className="font-medium">demo/test media</strong>, not a YouTube video. The
                top bar fills from left to right with playback time; the swatches are pure red, green and blue for checking
                effects.
              </p>
            ) : null}
            <details className="group mt-2">
              <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
                <Keyboard className="size-4" aria-hidden="true" /> Keyboard shortcuts
              </summary>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                {SHORTCUT_HELP.map(([keys, label]) => (
                  <div key={keys} className="contents">
                    <dt>
                      <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-xs">{keys}</kbd>
                    </dt>
                    <dd className="text-muted-foreground">{label}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
        </section>
      </div>

      <div className="w-full shrink-0 px-3 sm:px-0 lg:w-[396px]">
        {showQueue ? <QueuePanel /> : null}
        <RelatedList items={related.items} loading={related.loading} fromChannel={related.fromChannel} channelName={video.channel?.name} />
      </div>
    </div>
  );
}

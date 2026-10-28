import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { videoKey, type MediaInfo, type MediaRef, type VideoSummary } from "../api/types";
import { Icon } from "../components/Icon";
import { EmptyState } from "../components/StateViews";
import { Thumbnail } from "../components/VideoCard";
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

function QueuePanel() {
  const queue = useQueue();
  const { navigate } = useRouter();
  return (
    <aside className="queue" aria-labelledby="queue-title">
      <header className="queue-header">
        <div>
          <h2 id="queue-title">Up next</h2>
          {queue.label ? <p className="muted small">{queue.label}</p> : null}
        </div>
        <label className="switch">
          <input type="checkbox" checked={queue.autoplay} onChange={(e) => queue.setAutoplay(e.currentTarget.checked)} />
          <span>Autoplay</span>
        </label>
      </header>
      {queue.items.length === 0 ? (
        <p className="muted small queue-empty">The queue is empty. Use “Add to queue” on any video, or “Play all” on a list.</p>
      ) : (
        <ol className="queue-list">
          {queue.items.map((item, i) => {
            const current = i === queue.index;
            return (
              <li key={videoKey(item)} className={current ? "current" : ""} aria-current={current ? "true" : undefined}>
                <button
                  type="button"
                  className="queue-item"
                  onClick={() => {
                    queue.select(item);
                    navigate(watchPath(item));
                  }}
                >
                  <span className="queue-index">{current ? <Icon name="play" size={14} /> : i + 1}</span>
                  <Thumbnail video={item} />
                  <span className="queue-text">
                    <span className="queue-title">{item.title}</span>
                    <span className="muted small">
                      {item.channel?.name ?? ""}
                      {item.duration_seconds ? ` · ${formatTime(item.duration_seconds)}` : ""}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={`Remove “${item.title}” from queue`}
                  onClick={() => queue.remove(item)}
                >
                  <Icon name="close" size={16} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {queue.items.length > 0 ? (
        <button type="button" className="button ghost small" onClick={queue.clear}>
          Clear queue
        </button>
      ) : null}
    </aside>
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

  const goTo = useCallback((next: VideoSummary | null) => (next ? navigate(watchPath(next)) : undefined), [navigate]);
  const onNext = useCallback(() => goTo(queue.next()), [goTo, queue]);
  const onPrevious = useCallback(() => goTo(queue.previous()), [goTo, queue]);
  const onEnded = useCallback(() => {
    const current = videoRef.current;
    const duration = unsaved.current?.duration ?? current?.duration_seconds ?? null;
    unsaved.current = null; // don't let the leave-flush overwrite "finished"
    if (current && duration) recordProgress(current, duration, duration);
    if (queue.autoplay && queue.hasNext) onNext();
  }, [recordProgress, queue.autoplay, queue.hasNext, onNext]);

  if (!ref || !video) {
    return (
      <EmptyState title="No video selected" action={<Link to="/" className="button">Go home</Link>}>
        Pick something to watch from search results or your library.
      </EmptyState>
    );
  }

  const media = prep.job?.media;
  const favorite = library.isFavorite(video);
  const views = formatViews(video.view_count);
  const channelRef = video.channel?.ref;

  return (
    <div className="watch">
      <div className="watch-main">
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
          hasNext={queue.hasNext}
          onPrevious={onPrevious}
          onNext={onNext}
          onEnded={onEnded}
          onTimeUpdate={onTimeUpdate}
          onRetry={prep.retry}
          badge={ref.source === "demo" ? <span className="badge demo">DEMO MEDIA · generated locally</span> : null}
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

        <section className="watch-info" aria-labelledby="watch-title">
          <h1 id="watch-title">{video.title}</h1>
          <div className="watch-meta">
            <p className="muted">
              {channelRef ? (
                <Link to={channelPath(channelRef)} className="text-link">
                  {video.channel?.name ?? channelRef}
                </Link>
              ) : (
                (video.channel?.name ?? "")
              )}
              {views ? ` · ${views}` : ""}
            </p>
            <div className="row">
              <button
                type="button"
                className={`button ghost${favorite ? " active" : ""}`}
                aria-pressed={favorite}
                onClick={() => library.toggleFavorite(video)}
              >
                <Icon name={favorite ? "heart" : "heartOutline"} size={18} /> {favorite ? "Favorited" : "Favorite"}
              </button>
              {ref.source === "youtube" ? (
                <a className="button ghost" href={`https://www.youtube.com/watch?v=${ref.id}`} target="_blank" rel="noreferrer noopener">
                  <Icon name="external" size={18} /> YouTube
                </a>
              ) : null}
            </div>
          </div>

          {resumed && startTime ? (
            <p className="small muted" role="status">
              Resumed at {formatTime(startTime)} from your history.
            </p>
          ) : null}

          {media ? (
            <p className="small muted media-details" data-testid="media-details">
              Prepared {media.width}×{media.height} · {media.video_codec?.toUpperCase()}/{media.audio_codec?.toUpperCase()} ·{" "}
              {PROCESSING_LABELS[media.processing]} · {formatBytes(media.size_bytes)} · rendered to canvas
            </p>
          ) : null}

          {ref.source === "demo" ? (
            <p className="small notice-box">
              This is locally generated <strong>demo/test media</strong>, not a YouTube video. The top bar fills from
              left to right with playback time; the swatches are pure red, green and blue for checking effects.
            </p>
          ) : null}

          <details className="shortcuts">
            <summary>Keyboard shortcuts</summary>
            <dl>
              {SHORTCUT_HELP.map(([keys, label]) => (
                <div key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </details>
        </section>
      </div>
      <QueuePanel />
    </div>
  );
}

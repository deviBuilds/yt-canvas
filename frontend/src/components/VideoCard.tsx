import { useState, type CSSProperties } from "react";

import type { VideoSummary } from "../api/types";
import { useLibrary } from "../library/LibraryContext";
import { formatTime, formatViews } from "../lib/format";
import { useQueue } from "../queue/QueueContext";
import { channelPath, Link, watchPath } from "../router/router";
import { Icon } from "./Icon";

export function Thumbnail({ video, progress }: { video: VideoSummary; progress?: number | null }) {
  const [failed, setFailed] = useState(false);
  const live = video.live_status === "is_live" || video.live_status === "is_upcoming";
  return (
    <div className="thumb">
      {video.source === "demo" ? (
        <div className={`thumb-demo demo-${video.id}`} aria-hidden="true">
          <span>DEMO</span>
        </div>
      ) : video.thumbnail_url && !failed ? (
        <img src={video.thumbnail_url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <div className="thumb-fallback" aria-hidden="true">
          <Icon name="play" size={32} />
        </div>
      )}
      {live ? (
        <span className="badge live">{video.live_status === "is_live" ? "LIVE" : "UPCOMING"}</span>
      ) : video.duration_seconds ? (
        <span className="badge">{formatTime(video.duration_seconds)}</span>
      ) : null}
      {progress && progress > 0 ? (
        <span className="thumb-progress" style={{ "--value": `${Math.min(100, progress * 100)}%` } as CSSProperties} />
      ) : null}
    </div>
  );
}

export interface VideoCardProps {
  video: VideoSummary;
  /** Called before navigating; defaults to selecting the video in the queue. */
  onPlay?: (video: VideoSummary) => void;
  progress?: number | null;
  onRemove?: () => void;
  removeLabel?: string;
}

export function VideoCard({ video, onPlay, progress, onRemove, removeLabel = "Remove" }: VideoCardProps) {
  const library = useLibrary();
  const queue = useQueue();
  const favorite = library.isFavorite(video);
  const live = video.live_status === "is_live" || video.live_status === "is_upcoming";
  const playable = video.available && !live;
  const views = formatViews(video.view_count);
  const channelRef = video.channel?.ref;

  if (!playable) {
    return (
      <article className="card unavailable" aria-label={`${video.title} (unavailable)`}>
        <Thumbnail video={video} />
        <div className="card-body">
          <h3 className="card-title">{video.title}</h3>
          <p className="card-meta">
            {live ? "Live streams aren't supported yet" : (video.unavailable_reason ?? "Unavailable")}
          </p>
        </div>
      </article>
    );
  }

  return (
    <article className="card">
      <Link to={watchPath(video)} className="card-link" onClick={() => (onPlay ? onPlay(video) : queue.select(video))}>
        <Thumbnail video={video} progress={progress} />
        <h3 className="card-title" title={video.title}>
          {video.title}
        </h3>
      </Link>
      <div className="card-body">
        <p className="card-meta">
          {channelRef ? (
            <Link to={channelPath(channelRef)} className="channel-link">
              {video.channel?.name ?? channelRef}
            </Link>
          ) : (
            <span>{video.channel?.name ?? (video.source === "demo" ? "Demo media" : "Unknown channel")}</span>
          )}
          {views ? <span className="dot">{views}</span> : null}
        </p>
        <div className="card-actions">
          <button
            type="button"
            className={`icon-button small${favorite ? " active" : ""}`}
            aria-label={favorite ? `Remove “${video.title}” from favorites` : `Add “${video.title}” to favorites`}
            aria-pressed={favorite}
            title={favorite ? "Remove from favorites" : "Add to favorites"}
            onClick={() => library.toggleFavorite(video)}
          >
            <Icon name={favorite ? "heart" : "heartOutline"} size={18} />
          </button>
          <button
            type="button"
            className="icon-button small"
            aria-label={`Add “${video.title}” to queue`}
            title={queue.contains(video) ? "Already in queue" : "Add to queue"}
            disabled={queue.contains(video)}
            onClick={() => queue.enqueue(video)}
          >
            <Icon name="queueAdd" size={18} />
          </button>
          {onRemove ? (
            <button type="button" className="icon-button small" aria-label={`${removeLabel}: ${video.title}`} title={removeLabel} onClick={onRemove}>
              <Icon name="close" size={18} />
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

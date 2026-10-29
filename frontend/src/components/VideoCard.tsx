import { EllipsisVertical, ExternalLink, Heart, ListPlus, Play, Trash2 } from "lucide-react";
import { useState } from "react";

import { ChannelAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { VideoSummary } from "../api/types";
import { useLibrary } from "../library/LibraryContext";
import { formatCount, formatTime } from "../lib/format";
import { useQueue } from "../queue/QueueContext";
import { channelPath, Link, watchPath } from "../router/router";

const isLive = (video: VideoSummary) => video.live_status === "is_live" || video.live_status === "is_upcoming";

export function Thumbnail({
  video,
  progress,
  className,
}: {
  video: VideoSummary;
  progress?: number | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const live = isLive(video);
  return (
    <div className={cn("thumb relative aspect-video w-full overflow-hidden rounded-xl bg-skeleton", className)}>
      {video.source === "demo" ? (
        <div className={`thumb-demo demo-${video.id} absolute inset-0 grid place-items-center`} aria-hidden="true">
          <span className="rounded bg-black/70 px-2 py-0.5 text-xs font-bold tracking-[0.2em] text-white">DEMO</span>
        </div>
      ) : video.thumbnail_url && !failed ? (
        <img
          src={video.thumbnail_url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-muted-foreground" aria-hidden="true">
          <Play className="size-8" />
        </div>
      )}
      {live ? (
        <span className="absolute bottom-2 right-2 rounded bg-brand px-1 py-px text-xs font-medium leading-[18px] text-white">
          {video.live_status === "is_live" ? "LIVE" : "UPCOMING"}
        </span>
      ) : video.duration_seconds ? (
        <span className="absolute bottom-2 right-2 rounded bg-overlay px-1 py-px text-xs font-medium leading-[18px] text-white">
          {formatTime(video.duration_seconds)}
        </span>
      ) : null}
      {progress && progress > 0 ? (
        <span className="absolute inset-x-0 bottom-0 h-1 bg-white/40" aria-hidden="true">
          <span className="block h-full bg-brand" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
}

function CardMenu({ video, onRemove, removeLabel }: { video: VideoSummary; onRemove?: () => void; removeLabel: string }) {
  const library = useLibrary();
  const queue = useQueue();
  const favorite = library.isFavorite(video);
  const queued = queue.contains(video);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Action menu"
          className="-mr-2.5 -mt-1.5"
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={queued} onSelect={() => queue.enqueue(video)}>
          <ListPlus /> {queued ? "Already in queue" : "Add to queue"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => library.toggleFavorite(video)}>
          <Heart className={cn(favorite && "fill-current")} /> {favorite ? "Remove from Favorites" : "Save to Favorites"}
        </DropdownMenuItem>
        {onRemove ? (
          <DropdownMenuItem onSelect={onRemove}>
            <Trash2 /> {removeLabel}
          </DropdownMenuItem>
        ) : null}
        {video.source === "youtube" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noreferrer noopener">
                <ExternalLink /> Open on YouTube
              </a>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Views and age the way YouTube shows them now: "▷ 1.2M  2w ago" (with
 * ``icon``) or "1.2M • 2w ago" (search results).
 */
function Stats({ video, icon = true }: { video: VideoSummary; icon?: boolean }) {
  const count = formatCount(video.view_count);
  if (!count && !video.published_text) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {count ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          {icon ? <Play className="size-3" aria-hidden="true" /> : null}
          {count}
          <span className="sr-only"> views</span>
        </span>
      ) : null}
      {count && video.published_text && !icon ? <span aria-hidden="true">•</span> : null}
      {video.published_text ? <span className="truncate">{video.published_text}</span> : null}
    </span>
  );
}

function ChannelName({ video, className }: { video: VideoSummary; className?: string }) {
  const ref = video.channel?.ref;
  const name = video.channel?.name ?? ref ?? (video.source === "demo" ? "Demo media" : "Unknown channel");
  return ref ? (
    <Link to={channelPath(ref)} className={cn("block truncate hover:text-foreground", className)} title={name}>
      {name}
    </Link>
  ) : (
    <span className={cn("block truncate", className)}>{name}</span>
  );
}

function CardAvatar({ video, className }: { video: VideoSummary; className?: string }) {
  const ref = video.channel?.ref;
  const avatar = <ChannelAvatar name={video.channel?.name ?? ref} src={video.channel?.avatar_url} className={className} />;
  return ref ? (
    <Link to={channelPath(ref)} tabIndex={-1} aria-hidden="true" className="shrink-0 self-start">
      {avatar}
    </Link>
  ) : (
    avatar
  );
}

export type CardVariant = "grid" | "list" | "compact";

export interface VideoCardProps {
  video: VideoSummary;
  /** Called before navigating; defaults to selecting the video in the queue. */
  onPlay?: (video: VideoSummary) => void;
  progress?: number | null;
  onRemove?: () => void;
  removeLabel?: string;
  variant?: CardVariant;
  /** Channel pages leave out the avatar and channel name, as YouTube does. */
  hideChannel?: boolean;
  className?: string;
}

/**
 * A video in YouTube's three card shapes: ``grid`` (home, channel), ``list``
 * (search results) and ``compact`` (the watch page's side column).
 */
export function VideoCard({
  video,
  onPlay,
  progress,
  onRemove,
  removeLabel = "Remove",
  variant = "grid",
  hideChannel = false,
  className,
}: VideoCardProps) {
  const queue = useQueue();
  const live = isLive(video);
  const playable = video.available && !live;
  const play = () => (onPlay ? onPlay(video) : queue.select(video));
  const href = watchPath(video);

  if (!playable) {
    return (
      <article
        className={cn("card unavailable flex gap-3 opacity-60", variant === "grid" ? "flex-col" : "flex-row", className)}
        aria-label={`${video.title} (unavailable)`}
      >
        <Thumbnail video={video} className={cn(variant === "list" && "w-[40%] max-w-90", variant === "compact" && "w-40 rounded-lg")} />
        <div className="min-w-0 flex-1">
          <h3 className="card-title line-clamp-2 text-sm font-medium">{video.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {live ? "Live streams aren't supported yet" : (video.unavailable_reason ?? "Unavailable")}
          </p>
        </div>
      </article>
    );
  }

  const thumbLink = (thumbClass?: string, linkClass?: string) => (
    <Link to={href} className={cn("card-link block shrink-0", linkClass)} tabIndex={-1} aria-hidden="true" onClick={play}>
      <Thumbnail video={video} progress={progress} className={thumbClass} />
    </Link>
  );
  const titleLink = (
    <Link to={href} onClick={play} title={video.title} className="focus-visible:outline-offset-1">
      {video.title}
    </Link>
  );

  if (variant === "compact") {
    return (
      <article className={cn("card group relative flex gap-3", className)}>
        {thumbLink("rounded-lg", "w-[62.5%] max-w-[248px]")}
        <div className="flex min-w-0 flex-1 gap-1">
          <div className="min-w-0 flex-1">
            <h3 className="card-title line-clamp-3 text-sm font-medium leading-5">{titleLink}</h3>
            <div className="mt-1 text-xs leading-[18px] text-muted-foreground">
              <ChannelName video={video} />
              <Stats video={video} />
            </div>
          </div>
          <CardMenu video={video} onRemove={onRemove} removeLabel={removeLabel} />
        </div>
      </article>
    );
  }

  if (variant === "list") {
    return (
      <article className={cn("card group relative flex flex-col gap-3 sm:flex-row sm:gap-4", className)}>
        {thumbLink(undefined, "sm:min-w-60 sm:max-w-[500px] sm:flex-1")}
        <div className="flex min-w-0 flex-1 gap-1">
          <div className="min-w-0 flex-1">
            <h3 className="card-title line-clamp-2 text-lg leading-[26px]">{titleLink}</h3>
            <div className="text-xs leading-[18px] text-muted-foreground">
              <Stats video={video} icon={false} />
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs leading-[18px] text-muted-foreground">
              <CardAvatar video={video} className="size-6 text-[11px]" />
              <ChannelName video={video} />
            </div>
          </div>
          <CardMenu video={video} onRemove={onRemove} removeLabel={removeLabel} />
        </div>
      </article>
    );
  }

  return (
    <article className={cn("card group relative flex min-w-0 flex-col gap-3", className)}>
      {thumbLink()}
      <div className="flex gap-2">
        {hideChannel ? null : <CardAvatar video={video} />}
        <div className="min-w-0 flex-1">
          <h3 className="card-title line-clamp-2 text-base font-medium leading-[22px]">{titleLink}</h3>
          <div className="flex flex-wrap items-center gap-x-2 text-sm leading-5 text-muted-foreground">
            {hideChannel ? null : <ChannelName video={video} className="max-w-full" />}
            <Stats video={video} />
          </div>
        </div>
        <CardMenu video={video} onRemove={onRemove} removeLabel={removeLabel} />
      </div>
    </article>
  );
}

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { VideoSummary } from "../api/types";
import { GRID_CLASS, GRID_MIN_CARD, GRID_GAP } from "./StateViews";
import { VideoCard } from "./VideoCard";

/** A titled home-page section, like YouTube's shelves. */
export function Shelf({
  title,
  icon,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  icon?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("border-b border-border pb-8 pt-6 last:border-b-0", className)}>
      <header className="mb-4 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id={id} className="flex items-center gap-2 text-xl font-bold">
            {icon}
            {title}
          </h2>
          {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** How many cards fit in one row of ``GRID_CLASS`` at the element's current width. */
function useColumns() {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setColumns(Math.max(1, Math.floor((width + GRID_GAP) / (GRID_MIN_CARD + GRID_GAP))));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, columns };
}

/** Videos in a grid that shows whole rows until expanded, like YouTube's "Show more" shelves. */
export function VideoShelf({
  title,
  items,
  icon,
  subtitle,
  action,
  rows = 1,
  onPlay,
  progressFor,
  onRemove,
  removeLabel,
}: {
  title: string;
  items: VideoSummary[];
  icon?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  rows?: number;
  onPlay?: (video: VideoSummary, items: VideoSummary[]) => void;
  progressFor?: (video: VideoSummary) => number | null;
  onRemove?: (video: VideoSummary) => void;
  removeLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { ref, columns } = useColumns();
  const initial = rows * columns;
  const shown = expanded ? items : items.slice(0, initial);
  return (
    <Shelf title={title} icon={icon} subtitle={subtitle} action={action}>
      <div ref={ref} className={GRID_CLASS}>
        {shown.map((video) => (
          <VideoCard
            key={`${video.source}:${video.id}`}
            video={video}
            onPlay={onPlay ? (v) => onPlay(v, items) : undefined}
            progress={progressFor?.(video)}
            onRemove={onRemove ? () => onRemove(video) : undefined}
            removeLabel={removeLabel}
          />
        ))}
      </div>
      {items.length > initial ? (
        <div className="relative mt-6 flex justify-center">
          <span className="absolute inset-x-0 top-1/2 h-px bg-border" aria-hidden="true" />
          <Button variant="secondary" className="relative border border-border bg-background" onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Show less" : "Show more"} {expanded ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </div>
      ) : null}
    </Shelf>
  );
}

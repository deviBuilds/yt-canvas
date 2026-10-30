import { CircleCheck, Clapperboard, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import { Link } from "@/router/router";

import { itemLabel, plexPath, type PlexItem } from "./api";

/** Movies and shows open their page; episodes and movies with progress can also play straight away. */
export const itemPath = (item: PlexItem) => plexPath("item", item.key);

function Progress({ item }: { item: PlexItem }) {
  if (!item.view_offset_seconds || !item.duration_seconds) return null;
  const percent = Math.min(100, (item.view_offset_seconds / item.duration_seconds) * 100);
  return (
    <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
      <div className="h-full bg-[#e5a00d]" style={{ width: `${percent}%` }} />
    </div>
  );
}

function Artwork({ src, alt }: { src: string | null; alt: string }) {
  return src ? (
    <img src={src} alt={alt} loading="lazy" className="size-full object-cover" />
  ) : (
    <div className="flex size-full items-center justify-center bg-secondary-hover text-muted-foreground">
      <Clapperboard className="size-8" aria-hidden="true" />
    </div>
  );
}

/** A 2:3 poster for movies, shows and seasons; a 16:9 still for episodes. */
export function PosterCard({ item }: { item: PlexItem }) {
  const wide = item.type === "episode";
  return (
    <Link to={itemPath(item)} className="group block min-w-0" aria-label={`${item.title}${itemLabel(item) ? `, ${itemLabel(item)}` : ""}`}>
      <div className={`relative overflow-hidden rounded-lg bg-secondary ${wide ? "aspect-video" : "aspect-[2/3]"}`}>
        <Artwork src={wide ? (item.still ?? item.poster) : item.poster} alt="" />
        {item.watched && (
          <CircleCheck className="absolute right-1.5 top-1.5 size-5 rounded-full bg-black/60 text-[#e5a00d]" aria-label="Watched" />
        )}
        <Progress item={item} />
      </div>
      <p className="mt-1.5 truncate text-sm font-medium group-hover:underline">{item.title}</p>
      <p className="truncate text-xs text-muted-foreground">{itemLabel(item)}</p>
    </Link>
  );
}

export function Row({ title, items, more }: { title: string; items: PlexItem[]; more?: string }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-8" aria-label={title}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        {more && (
          <Link to={more} className="text-sm text-link">
            See all
          </Link>
        )}
      </div>
      <div className="grid auto-cols-[140px] grid-flow-col gap-4 overflow-x-auto pb-2 sm:auto-cols-[160px]">
        {items.map((item) => (
          <PosterCard key={item.key} item={item} />
        ))}
      </div>
    </section>
  );
}

export function Grid({ items }: { items: PlexItem[] }) {
  const wide = items.every((item) => item.type === "episode");
  return (
    <div className={`grid gap-4 ${wide ? "grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(140px,1fr))]"}`}>
      {items.map((item) => (
        <PosterCard key={item.key} item={item} />
      ))}
    </div>
  );
}

export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> {children}
    </p>
  );
}

export function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <p className="mt-8 text-sm text-danger" role="alert">
      {message}{" "}
      {onRetry && (
        <button type="button" className="text-link underline" onClick={onRetry}>
          Try again
        </button>
      )}
    </p>
  );
}

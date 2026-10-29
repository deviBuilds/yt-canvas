import { ChevronRight, Heart, History, Trash2 } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import { GRID_CLASS } from "@/components/StateViews";
import { VideoShelf } from "@/components/Shelf";

import { EmptyState } from "../components/StateViews";
import { VideoCard } from "../components/VideoCard";
import { useLibrary } from "../library/LibraryContext";
import { Link } from "../router/router";

function ViewAll({ to }: { to: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link to={to}>
        View all <ChevronRight />
      </Link>
    </Button>
  );
}

const progressOf = (h: { position: number; duration: number | null }) => (h.duration ? h.position / h.duration : null);

/** YouTube's "You" page: history, continue watching and favorites saved in this browser. */
export function LibraryView() {
  const library = useLibrary();
  const progress = useCallback(
    (video: { source: string; id: string }) => {
      const entry = library.history.find((h) => h.video.source === video.source && h.video.id === video.id);
      return entry ? progressOf(entry) : null;
    },
    [library.history],
  );
  const empty = library.history.length === 0 && library.favorites.length === 0;

  return (
    <div className="mx-auto max-w-[1284px] px-4 pb-12 sm:px-6">
      <header className="pb-2 pt-6">
        <h1 className="text-3xl font-bold">Library</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your history and favorites are stored only in this browser.</p>
      </header>
      {empty ? (
        <EmptyState title="Nothing here yet" action={<Button asChild variant="primary"><Link to="/">Find something to watch</Link></Button>}>
          Videos you watch and save to Favorites show up here.
        </EmptyState>
      ) : null}
      {library.history.length > 0 ? (
        <VideoShelf
          title="History"
          icon={<History className="size-6" aria-hidden="true" />}
          items={library.history.map((h) => h.video)}
          rows={1}
          progressFor={progress}
          onRemove={(video) => library.removeFromHistory(video)}
          removeLabel="Remove from history"
          action={<ViewAll to="/history" />}
        />
      ) : null}
      {library.favorites.length > 0 ? (
        <VideoShelf
          title="Favorites"
          icon={<Heart className="size-6" aria-hidden="true" />}
          items={library.favorites.map((f) => f.video)}
          rows={1}
          action={<ViewAll to="/favorites" />}
        />
      ) : null}
    </div>
  );
}

export function HistoryView() {
  const library = useLibrary();
  return (
    <div className="mx-auto flex max-w-[1096px] flex-col gap-8 px-4 py-6 sm:px-6 lg:flex-row-reverse lg:items-start">
      <aside className="lg:sticky lg:top-20 lg:w-72 lg:shrink-0">
        <p className="text-sm text-muted-foreground">
          Watch history is saved only in this browser. It powers “Continue watching” and the “More from” shelves on the
          home page.
        </p>
        {library.history.length > 0 ? (
          <Button variant="ghost" className="mt-3 -ml-3" onClick={library.clearHistory}>
            <Trash2 /> Clear all watch history
          </Button>
        ) : null}
      </aside>
      <div className="min-w-0 flex-1">
        <h1 className="mb-6 text-3xl font-bold">Watch history</h1>
        {library.history.length === 0 ? (
          <EmptyState title="This list has no videos" action={<Button asChild variant="primary"><Link to="/">Find something to watch</Link></Button>} />
        ) : (
          <div className="flex flex-col gap-4">
            {library.history.map((h) => (
              <VideoCard
                key={`${h.video.source}:${h.video.id}`}
                video={h.video}
                variant="list"
                progress={progressOf(h)}
                onRemove={() => library.removeFromHistory(h.video)}
                removeLabel="Remove from history"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function FavoritesView() {
  const library = useLibrary();
  return (
    <div className="mx-auto max-w-[1284px] px-4 py-6 sm:px-6">
      <h1 className="text-3xl font-bold">Favorites</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">
        {library.favorites.length} {library.favorites.length === 1 ? "video" : "videos"} · saved in this browser
      </p>
      {library.favorites.length === 0 ? (
        <EmptyState title="No favorites yet">Use “Save to Favorites” in any video’s ⋮ menu, or the Favorite button while watching.</EmptyState>
      ) : (
        <div className={GRID_CLASS}>
          {library.favorites.map((f) => (
            <VideoCard key={`${f.video.source}:${f.video.id}`} video={f.video} />
          ))}
        </div>
      )}
    </div>
  );
}

export function NotFoundView() {
  return (
    <EmptyState title="Page not found" action={<Button asChild variant="primary"><Link to="/">Go home</Link></Button>}>
      That address doesn’t match anything in yt-canvas.
    </EmptyState>
  );
}

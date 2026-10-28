import { EmptyState } from "../components/StateViews";
import { VideoCard } from "../components/VideoCard";
import { useLibrary } from "../library/LibraryContext";
import { Link } from "../router/router";

export function LibraryView() {
  const library = useLibrary();
  return (
    <div className="list-view">
      <header className="list-header">
        <div>
          <p className="eyebrow">Library</p>
          <h1>Your library</h1>
          <p className="muted small">Favorites and history are stored only in this browser (localStorage).</p>
        </div>
      </header>

      <section className="shelf" aria-labelledby="lib-favorites">
        <header className="shelf-header">
          <h2 id="lib-favorites">Favorites</h2>
        </header>
        {library.favorites.length === 0 ? (
          <EmptyState title="No favorites yet">Use the heart on any video to save it here.</EmptyState>
        ) : (
          <div className="grid">
            {library.favorites.map((f) => (
              <VideoCard key={`${f.video.source}:${f.video.id}`} video={f.video} />
            ))}
          </div>
        )}
      </section>

      <section className="shelf" aria-labelledby="lib-history">
        <header className="shelf-header">
          <h2 id="lib-history">History</h2>
          {library.history.length > 0 ? (
            <button type="button" className="button ghost small" onClick={library.clearHistory}>
              Clear history
            </button>
          ) : null}
        </header>
        {library.history.length === 0 ? (
          <EmptyState title="No history yet" action={<Link to="/" className="button">Find something to watch</Link>} />
        ) : (
          <div className="grid">
            {library.history.map((h) => (
              <VideoCard
                key={`${h.video.source}:${h.video.id}`}
                video={h.video}
                progress={h.duration ? h.position / h.duration : null}
                onRemove={() => library.removeFromHistory(h.video)}
                removeLabel="Remove from history"
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function NotFoundView() {
  return (
    <EmptyState title="Page not found" action={<Link to="/" className="button">Go home</Link>}>
      That address doesn’t match anything in yt-canvas.
    </EmptyState>
  );
}

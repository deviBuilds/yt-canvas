import { useEffect, useState, type ReactNode } from "react";

import type { Page } from "../api/types";
import { EmptyState } from "../components/StateViews";
import { VideoCard } from "../components/VideoCard";
import { discoveryApi } from "../discovery/api";
import { useLibrary } from "../library/LibraryContext";
import { useQueue } from "../queue/QueueContext";
import { Link, searchPath, useRouter, watchPath } from "../router/router";

/** Fixed, clearly labelled keyword searches — not a personalized feed. */
export const TOPIC_SHORTCUTS = [
  "Blender open movies",
  "NASA space footage",
  "Nature documentary",
  "Jazz live session",
  "Cooking basics",
  "Programming conference talks",
  "Classical music performance",
  "Science explained",
];

function Shelf({ title, subtitle, action, children, id }: { title: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="shelf" aria-labelledby={id}>
      <header className="shelf-header">
        <div>
          <h2 id={id}>{title}</h2>
          {subtitle ? <p className="muted small">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function HomeView() {
  const library = useLibrary();
  const queue = useQueue();
  const { navigate } = useRouter();
  const [demo, setDemo] = useState<Page | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    discoveryApi
      .demo(controller.signal)
      .then(setDemo)
      .catch(() => setDemo(null));
    return () => controller.abort();
  }, []);

  const { continueWatching, favorites, history, searches } = library;
  const inProgress = new Set(continueWatching.map((h) => `${h.video.source}:${h.video.id}`));
  const recent = history.filter((h) => !inProgress.has(`${h.video.source}:${h.video.id}`)).slice(0, 8);
  const nothingSaved = continueWatching.length === 0 && favorites.length === 0 && history.length === 0;

  return (
    <div className="home">
      <section className="hero">
        <h1>Browse YouTube. Watch it through a canvas.</h1>
        <p className="muted">
          Search, or paste a video, channel or playlist link. The server prepares each video, then every frame is drawn
          into an HTML <code>&lt;canvas&gt;</code>, with optional visual effects.
        </p>
      </section>

      {continueWatching.length > 0 ? (
        <Shelf id="continue" title="Continue watching">
          <div className="row-scroll">
            {continueWatching.slice(0, 12).map((h) => (
              <VideoCard
                key={`${h.video.source}:${h.video.id}`}
                video={h.video}
                progress={h.duration ? h.position / h.duration : null}
                onRemove={() => library.removeFromHistory(h.video)}
                removeLabel="Remove from history"
              />
            ))}
          </div>
        </Shelf>
      ) : null}

      {favorites.length > 0 ? (
        <Shelf id="favorites" title="Favorites" action={<Link to="/library" className="text-link">See all</Link>}>
          <div className="row-scroll">
            {favorites.slice(0, 12).map((f) => (
              <VideoCard key={`${f.video.source}:${f.video.id}`} video={f.video} />
            ))}
          </div>
        </Shelf>
      ) : null}

      {recent.length > 0 || searches.length > 0 ? (
        <Shelf
          id="recent"
          title="Recent activity"
          action={history.length > 0 ? <Link to="/library" className="text-link">History</Link> : undefined}
        >
          {searches.length > 0 ? (
            <div className="chips" aria-label="Recent searches">
              {searches.map((s) => (
                <Link key={s.query} to={searchPath(s.query)} className="chip">
                  {s.query}
                </Link>
              ))}
              <button type="button" className="chip ghost" onClick={library.clearSearches}>
                Clear searches
              </button>
            </div>
          ) : null}
          {recent.length > 0 ? (
            <div className="row-scroll">
              {recent.map((h) => (
                <VideoCard key={`${h.video.source}:${h.video.id}`} video={h.video} />
              ))}
            </div>
          ) : null}
        </Shelf>
      ) : null}

      {nothingSaved ? (
        <EmptyState title="Nothing saved yet">
          Videos you favorite or start watching appear here. Try a search, a topic shortcut, or a demo clip below.
        </EmptyState>
      ) : null}

      <Shelf
        id="topics"
        title="Topic shortcuts"
        subtitle="Each one runs an ordinary YouTube keyword search. This is not a personalized feed."
      >
        <div className="chips">
          {TOPIC_SHORTCUTS.map((topic) => (
            <Link key={topic} to={searchPath(topic)} className="chip topic">
              {topic}
            </Link>
          ))}
        </div>
      </Shelf>

      {demo && demo.items.length > 0 ? (
        <Shelf
          id="demo"
          title="Demo & test media"
          subtitle="Generated locally with FFmpeg — not from YouTube. Use these to check the canvas pipeline without network access."
          action={
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                const first = demo.items[0]!;
                queue.playList(demo.items, first, { label: "Demo & test media" });
                navigate(watchPath(first));
              }}
            >
              Play all
            </button>
          }
        >
          <div className="row-scroll">
            {demo.items.map((video) => (
              <VideoCard
                key={video.id}
                video={video}
                onPlay={(v) => queue.playList(demo.items, v, { label: "Demo & test media" })}
              />
            ))}
          </div>
        </Shelf>
      ) : null}
    </div>
  );
}

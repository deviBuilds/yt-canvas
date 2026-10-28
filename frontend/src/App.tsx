import { useEffect, useState } from "react";

import type { Health } from "./api/types";
import { Icon } from "./components/Icon";
import { SearchBar } from "./components/SearchBar";
import { discoveryApi } from "./discovery/api";
import { LibraryProvider } from "./library/LibraryContext";
import { QueueProvider } from "./queue/QueueContext";
import { Link, RouterProvider, useRouter } from "./router/router";
import { HomeView } from "./views/HomeView";
import { LibraryView, NotFoundView } from "./views/LibraryView";
import { ChannelView, PlaylistView, SearchView } from "./views/ListViews";
import { WatchView } from "./views/WatchView";

function HealthBanner() {
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    discoveryApi
      .health(controller.signal)
      .then((h) => setHealth(h))
      .catch(() => {
        if (!controller.signal.aborted) setUnreachable(true);
      });
    return () => controller.abort();
  }, []);

  if (unreachable) {
    return (
      <div className="banner error" role="alert">
        The yt-canvas backend isn’t reachable. Start it with <code>make dev</code> (or see the README).
      </div>
    );
  }
  const warnings = health?.dependencies.warnings ?? [];
  if (!health || warnings.length === 0) return null;
  return (
    <div className="banner warning" role="status">
      <strong>Server setup:</strong> {warnings.join(" ")}
    </div>
  );
}

function Routes() {
  const { path } = useRouter();
  switch (path) {
    case "/":
      return <HomeView />;
    case "/search":
      return <SearchView />;
    case "/channel":
      return <ChannelView />;
    case "/playlist":
      return <PlaylistView />;
    case "/watch":
      return <WatchView />;
    case "/library":
      return <LibraryView />;
    default:
      return <NotFoundView />;
  }
}

export function App() {
  return (
    <RouterProvider>
      <LibraryProvider>
        <QueueProvider>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <header className="topbar">
            <Link to="/" className="brand" aria-label="yt-canvas home">
              <span className="brand-mark" aria-hidden="true">
                <Icon name="play" size={14} />
              </span>
              <span className="brand-name">yt-canvas</span>
            </Link>
            <SearchBar />
            <nav aria-label="Main">
              <Link to="/library" className="nav-link">
                <Icon name="library" size={18} />
                <span>Library</span>
              </Link>
            </nav>
          </header>
          <HealthBanner />
          <main id="main" className="content">
            <Routes />
          </main>
          <footer className="footer muted small">
            yt-canvas plays media extracted with yt-dlp, outside YouTube’s official embedded player. Deployments must
            respect content rights and YouTube’s Terms of Service.
          </footer>
        </QueueProvider>
      </LibraryProvider>
    </RouterProvider>
  );
}

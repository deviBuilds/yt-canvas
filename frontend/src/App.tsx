import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/theme/ThemeContext";

import type { Health } from "./api/types";
import { discoveryApi } from "./discovery/api";
import { LibraryProvider } from "./library/LibraryContext";
import { QueueProvider } from "./queue/QueueContext";
import { RouterProvider, useRouter } from "./router/router";
import { DemoView } from "./views/DemoView";
import { FeedView } from "./views/FeedView";
import { HomeView } from "./views/HomeView";
import { FavoritesView, HistoryView, LibraryView, NotFoundView } from "./views/LibraryView";
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

  const warnings = health?.dependencies.warnings ?? [];
  if (!unreachable && warnings.length === 0) return null;
  return (
    <div
      className="mx-4 mt-3 flex items-start gap-3 rounded-xl bg-secondary px-4 py-3 text-sm sm:mx-6"
      role={unreachable ? "alert" : "status"}
    >
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
      {unreachable ? (
        <p>
          The yt-canvas backend isn’t reachable. Start it with <code>make dev</code> (or see the README).
        </p>
      ) : (
        <p>
          <strong className="font-medium">Server setup:</strong> {warnings.join(" ")}
        </p>
      )}
    </div>
  );
}

function Routes() {
  const { path } = useRouter();
  if (path.startsWith("/feed/")) return <FeedView id={decodeURIComponent(path.slice("/feed/".length))} />;
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
    case "/history":
      return <HistoryView />;
    case "/favorites":
      return <FavoritesView />;
    case "/demo":
      return <DemoView />;
    default:
      return <NotFoundView />;
  }
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <RouterProvider>
          <LibraryProvider>
            <QueueProvider>
              <AppShell banner={<HealthBanner />}>
                <Routes />
              </AppShell>
            </QueueProvider>
          </LibraryProvider>
        </RouterProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

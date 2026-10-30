import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/theme/ThemeContext";

import type { Health } from "./api/types";
import { discoveryApi } from "./discovery/api";
import { LibraryProvider } from "./library/LibraryContext";
import { PairingGate } from "./pairing/PairingGate";
import { QueueProvider } from "./queue/QueueContext";
import { RouterProvider, useRouter } from "./router/router";
import { isPersonalFeed } from "./account/feeds";
import { appIdFromPath } from "./apps/registry";
import { AppRouteView, AppsView } from "./views/AppsView";
import { CheckView } from "./views/CheckView";
import { DevicesView } from "./views/DevicesView";
import { DirectPlayView } from "./views/DirectPlayView";
import { DemoView } from "./views/DemoView";
import { FeedView } from "./views/FeedView";
import { HomeView } from "./views/HomeView";
import { FavoritesView, HistoryView, LibraryView, NotFoundView } from "./views/LibraryView";
import { ChannelView, PlaylistView, SearchView } from "./views/ListViews";
import { PersonalFeedView } from "./views/PersonalFeedView";
import { SignInView } from "./views/SignInView";
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
  const appId = appIdFromPath(path);
  if (appId) return <AppRouteView id={appId} />;
  if (path.startsWith("/feed/")) {
    const id = decodeURIComponent(path.slice("/feed/".length));
    return isPersonalFeed(id) ? <PersonalFeedView id={id} /> : <FeedView id={id} />;
  }
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
    case "/signin":
      return <SignInView />;
    case "/check":
      return <CheckView />;
    case "/apps":
      return <AppsView />;
    case "/play":
      return <DirectPlayView />;
    case "/devices":
      return <DevicesView />;
    default:
      return <NotFoundView />;
  }
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <RouterProvider>
          <PairingGate>
            <LibraryProvider>
              <QueueProvider>
                <AppShell banner={<HealthBanner />}>
                  <Routes />
                </AppShell>
              </QueueProvider>
            </LibraryProvider>
          </PairingGate>
        </RouterProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

import { Clapperboard, LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/router/router";

import { plexApi, plexPath, type PlexStatus } from "./api";
import { PlexHomeView, PlexLibraryView, PlexSearchView, SearchBox } from "./Browse";
import { Failure, Loading } from "./components";
import { Connect } from "./Connect";
import { PlexItemPage } from "./ItemPage";
import { PlexWatch } from "./Watch";

/** The part of the path after /apps/plex, split: ["item", "12"], ["library", "1"], ... */
function route(path: string): string[] {
  return path.replace(/^\/apps\/plex\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

/**
 * The Plex app: connect your Plex account, browse its libraries, and play movies and
 * episodes in the canvas player.
 */
export default function PlexApp() {
  const { path, params, navigate } = useRouter();
  const [status, setStatus] = useState<PlexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    plexApi.status(controller.signal).then(setStatus, (err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    });
    return () => controller.abort();
  }, []);

  const onConnected = useCallback((next: PlexStatus) => setStatus(next), []);
  const disconnect = () => {
    void plexApi.disconnect().then((next) => {
      setStatus(next);
      navigate(plexPath());
    });
  };

  const [section, key] = route(path);
  let view;
  if (!status) view = error ? <Failure message={error} /> : <Loading />;
  else if (!status.connected) view = <Connect status={status} onConnected={onConnected} />;
  else if (section === "library" && key) view = <PlexLibraryView libraryKey={key} />;
  else if (section === "item" && key) view = <PlexItemPage itemKey={key} />;
  else if (section === "watch" && key) view = <PlexWatch key={key} itemKey={key} />;
  else if (section === "search") view = <PlexSearchView q={params.get("q") ?? ""} />;
  else view = <PlexHomeView />;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-12 pt-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link to={plexPath()} className="flex items-center gap-3 text-3xl font-bold">
          <Clapperboard className="size-8" aria-hidden="true" /> Plex
        </Link>
        {status?.connected && (
          <div className="flex flex-wrap items-center gap-3">
            <SearchBox initial={section === "search" ? (params.get("q") ?? "") : ""} />
            <span className="text-sm text-muted-foreground">
              {status.server}
              {status.connection === "relay" ? " (relay, slower)" : ""}
            </span>
            <Button variant="ghost" size="sm" onClick={disconnect}>
              <LogOut /> Disconnect
            </Button>
          </div>
        )}
      </header>
      {view}
    </div>
  );
}

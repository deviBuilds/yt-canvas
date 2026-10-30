import { Blocks, ShieldCheck, TriangleAlert } from "lucide-react";
import { Suspense, useState } from "react";

import { APP_MODULES, appPath } from "@/apps/registry";
import { setAppEnabled, useApps, type AppInfo } from "@/apps/store";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Link } from "@/router/router";

function AppRow({ app, available }: { app: AppInfo; available: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = APP_MODULES[app.id]?.icon ?? Blocks;

  const toggle = (enabled: boolean) => {
    setBusy(true);
    setError(null);
    setAppEnabled(app.id, enabled)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <li className="rounded-xl bg-secondary p-4">
      <div className="flex items-start gap-4">
        <Icon className="mt-0.5 size-8 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{app.name}</h2>
            <label className="flex items-center gap-2 text-sm">
              {app.enabled ? "On" : "Off"}
              <Switch
                checked={app.enabled}
                disabled={busy || !available}
                onCheckedChange={toggle}
                aria-label={`${app.name} app`}
              />
            </label>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{app.description}</p>
          {app.holds_private_data && (
            <p className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
              Once it's connected, yt-canvas only answers requests from this computer.
            </p>
          )}
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          {app.enabled && APP_MODULES[app.id] && (
            <Button asChild size="sm" className="mt-3">
              <Link to={appPath(app.id)}>Open {app.name}</Link>
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

/** Turn add-on apps on and off. Each is off until turned on here. */
export function AppsView() {
  const { listing, known } = useApps();
  return (
    <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-bold">Apps</h1>
      <p className="mt-2 text-muted-foreground">
        Optional add-ons for yt-canvas. An app stays off, and none of its code loads, until you turn it on. To use them
        from your phone or car through a tunnel, pair the device on{" "}
        <Link to="/devices" className="text-link">
          Devices
        </Link>
        .
      </p>
      {listing && !listing.available && (
        <p className="mt-6 flex items-start gap-3 rounded-xl bg-secondary p-4 text-sm" role="status">
          <TriangleAlert className="size-5 shrink-0 text-danger" aria-hidden="true" />
          Apps are turned off on this server (YTC_ENABLE_APPS=false).
        </p>
      )}
      {!known ? (
        <p className="mt-6 text-sm text-muted-foreground" role="status">
          Loading…
        </p>
      ) : !listing ? (
        <p className="mt-6 text-sm text-danger">Couldn't load the apps. Is the backend running?</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {listing.apps.map((app) => (
            <AppRow key={app.id} app={app} available={listing.available} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** /apps/<id>/...: the app's own views, loaded on demand, or why they aren't available. */
export function AppRouteView({ id }: { id: string }) {
  const { listing, known } = useApps();
  const appModule = APP_MODULES[id];
  const app = listing?.apps.find((candidate) => candidate.id === id);
  if (!known) {
    return (
      <p className="px-6 py-8 text-sm text-muted-foreground" role="status">
        Loading…
      </p>
    );
  }
  if (!appModule || !app) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-bold">There's no app here</h1>
        <p className="mt-2 text-muted-foreground">
          See <Link to="/apps" className="text-link">Apps</Link> for the apps yt-canvas has.
        </p>
      </div>
    );
  }
  if (!app.enabled) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-bold">The {app.name} app is off</h1>
        <p className="mt-2 text-muted-foreground">
          Turn it on in <Link to="/apps" className="text-link">Apps</Link> to use it.
        </p>
      </div>
    );
  }
  const { View } = appModule;
  return (
    <Suspense
      fallback={
        <p className="px-6 py-8 text-sm text-muted-foreground" role="status">
          Loading {app.name}…
        </p>
      }
    >
      <View />
    </Suspense>
  );
}

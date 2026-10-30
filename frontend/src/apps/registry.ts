import { Clapperboard, type LucideIcon } from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * The frontend half of each add-on app. Its views load with import() only once the app
 * is on and opened, so a turned-off app's code never reaches the browser.
 */
export interface AppModule {
  id: string;
  icon: LucideIcon;
  /** Everything under /apps/<id>. */
  View: LazyExoticComponent<ComponentType>;
}

export const APP_MODULES: Record<string, AppModule> = {
  plex: { id: "plex", icon: Clapperboard, View: lazy(() => import("./plex/PlexApp")) },
};

export const appPath = (id: string) => `/apps/${encodeURIComponent(id)}`;

/** The app id in an /apps/<id>/... path, or null. */
export function appIdFromPath(path: string): string | null {
  const match = /^\/apps\/([^/]+)/.exec(path);
  return match ? decodeURIComponent(match[1]!) : null;
}

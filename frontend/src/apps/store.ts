import { useEffect, useSyncExternalStore } from "react";

import { request } from "@/api/http";

/** An add-on app as the server reports it (GET /api/apps). */
export interface AppInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  connected: boolean;
  holds_private_data: boolean;
}

export interface AppListing {
  /** False when the server runs with YTC_ENABLE_APPS=false. */
  available: boolean;
  apps: AppInfo[];
}

export const appsApi = {
  list: (signal?: AbortSignal) => request<AppListing>("/api/apps", { signal }),
  setEnabled: (id: string, enabled: boolean) =>
    request<AppInfo>(`/api/apps/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ enabled }) }),
};

// One listing for the whole page, so turning an app on in Apps updates the sidebar at once.
let listing: AppListing | null = null;
let failed = false;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function loadApps(): Promise<void> {
  pending ??= appsApi.list().then(
    (result) => {
      listing = result;
      failed = false;
      emit();
    },
    () => {
      failed = true;
      pending = null; // try again next time
      emit();
    },
  );
  return pending;
}

export async function setAppEnabled(id: string, enabled: boolean): Promise<AppInfo> {
  const app = await appsApi.setEnabled(id, enabled);
  if (listing) listing = { ...listing, apps: listing.apps.map((existing) => (existing.id === id ? app : existing)) };
  emit();
  return app;
}

/** For tests: forget the listing. */
export function resetApps() {
  listing = null;
  failed = false;
  pending = null;
  emit();
}

export function useApps(): { listing: AppListing | null; known: boolean; enabled: AppInfo[] } {
  const current = useSyncExternalStore(subscribe, () => listing);
  const loadFailed = useSyncExternalStore(subscribe, () => failed);
  useEffect(() => {
    if (!listing) void loadApps();
  }, []);
  return { listing: current, known: current !== null || loadFailed, enabled: current?.apps.filter((app) => app.enabled) ?? [] };
}

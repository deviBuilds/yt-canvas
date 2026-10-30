import { request } from "@/api/http";

/** The account's library on the server (accounts on); each list holds entries as LibraryContext keeps them. */
export type ListName = "favorites" | "history" | "searches";

export interface RemoteEntry {
  key: string;
  data: unknown;
  updatedAt: number;
}

export interface RemoteLibrary {
  favorites: unknown[];
  history: unknown[];
  searches: unknown[];
}

const BASE = "/api/library";
/** Playback progress is saved this often at most (and when the page is hidden). */
export const HISTORY_FLUSH_MS = 15_000;
/** Which account this browser's own (no-login) library was merged into, once. */
export const IMPORTED_KEY = "ytc.library.imported.v1";

export const libraryApi = {
  get: (signal?: AbortSignal) => request<RemoteLibrary>(BASE, { signal }),
  put: (list: ListName, entries: RemoteEntry[], keepalive = false) =>
    keepalive
      ? // The page is going away: no time to ask for a token, so the session cookie signs it.
        fetch(`${BASE}/${list}`, {
          method: "PUT",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        }).then(() => undefined)
      : request<{ ok: boolean }>(`${BASE}/${list}`, { method: "PUT", body: JSON.stringify({ entries }) }).then(() => undefined),
  remove: (list: ListName, key: string) =>
    request<{ ok: boolean }>(`${BASE}/${list}/${encodeURIComponent(key)}`, { method: "DELETE" }).then(() => undefined),
  clear: (list: ListName) => request<{ ok: boolean }>(`${BASE}/${list}`, { method: "DELETE" }).then(() => undefined),
};

/**
 * Sends library changes to the server. Favorites and searches go at once; playback progress
 * is coalesced per video and flushed every 15 s, and when the page is hidden or closed.
 */
export class LibrarySync {
  private readonly pending = new Map<string, RemoteEntry>();
  private timer = 0;
  private readonly onHide = () => {
    if (document.visibilityState === "hidden") this.flush(true);
  };
  private readonly onPageHide = () => this.flush(true);

  constructor(private readonly onError: (err: unknown) => void = () => undefined) {
    document.addEventListener("visibilitychange", this.onHide);
    window.addEventListener("pagehide", this.onPageHide);
  }

  put(list: ListName, entry: RemoteEntry): void {
    libraryApi.put(list, [entry]).catch(this.onError);
  }

  remove(list: ListName, key: string): void {
    this.pending.delete(key);
    libraryApi.remove(list, key).catch(this.onError);
  }

  clear(list: ListName): void {
    if (list === "history") this.pending.clear();
    libraryApi.clear(list).catch(this.onError);
  }

  progress(entry: RemoteEntry): void {
    this.pending.set(entry.key, entry);
    if (!this.timer) this.timer = window.setTimeout(() => this.flush(), HISTORY_FLUSH_MS);
  }

  flush(keepalive = false): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    libraryApi.put("history", entries, keepalive).catch(this.onError);
  }

  dispose(): void {
    this.flush(true);
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.onPageHide);
  }
}

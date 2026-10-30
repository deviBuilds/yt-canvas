import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useAccount } from "@/auth/AccountContext";

import { videoKey, type MediaRef, type VideoSummary } from "../api/types";
import { IMPORTED_KEY, libraryApi, LibrarySync, type ListName, type RemoteEntry } from "./remote";
import { asArray, asVideo, readJson, writeJson } from "./storage";

export const FAVORITES_KEY = "ytc.favorites.v1";
export const HISTORY_KEY = "ytc.history.v1";
export const SEARCHES_KEY = "ytc.searches.v1";

const MAX_FAVORITES = 200;
const MAX_HISTORY = 100;
const MAX_SEARCHES = 12;
/** Positions within this many seconds of either end don't count as "in progress". */
const RESUME_MARGIN = 5;

export interface FavoriteEntry {
  video: VideoSummary;
  addedAt: number;
}

export interface HistoryEntry {
  video: VideoSummary;
  position: number;
  duration: number | null;
  updatedAt: number;
}

export interface SearchEntry {
  query: string;
  at: number;
}

const asFavorite = (x: unknown): FavoriteEntry | null => {
  const e = x as Partial<FavoriteEntry> | null;
  const video = asVideo(e?.video);
  return video && typeof e?.addedAt === "number" ? { video, addedAt: e.addedAt } : null;
};

const asHistory = (x: unknown): HistoryEntry | null => {
  const e = x as Partial<HistoryEntry> | null;
  const video = asVideo(e?.video);
  if (!video || typeof e?.position !== "number" || typeof e?.updatedAt !== "number") return null;
  return {
    video,
    position: Math.max(0, e.position),
    duration: typeof e.duration === "number" ? e.duration : null,
    updatedAt: e.updatedAt,
  };
};

const asSearch = (x: unknown): SearchEntry | null => {
  const e = x as Partial<SearchEntry> | null;
  return typeof e?.query === "string" && e.query && typeof e.at === "number" ? { query: e.query, at: e.at } : null;
};

export function isInProgress(entry: HistoryEntry): boolean {
  if (entry.position < RESUME_MARGIN) return false;
  return entry.duration === null || entry.position < entry.duration - RESUME_MARGIN * 2;
}

interface LibraryValue {
  favorites: FavoriteEntry[];
  history: HistoryEntry[];
  searches: SearchEntry[];
  continueWatching: HistoryEntry[];
  isFavorite: (ref: MediaRef) => boolean;
  toggleFavorite: (video: VideoSummary) => void;
  recordProgress: (video: VideoSummary, position: number, duration: number | null) => void;
  resumePosition: (ref: MediaRef) => number | null;
  historyFor: (ref: MediaRef) => HistoryEntry | undefined;
  removeFromHistory: (ref: MediaRef) => void;
  clearHistory: () => void;
  addSearch: (query: string) => void;
  clearSearches: () => void;
}

const LibraryContext = createContext<LibraryValue | null>(null);

function load() {
  return {
    favorites: readJson(FAVORITES_KEY, (v) => asArray(v, asFavorite, MAX_FAVORITES), []),
    history: readJson(HISTORY_KEY, (v) => asArray(v, asHistory, MAX_HISTORY), []),
    searches: readJson(SEARCHES_KEY, (v) => asArray(v, asSearch, MAX_SEARCHES), []),
  };
}

/** Puts this browser's own (no-login) library into the account the first time anyone signs in here. */
async function importLocal(account: string): Promise<void> {
  if (readJson<string | null>(IMPORTED_KEY, (v) => (typeof v === "string" ? v : null), null) !== null) return;
  const local = load();
  const lists: [ListName, RemoteEntry[]][] = [
    ["favorites", local.favorites.map((f) => ({ key: videoKey(f.video), data: f, updatedAt: f.addedAt }))],
    ["history", local.history.map((h) => ({ key: videoKey(h.video), data: h, updatedAt: h.updatedAt }))],
    ["searches", local.searches.map((s) => ({ key: s.query.toLowerCase(), data: s, updatedAt: s.at }))],
  ];
  for (const [list, entries] of lists) if (entries.length > 0) await libraryApi.put(list, entries);
  writeJson(IMPORTED_KEY, account);
}

/**
 * Favorites, history and recent searches: in this browser's localStorage in no-login mode,
 * or the signed-in account's, kept on the server so they follow the person to any device.
 */
export function LibraryProvider({ children }: { children: ReactNode }) {
  const { user } = useAccount();
  const account = user?.email ?? null;
  return (
    <LibraryState key={account ?? ""} account={account}>
      {children}
    </LibraryState>
  );
}

function LibraryState({ account, children }: { account: string | null; children: ReactNode }) {
  const remote = account !== null;
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(() => (remote ? [] : load().favorites));
  const [history, setHistory] = useState<HistoryEntry[]>(() => (remote ? [] : load().history));
  const [searches, setSearches] = useState<SearchEntry[]>(() => (remote ? [] : load().searches));
  const sync = useRef<LibrarySync | null>(null);
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;

  // The account's library, after merging in what this browser had (once).
  useEffect(() => {
    if (account === null) return;
    const syncer = new LibrarySync();
    sync.current = syncer;
    const controller = new AbortController();
    importLocal(account)
      .catch(() => undefined)
      .then(() => libraryApi.get(controller.signal))
      .then((data) => {
        setFavorites(asArray(data.favorites, asFavorite, MAX_FAVORITES) ?? []);
        setHistory(asArray(data.history, asHistory, MAX_HISTORY) ?? []);
        setSearches(asArray(data.searches, asSearch, MAX_SEARCHES) ?? []);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      syncer.dispose();
      sync.current = null;
    };
  }, [account]);

  // Keep several tabs in sync (no-login mode).
  useEffect(() => {
    if (remote) return;
    const onStorage = (event: StorageEvent) => {
      if (![FAVORITES_KEY, HISTORY_KEY, SEARCHES_KEY].includes(event.key ?? "")) return;
      const fresh = load();
      setFavorites(fresh.favorites);
      setHistory(fresh.history);
      setSearches(fresh.searches);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [remote]);

  const toggleFavorite = useCallback(
    (video: VideoSummary) => {
      const key = videoKey(video);
      const removing = favoritesRef.current.some((f) => videoKey(f.video) === key);
      const entry: FavoriteEntry = { video, addedAt: Date.now() };
      setFavorites((current) => {
        const next = removing
          ? current.filter((f) => videoKey(f.video) !== key)
          : [entry, ...current.filter((f) => videoKey(f.video) !== key)].slice(0, MAX_FAVORITES);
        if (!remote) writeJson(FAVORITES_KEY, next);
        return next;
      });
      if (removing) sync.current?.remove("favorites", key);
      else sync.current?.put("favorites", { key, data: entry, updatedAt: entry.addedAt });
    },
    [remote],
  );

  const recordProgress = useCallback(
    (video: VideoSummary, position: number, duration: number | null) => {
      if (!Number.isFinite(position)) return;
      const key = videoKey(video);
      const entry: HistoryEntry = {
        video,
        position: Math.max(0, position),
        duration: duration && Number.isFinite(duration) ? duration : null,
        updatedAt: Date.now(),
      };
      setHistory((current) => {
        const next = [entry, ...current.filter((h) => videoKey(h.video) !== key)].slice(0, MAX_HISTORY);
        if (!remote) writeJson(HISTORY_KEY, next);
        return next;
      });
      sync.current?.progress({ key, data: entry, updatedAt: entry.updatedAt });
    },
    [remote],
  );

  const removeFromHistory = useCallback(
    (ref: MediaRef) => {
      setHistory((current) => {
        const next = current.filter((h) => videoKey(h.video) !== videoKey(ref));
        if (!remote) writeJson(HISTORY_KEY, next);
        return next;
      });
      sync.current?.remove("history", videoKey(ref));
    },
    [remote],
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
    if (!remote) writeJson(HISTORY_KEY, []);
    sync.current?.clear("history");
  }, [remote]);

  const addSearch = useCallback(
    (query: string) => {
      const q = query.trim();
      if (!q) return;
      const entry: SearchEntry = { query: q, at: Date.now() };
      setSearches((current) => {
        const next = [entry, ...current.filter((s) => s.query.toLowerCase() !== q.toLowerCase())].slice(0, MAX_SEARCHES);
        if (!remote) writeJson(SEARCHES_KEY, next);
        return next;
      });
      sync.current?.put("searches", { key: q.toLowerCase(), data: entry, updatedAt: entry.at });
    },
    [remote],
  );

  const clearSearches = useCallback(() => {
    setSearches([]);
    if (!remote) writeJson(SEARCHES_KEY, []);
    sync.current?.clear("searches");
  }, [remote]);

  const value = useMemo<LibraryValue>(() => {
    const favoriteKeys = new Set(favorites.map((f) => videoKey(f.video)));
    const historyByKey = new Map(history.map((h) => [videoKey(h.video), h]));
    return {
      favorites,
      history,
      searches,
      continueWatching: history.filter(isInProgress),
      isFavorite: (ref) => favoriteKeys.has(videoKey(ref)),
      toggleFavorite,
      recordProgress,
      resumePosition: (ref) => {
        const entry = historyByKey.get(videoKey(ref));
        return entry && isInProgress(entry) ? entry.position : null;
      },
      historyFor: (ref) => historyByKey.get(videoKey(ref)),
      removeFromHistory,
      clearHistory,
      addSearch,
      clearSearches,
    };
  }, [favorites, history, searches, toggleFavorite, recordProgress, removeFromHistory, clearHistory, addSearch, clearSearches]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useLibrary must be used inside <LibraryProvider>");
  return value;
}

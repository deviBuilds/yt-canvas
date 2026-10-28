import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { videoKey, type MediaRef, type VideoSummary } from "../api/types";
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

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(() => load().favorites);
  const [history, setHistory] = useState<HistoryEntry[]>(() => load().history);
  const [searches, setSearches] = useState<SearchEntry[]>(() => load().searches);

  // Keep several tabs in sync.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (![FAVORITES_KEY, HISTORY_KEY, SEARCHES_KEY].includes(event.key ?? "")) return;
      const fresh = load();
      setFavorites(fresh.favorites);
      setHistory(fresh.history);
      setSearches(fresh.searches);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggleFavorite = useCallback((video: VideoSummary) => {
    setFavorites((current) => {
      const key = videoKey(video);
      const next = current.some((f) => videoKey(f.video) === key)
        ? current.filter((f) => videoKey(f.video) !== key)
        : [{ video, addedAt: Date.now() }, ...current].slice(0, MAX_FAVORITES);
      writeJson(FAVORITES_KEY, next);
      return next;
    });
  }, []);

  const recordProgress = useCallback((video: VideoSummary, position: number, duration: number | null) => {
    if (!Number.isFinite(position)) return;
    setHistory((current) => {
      const key = videoKey(video);
      const entry: HistoryEntry = {
        video,
        position: Math.max(0, position),
        duration: duration && Number.isFinite(duration) ? duration : null,
        updatedAt: Date.now(),
      };
      const next = [entry, ...current.filter((h) => videoKey(h.video) !== key)].slice(0, MAX_HISTORY);
      writeJson(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const removeFromHistory = useCallback((ref: MediaRef) => {
    setHistory((current) => {
      const next = current.filter((h) => videoKey(h.video) !== videoKey(ref));
      writeJson(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    writeJson(HISTORY_KEY, []);
  }, []);

  const addSearch = useCallback((query: string) => {
    const q = query.trim();
    if (!q) return;
    setSearches((current) => {
      const next = [{ query: q, at: Date.now() }, ...current.filter((s) => s.query.toLowerCase() !== q.toLowerCase())]
        .slice(0, MAX_SEARCHES);
      writeJson(SEARCHES_KEY, next);
      return next;
    });
  }, []);

  const clearSearches = useCallback(() => {
    setSearches([]);
    writeJson(SEARCHES_KEY, []);
  }, []);

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

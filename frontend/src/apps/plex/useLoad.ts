import { useCallback, useEffect, useState } from "react";

/**
 * What Plex views loaded, kept in memory while the page is open, so going back to a view shows
 * it at once while it refreshes in the background. A reload or signing out (both full page
 * loads) clears it, so nothing outlives the person who's signed in.
 */
const loaded = new Map<string, unknown>();
const MAX_LOADED = 100;

export function remember(key: string, data: unknown): void {
  loaded.delete(key);
  loaded.set(key, data);
  if (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value as string);
}

export function recall<T>(key: string | undefined): T | null {
  return key !== undefined && loaded.has(key) ? (loaded.get(key) as T) : null;
}

/** After connecting or disconnecting Plex, or choosing another server: nothing loaded before applies. */
export function forgetLoaded(): void {
  loaded.clear();
}

/**
 * Load something for a view: data, an error message, and a retry. Reloads when ``deps`` change.
 * With a ``cacheKey`` (which must change with ``deps``), what was loaded last time shows at once
 * and is refreshed in the background (``refreshing``); a refresh that fails keeps it.
 */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  cacheKey?: string,
): { data: T | null; error: string | null; refreshing: boolean; retry: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; refreshing: boolean }>(() => ({
    data: recall<T>(cacheKey),
    error: null,
    refreshing: false,
  }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const cached = recall<T>(cacheKey);
    setState({ data: cached, error: null, refreshing: cached !== null });
    load(controller.signal).then(
      (data) => {
        if (cacheKey !== undefined) remember(cacheKey, data);
        setState({ data, error: null, refreshing: false });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        setState(cached !== null ? { data: cached, error: null, refreshing: false } : { data: null, error, refreshing: false });
      },
    );
    return () => controller.abort();
    // ``load`` and ``cacheKey`` are expected to change with ``deps``.
  }, [...deps, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

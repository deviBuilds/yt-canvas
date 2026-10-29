import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../api/http";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { data: unknown; at: number }>();

export interface CachedRequest<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  retry: () => void;
}

/**
 * Fetch once per ``key`` and keep the result for this browser session (10 min),
 * so moving between pages doesn't refetch YouTube shelves. ``key: null`` skips.
 */
export function useCachedRequest<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>): CachedRequest<T> {
  const cached = key ? cache.get(key) : undefined;
  const fresh = cached && Date.now() - cached.at < TTL_MS ? (cached.data as T) : null;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: ApiError | null }>({
    key,
    data: fresh,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!key) return;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS && attempt === 0) {
      setState({ key, data: hit.data as T, error: null });
      return;
    }
    setState((s) => (s.key === key ? { ...s, error: null } : { key, data: null, error: null }));
    const controller = new AbortController();
    fetcher(controller.signal)
      .then((data) => {
        cache.set(key, { data, at: Date.now() });
        setState({ key, data, error: null });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const error =
          err instanceof ApiError
            ? err
            : new ApiError(0, { code: "error", message: "Something went wrong.", hint: null, retryable: true });
        setState({ key, data: null, error });
      });
    return () => controller.abort();
    // ``fetcher`` is expected to change with ``key``.
  }, [key, attempt]);

  const retry = useCallback(() => {
    if (key) cache.delete(key);
    setAttempt((n) => n + 1);
  }, [key]);

  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: Boolean(key) && (!current || (state.data === null && state.error === null)),
    retry,
  };
}

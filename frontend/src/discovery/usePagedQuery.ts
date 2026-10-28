import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api/http";
import type { Page, VideoSummary } from "../api/types";

export type Fetcher = (offset: number, signal: AbortSignal) => Promise<Page>;

export interface PagedState {
  page: Page | null;
  items: VideoSummary[];
  loading: boolean;
  loadingMore: boolean;
  error: ApiError | null;
  /** Only true when the provider reported a real next page. */
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError(0, { code: "error", message: "Something went wrong.", hint: null, retryable: true });
}

/** Load the first page for ``key`` and append further pages on demand. */
export function usePagedQuery(key: string | null, fetcher: Fetcher): PagedState {
  const [page, setPage] = useState<Page | null>(null);
  const [items, setItems] = useState<VideoSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const moreController = useRef<AbortController | null>(null);

  useEffect(() => {
    setPage(null);
    setItems([]);
    setError(null);
    moreController.current?.abort();
    if (key === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetcherRef
      .current(0, controller.signal)
      .then((first) => {
        setPage(first);
        setItems(first.items);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(toApiError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    if (!page || page.next_offset === null || loadingMore) return;
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true);
    setError(null);
    fetcherRef
      .current(page.next_offset, controller.signal)
      .then((next) => {
        setPage(next);
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...next.items.filter((item) => !seen.has(item.id))];
        });
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(toApiError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
  }, [page, loadingMore]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    page,
    items,
    loading,
    loadingMore,
    error,
    hasMore: Boolean(page && page.next_offset !== null),
    loadMore,
    retry,
  };
}

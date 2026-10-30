import { useCallback, useEffect, useState } from "react";

/** Load something for a view: data, an error message, and a retry. Reloads when ``deps`` change. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; retry: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, error: null });
    load(controller.signal).then(
      (data) => setState({ data, error: null }),
      (err: unknown) => {
        if (!controller.signal.aborted) setState({ data: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => controller.abort();
    // ``load`` is expected to change with ``deps``.
  }, [...deps, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

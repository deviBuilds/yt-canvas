import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api/http";
import type { Job, MediaRef } from "../api/types";
import { preparationApi } from "./api";

export interface PreparationState {
  job: Job | null;
  /** Failure to create or poll the job (not a failed job: see ``job.error``). */
  requestError: ApiError | null;
  /** Polling is temporarily failing; we keep retrying. */
  reconnecting: boolean;
  /** Same-origin media URL once the job is ready. */
  mediaUrl: string | null;
  retry: () => void;
  cancel: () => void;
}

const POLL_ACTIVE_MS = 600;
const POLL_QUEUED_MS = 1500;
const MAX_BACKOFF_MS = 8000;

/** Start (or join) the preparation job for ``ref`` and poll it until it is ready or failed. */
export function usePreparation(ref: MediaRef | null): PreparationState {
  const [job, setJob] = useState<Job | null>(null);
  const [requestError, setRequestError] = useState<{ key: string; error: ApiError } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const jobRef = useRef<Job | null>(null);
  jobRef.current = job;
  const source = ref?.source;
  const id = ref?.id;

  useEffect(() => {
    setJob(null);
    setRequestError(null);
    setReconnecting(false);
    if (!source || !id) return;

    const controller = new AbortController();
    let timer: number | undefined;
    let failures = 0;

    const schedule = (current: Job) => {
      if (current.state === "ready" || current.state === "failed") return;
      const delay = current.state === "queued" ? POLL_QUEUED_MS : POLL_ACTIVE_MS;
      timer = window.setTimeout(() => void poll(current.id), delay);
    };

    const poll = async (jobId: string) => {
      try {
        const next = await preparationApi.get(jobId, controller.signal);
        failures = 0;
        setReconnecting(false);
        setJob(next);
        schedule(next);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) {
          // The server restarted and forgot the job: start over.
          setAttempt((n) => n + 1);
          return;
        }
        failures++;
        setReconnecting(true);
        timer = window.setTimeout(() => void poll(jobId), Math.min(MAX_BACKOFF_MS, POLL_ACTIVE_MS * 2 ** failures));
      }
    };

    preparationApi
      .create({ source, id }, controller.signal)
      .then((created) => {
        setJob(created);
        schedule(created);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setRequestError({
          key: `${source}:${id}`,
          error:
            err instanceof ApiError
              ? err
              : new ApiError(0, { code: "error", message: "Could not start preparation.", hint: null, retryable: true }),
        });
      });

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [source, id, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const cancel = useCallback(() => {
    const current = jobRef.current;
    if (!current || current.state === "ready" || current.state === "failed") return;
    preparationApi
      .cancel(current.id)
      .then(setJob)
      .catch(() => undefined);
  }, []);

  // State is reset in an effect, i.e. after the first render for a new ref; never
  // expose the previous video's job (or its media URL) during that render.
  const current = job && job.source === source && job.video_id === id ? job : null;
  const mediaUrl =
    current?.state === "ready" && current.media ? `${current.media.url}?job=${encodeURIComponent(current.id)}` : null;
  const currentError = requestError && requestError.key === `${source}:${id}` ? requestError.error : null;
  return { job: current, requestError: currentError, reconnecting, mediaUrl, retry, cancel };
}

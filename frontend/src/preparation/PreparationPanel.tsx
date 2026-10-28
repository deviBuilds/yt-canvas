import type { CSSProperties } from "react";

import type { ApiError } from "../api/http";
import type { Job, JobState } from "../api/types";
import { formatBytes, formatEta } from "../lib/format";

const STEPS: Array<{ state: Exclude<JobState, "failed">; label: string }> = [
  { state: "queued", label: "Queued" },
  { state: "resolving", label: "Resolving" },
  { state: "downloading", label: "Downloading" },
  { state: "processing", label: "Processing" },
  { state: "ready", label: "Ready" },
];

const ERROR_TITLES: Record<string, string> = {
  unavailable: "Video unavailable",
  live_unsupported: "Live streams aren't supported",
  restricted: "Restricted video",
  download_forbidden: "YouTube refused the download",
  youtube_blocked: "Blocked by YouTube",
  rate_limited: "Rate-limited by YouTube",
  too_large: "Video too large",
  too_long: "Video too long",
  no_formats: "No playable formats",
  js_runtime_problem: "Extraction problem",
  dependency_missing: "Server dependency missing",
  storage_full: "Storage full",
  busy: "Server busy",
  cancelled: "Preparation cancelled",
  network_error: "Network problem",
  timeout: "Timed out",
};

export interface PreparationPanelProps {
  job: Job | null;
  requestError: ApiError | null;
  reconnecting: boolean;
  onRetry: () => void;
  onCancel: () => void;
}

export function PreparationPanel({ job, requestError, reconnecting, onRetry, onCancel }: PreparationPanelProps) {
  const error = requestError?.info ?? (job?.state === "failed" ? job.error : null);
  if (error) {
    return (
      <div className="overlay-card prep-error" role="alert" data-testid="preparation-error" data-code={error.code}>
        <h3>{ERROR_TITLES[error.code] ?? "Something went wrong"}</h3>
        <p>{error.message}</p>
        {error.hint ? <p className="muted small">{error.hint}</p> : null}
        <div className="row">
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const state = job?.state ?? "queued";
  const currentIndex = STEPS.findIndex((step) => step.state === state);
  const progress = job?.progress;
  const fraction = progress?.fraction ?? null;
  const determinate = fraction !== null && state !== "queued" && state !== "resolving";
  const bytes =
    progress?.downloaded_bytes !== null && progress?.downloaded_bytes !== undefined
      ? progress.total_bytes
        ? `${formatBytes(progress.downloaded_bytes)} of ${formatBytes(progress.total_bytes)}`
        : formatBytes(progress.downloaded_bytes)
      : null;
  const speed = progress?.speed_bps ? `${formatBytes(progress.speed_bps)}/s` : null;
  const eta = formatEta(progress?.eta_seconds);

  return (
    <div className="overlay-card prep" role="status" aria-live="polite" data-testid="preparation" data-state={state}>
      <h3>{job ? "Preparing video" : "Starting…"}</h3>
      <ol className="steps" aria-label="Preparation steps">
        {STEPS.map((step, i) => (
          <li
            key={step.state}
            className={i < currentIndex ? "done" : i === currentIndex ? "current" : ""}
            aria-current={i === currentIndex ? "step" : undefined}
          >
            {step.label}
          </li>
        ))}
      </ol>
      <div
        className={`progress${determinate ? "" : " indeterminate"}`}
        role="progressbar"
        aria-label="Preparation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? Math.round((fraction ?? 0) * 100) : undefined}
        style={{ "--value": `${Math.round((fraction ?? 0) * 100)}%` } as CSSProperties}
      >
        <span />
      </div>
      <p className="small">
        {progress?.detail ?? "Waiting for the server…"}
        {determinate ? ` · ${Math.round((fraction ?? 0) * 100)}%` : ""}
      </p>
      {bytes || speed || eta ? <p className="muted small">{[bytes, speed, eta].filter(Boolean).join(" · ")}</p> : null}
      {job?.queue_position !== null && job?.queue_position !== undefined ? (
        <p className="muted small">
          {job.queue_position === 0 ? "Next in line" : `${job.queue_position} ahead in the queue`}
        </p>
      ) : null}
      {reconnecting ? <p className="warning small">Lost contact with the server — retrying…</p> : null}
      <p className="muted small notice">
        {job?.notice ??
          "This version downloads and prepares the whole video before playback starts, so longer videos take longer."}
      </p>
      {job && state !== "ready" ? (
        <button type="button" className="button ghost small" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </div>
  );
}

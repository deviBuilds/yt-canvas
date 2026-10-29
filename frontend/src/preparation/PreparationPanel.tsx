import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

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

const CARD = "w-full max-w-md rounded-xl bg-[#212121]/95 p-5 text-left text-sm text-white shadow-2xl";
const BUTTON = "inline-flex h-9 cursor-pointer items-center rounded-full px-4 text-sm font-medium";

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
      <div className={CARD} role="alert" data-testid="preparation-error" data-code={error.code}>
        <h3 className="mb-2 text-lg font-medium text-[#ff8a80]">{ERROR_TITLES[error.code] ?? "Something went wrong"}</h3>
        <p>{error.message}</p>
        {error.hint ? <p className="mt-2 text-xs text-white/60">{error.hint}</p> : null}
        <button type="button" className={cn(BUTTON, "mt-4 bg-white text-black hover:bg-white/85")} onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  const state = job?.state ?? "queued";
  const currentIndex = STEPS.findIndex((step) => step.state === state);
  const progress = job?.progress;
  const fraction = progress?.fraction ?? null;
  const determinate = fraction !== null && state !== "queued" && state !== "resolving";
  const percent = Math.round((fraction ?? 0) * 100);
  const bytes =
    progress?.downloaded_bytes !== null && progress?.downloaded_bytes !== undefined
      ? progress.total_bytes
        ? `${formatBytes(progress.downloaded_bytes)} of ${formatBytes(progress.total_bytes)}`
        : formatBytes(progress.downloaded_bytes)
      : null;
  const speed = progress?.speed_bps ? `${formatBytes(progress.speed_bps)}/s` : null;
  const eta = formatEta(progress?.eta_seconds);

  return (
    <div className={CARD} role="status" aria-live="polite" data-testid="preparation" data-state={state}>
      <h3 className="mb-4 text-lg font-medium">{job ? "Preparing video" : "Starting…"}</h3>
      <ol className="mb-4 flex items-center" aria-label="Preparation steps">
        {STEPS.map((step, i) => {
          const done = i < currentIndex;
          const current = i === currentIndex;
          return (
            <li
              key={step.state}
              className={cn("flex flex-1 flex-col items-center gap-1.5 text-[11px] text-white/50", (done || current) && "text-white")}
              aria-current={current ? "step" : undefined}
            >
              <span className="relative flex w-full items-center justify-center">
                {i > 0 ? (
                  <span className={cn("absolute right-1/2 h-0.5 w-full", done || current ? "bg-brand" : "bg-white/20")} aria-hidden="true" />
                ) : null}
                <span
                  className={cn(
                    "relative flex size-5 items-center justify-center rounded-full border-2",
                    done ? "border-brand bg-brand" : current ? "border-brand bg-[#212121]" : "border-white/30 bg-[#212121]",
                  )}
                  aria-hidden="true"
                >
                  {done ? <Check className="size-3" strokeWidth={3} /> : current ? <span className="size-2 rounded-full bg-brand" /> : null}
                </span>
              </span>
              {step.label}
            </li>
          );
        })}
      </ol>
      <div
        className="relative my-2 h-1 overflow-hidden rounded-full bg-white/20"
        role="progressbar"
        aria-label="Preparation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
      >
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-300", !determinate && "indeterminate-bar w-1/3")}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
      <p>
        {progress?.detail ?? "Waiting for the server…"}
        {determinate ? ` · ${percent}%` : ""}
      </p>
      {bytes || speed || eta ? <p className="mt-1 text-xs text-white/60">{[bytes, speed, eta].filter(Boolean).join(" · ")}</p> : null}
      {job?.queue_position !== null && job?.queue_position !== undefined ? (
        <p className="mt-1 text-xs text-white/60">
          {job.queue_position === 0 ? "Next in line" : `${job.queue_position} ahead in the queue`}
        </p>
      ) : null}
      {reconnecting ? <p className="mt-2 text-xs text-[#ffd54f]">Lost contact with the server — retrying…</p> : null}
      <p className="mt-3 border-t border-white/15 pt-3 text-xs text-white/60">
        {job?.notice ??
          "This version downloads and prepares the whole video before playback starts, so longer videos take longer."}
      </p>
      {job && state !== "ready" ? (
        <button type="button" className={cn(BUTTON, "-ml-4 mt-2 text-[#3ea6ff] hover:bg-white/10")} onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </div>
  );
}

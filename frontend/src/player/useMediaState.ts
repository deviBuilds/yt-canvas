import { useCallback, useEffect, useState } from "react";

import { hasSource, type PlaybackMedia } from "./media";

export type MediaPhase = "empty" | "loading" | "ready" | "error";

export interface MediaState {
  phase: MediaPhase;
  paused: boolean;
  ended: boolean;
  /** Playback is stalled waiting for data (show a buffering indicator). */
  waiting: boolean;
  seeking: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  rate: number;
  videoWidth: number;
  videoHeight: number;
  error: string | null;
}

export const INITIAL_MEDIA_STATE: MediaState = {
  phase: "empty",
  paused: true,
  ended: false,
  waiting: false,
  seeking: false,
  currentTime: 0,
  duration: 0,
  bufferedEnd: 0,
  volume: 1,
  muted: false,
  rate: 1,
  videoWidth: 0,
  videoHeight: 0,
  error: null,
};

const MEDIA_ERRORS: Record<number, string> = {
  1: "Playback was aborted.",
  2: "A network error interrupted playback.",
  3: "This video could not be decoded by your browser.",
  4: "The prepared media is unavailable or in a format your browser can't play.",
};

export function describeMediaError(error: PlaybackMedia["error"], media?: PlaybackMedia): string {
  if (!error) return "Playback failed.";
  // The engine's messages are written for people; a media element's are browser internals.
  if (media && !(media instanceof HTMLMediaElement) && error.message) return error.message;
  return MEDIA_ERRORS[error.code] ?? "Playback failed.";
}

function bufferedEndAt(video: PlaybackMedia): number {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= video.currentTime + 0.5 && video.currentTime <= ranges.end(i)) return ranges.end(i);
  }
  return 0;
}

const EVENTS = [
  "loadstart",
  "loadedmetadata",
  "durationchange",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "play",
  "playing",
  "pause",
  "waiting",
  "stalled",
  "seeking",
  "seeked",
  "timeupdate",
  "progress",
  "ratechange",
  "volumechange",
  "ended",
  "error",
  "emptied",
  "resize",
] as const;

/** Mirror the media's state into React. ``sync`` can be called for extra updates. */
export function useMediaState(video: PlaybackMedia | null): [MediaState, () => void] {
  const [state, setState] = useState<MediaState>(INITIAL_MEDIA_STATE);

  const snapshot = useCallback(
    (patch: Partial<MediaState> = {}) => {
      if (!video) return;
      setState((prev) => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const next: MediaState = {
          ...prev,
          paused: video.paused,
          ended: video.ended,
          seeking: video.seeking,
          currentTime: video.currentTime,
          duration,
          bufferedEnd: bufferedEndAt(video),
          volume: video.volume,
          muted: video.muted,
          rate: video.playbackRate,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          ...patch,
        };
        // Avoid re-rendering when nothing visible changed.
        for (const key of Object.keys(next) as (keyof MediaState)[]) {
          if (next[key] !== prev[key]) return next;
        }
        return prev;
      });
    },
    [video],
  );

  useEffect(() => {
    if (!video) return;
    const onEvent = (event: Event) => {
      switch (event.type) {
        case "loadstart":
          snapshot({ phase: hasSource(video) ? "loading" : "empty", error: null, waiting: false });
          break;
        case "emptied":
          snapshot({ phase: hasSource(video) ? "loading" : "empty", error: null, waiting: false });
          break;
        case "loadeddata":
        case "canplay":
        case "canplaythrough":
          snapshot({ phase: "ready", waiting: false });
          break;
        case "waiting":
          snapshot({ waiting: true });
          break;
        case "playing":
        case "seeked":
        case "pause":
        case "ended":
          snapshot({ waiting: false });
          break;
        case "error":
          // A source-less element reports errors too; only surface real ones.
          if (hasSource(video)) snapshot({ phase: "error", waiting: false, error: describeMediaError(video.error, video) });
          break;
        default:
          snapshot();
      }
    };
    for (const type of EVENTS) video.addEventListener(type, onEvent);
    snapshot();
    return () => {
      for (const type of EVENTS) video.removeEventListener(type, onEvent);
    };
  }, [video, snapshot]);

  const sync = useCallback(() => snapshot(), [snapshot]);
  return [state, sync];
}

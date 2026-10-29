import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../api/http";
import { videoKey, type MediaRef, type StreamSession, type StreamTrack } from "../../api/types";
import { readJson, writeJson } from "../../library/storage";
import { streamsApi } from "./api";
import { canStream, type StreamPicks } from "./StreamLoader";

export type PlaybackMode = "stream" | "download";
/** "auto" or a maximum height in pixels. */
export type Quality = "auto" | number;

export interface PlaybackPrefs {
  mode: PlaybackMode;
  quality: Quality;
}

export const PLAYBACK_KEY = "ytc.playback.v1";
const DEFAULTS: PlaybackPrefs = { mode: "stream", quality: "auto" };
// What "Auto" aims for: YouTube's default on a desktop-sized player.
export const AUTO_HEIGHT = 1080;

function validPrefs(value: unknown): PlaybackPrefs | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const mode = v.mode === "download" ? "download" : "stream";
  const quality = typeof v.quality === "number" && v.quality > 0 ? v.quality : "auto";
  return { mode, quality };
}

/** Stream vs download and the preferred quality, remembered in this browser. */
export function usePlaybackPrefs(): [PlaybackPrefs, (next: Partial<PlaybackPrefs>) => void] {
  const [prefs, setPrefs] = useState<PlaybackPrefs>(() => readJson(PLAYBACK_KEY, validPrefs, DEFAULTS));
  const update = useCallback((next: Partial<PlaybackPrefs>) => {
    setPrefs((current) => {
      const merged = { ...current, ...next };
      writeJson(PLAYBACK_KEY, merged);
      return merged;
    });
  }, []);
  return [prefs, update];
}

/** H.264 decodes in hardware almost everywhere; prefer it over AV1 at the same height. */
const preference = (track: StreamTrack) => (track.codecs.startsWith("avc1") ? 0 : 1);

/** The best video track at or under the quality cap that this browser can decode, plus an audio track. */
export function pickTracks(session: StreamSession, quality: Quality, canDecode: (track: StreamTrack) => boolean = canStream): StreamPicks | null {
  const videos = session.video_tracks.filter(canDecode);
  const audio = session.audio_tracks.find(canDecode);
  if (videos.length === 0 || !audio) return null;
  const cap = quality === "auto" ? AUTO_HEIGHT : quality;
  const fitting = videos.filter((track) => (track.height ?? 0) <= cap);
  const pool = fitting.length > 0 ? fitting : [videos.reduce((a, b) => ((a.height ?? 0) <= (b.height ?? 0) ? a : b))];
  const best = Math.max(...pool.map((track) => track.height ?? 0));
  const video = pool
    .filter((track) => (track.height ?? 0) === best)
    .sort((a, b) => preference(a) - preference(b) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]!;
  return { session, video, audio };
}

/** Heights the browser can stream for this session, highest first. */
export function streamQualities(session: StreamSession | null, canDecode: (track: StreamTrack) => boolean = canStream): number[] {
  if (!session) return [];
  const heights = session.video_tracks.filter(canDecode).map((track) => track.height ?? 0).filter((h) => h > 0);
  return [...new Set(heights)].sort((a, b) => b - a);
}

export function codecLabel(codecs: string): string {
  if (codecs.startsWith("avc1")) return "H.264";
  if (codecs.startsWith("av01")) return "AV1";
  if (codecs.startsWith("mp4a")) return "AAC";
  return codecs.split(".")[0]!.toUpperCase();
}

export interface StreamState {
  session: StreamSession | null;
  error: ApiError | null;
  loading: boolean;
  /** Ask for a fresh session (e.g. the old one expired). */
  renew: () => void;
}

/** Create (and renew on request) a streaming session for ``ref``; ``null`` does nothing. */
export function useStreamSession(ref: MediaRef | null): StreamState {
  const key = ref ? videoKey(ref) : null;
  const [state, setState] = useState<{ key: string | null; session: StreamSession | null; error: ApiError | null }>({
    key: null,
    session: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ref || !key) return;
    setState((s) => (s.key === key ? { ...s, error: null } : { key, session: null, error: null }));
    const controller = new AbortController();
    streamsApi
      .create(ref, controller.signal)
      .then((session) => setState({ key, session, error: null }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        const error =
          err instanceof ApiError
            ? err
            : new ApiError(0, { code: "error", message: "Streaming couldn't start.", hint: null, retryable: true });
        setState({ key, session: null, error });
      });
    return () => controller.abort();
    // ``ref`` is identified by ``key``.
  }, [key, attempt]);

  const renew = useCallback(() => setAttempt((n) => n + 1), []);
  const current = state.key === key;
  return {
    session: current ? state.session : null,
    error: current ? state.error : null,
    loading: Boolean(key) && (!current || (state.session === null && state.error === null)),
    renew,
  };
}

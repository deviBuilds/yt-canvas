import { ApiError } from "../../api/http";
import type { StreamSession, StreamTrack } from "../../api/types";
import { streamsApi } from "../streaming/api";
import { parseTrackHead } from "../streaming/mp4Index";
import { locateMoov, Mp4Error, parseFragments, parseMovie, readBox, type MovieTrack, type TrackConfig } from "./mp4";

/** One compressed sample, timed in microseconds of presentation time (what WebCodecs expects). */
export interface EncodedSample {
  data: Uint8Array;
  timestamp: number;
  duration: number;
  key: boolean;
}

/** A unit of fetching: a DASH segment, or a GOP-sized window of a prepared file. Seconds. */
export interface ReaderSegment {
  time: number;
  duration: number;
}

export interface TrackReader {
  readonly config: TrackConfig;
  /** In presentation order; video segments start with a key frame. */
  readonly segments: ReaderSegment[];
  /** The segment's samples in decode order. */
  load(index: number, signal: AbortSignal): Promise<EncodedSample[]>;
}

export interface MediaReaders {
  /** Seconds. */
  duration: number;
  video: TrackReader | null;
  audio: TrackReader | null;
}

/** Bytes ``start``–``end`` (inclusive) of a resource. */
export type RangeFetcher = (start: number, end: number, signal?: AbortSignal) => Promise<ArrayBuffer>;

/** Something the canvas engine can play. */
export interface EngineSource {
  /** Identifies the source (the engine's "src"). */
  readonly id: string;
  open(signal: AbortSignal): Promise<MediaReaders>;
  /**
   * Reading failed (expired session, YouTube refusing, unsupported codec).
   * Return true when the caller handles it, e.g. by switching to another source;
   * otherwise the engine reports a playback error.
   */
  onError?(error: unknown): boolean;
}

const HEAD_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 8 * 1024 * 1024;
const FILE_HEAD_BYTES = 512 * 1024;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
// The backend proxies at most 16 MiB per stream request.
const MAX_RANGE_BYTES = 12 * 1024 * 1024;
const MAX_RETRIES = 3;
// A prepared file without key frames every few seconds is still read in windows of about this length.
const AUDIO_WINDOW_SECONDS = 4;

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

/** Network hiccups and 5xx (except 502, YouTube refusing) are retried with backoff. */
function withRetries(fetcher: RangeFetcher): RangeFetcher {
  return async (start, end, signal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetcher(start, end, signal);
      } catch (err) {
        const retryable = err instanceof ApiError && (err.isNetwork || (err.status >= 500 && err.status !== 502));
        if (isAbort(err) || !retryable || attempt >= MAX_RETRIES - 1) throw err;
        await sleep(500 * 2 ** attempt, signal);
      }
    }
  };
}

/** One request, or several when the range is larger than the proxy allows. */
async function fetchSpan(fetcher: RangeFetcher, start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (end - start + 1 <= MAX_RANGE_BYTES) return fetcher(start, end, signal);
  const joined = new Uint8Array(end - start + 1);
  for (let from = start; from <= end; from += MAX_RANGE_BYTES) {
    const part = await fetcher(from, Math.min(end, from + MAX_RANGE_BYTES - 1), signal);
    joined.set(new Uint8Array(part), from - start);
  }
  return joined.buffer;
}

const micros = (ticks: number, track: MovieTrack) => Math.round((ticks / track.timescale + track.shift) * 1e6);

// -- DASH tracks (one fragmented MP4 per track, with a sidx) ------------------------------

async function openDashTrack(fetcher: RangeFetcher, kind: "video" | "audio", signal: AbortSignal): Promise<TrackReader> {
  let head = await fetcher(0, HEAD_BYTES - 1, signal);
  let parsed = parseTrackHead(head);
  if (parsed.kind === "need" && parsed.bytes <= MAX_HEAD_BYTES) {
    head = await fetcher(0, parsed.bytes - 1, signal);
    parsed = parseTrackHead(head);
  }
  if (parsed.kind !== "index") throw new Mp4Error(`This ${kind} track has no usable segment index.`);
  const moov = locateMoov(head);
  if (moov.kind !== "found") throw new Mp4Error(`This ${kind} track has no movie header.`);
  const track = parseMovie(new Uint8Array(head, 0, moov.end), moov.start).tracks.find((t) => t.config?.kind === kind);
  if (!track?.config) throw new Mp4Error(`This ${kind} track uses a codec the canvas engine can't read.`);
  const index = parsed.index.segments;
  return {
    config: track.config,
    segments: index.map((segment) => ({ time: segment.time + track.shift, duration: segment.duration })),
    async load(i, loadSignal) {
      const segment = index[i]!;
      const data = new Uint8Array(await fetchSpan(fetcher, segment.start, segment.end, loadSignal));
      return parseFragments(data, segment.start, track).map((sample) => ({
        data: sample.data,
        timestamp: micros(sample.cts, track),
        duration: Math.round((sample.duration / track.timescale) * 1e6),
        key: sample.key,
      }));
    },
  };
}

/** A streaming session's video and audio tracks, read through the backend's range proxy. */
export function dashSource(
  session: StreamSession,
  video: StreamTrack,
  audio: StreamTrack,
  onError?: (error: unknown) => boolean,
): EngineSource {
  const fetcher = (track: StreamTrack) =>
    withRetries((start, end, signal) => streamsApi.range(session.session_id, track.id, start, end, signal));
  return {
    id: `stream:${session.session_id}:${video.id}:${audio.id}`,
    async open(signal) {
      const [videoReader, audioReader] = await Promise.all([
        openDashTrack(fetcher(video), "video", signal),
        openDashTrack(fetcher(audio), "audio", signal),
      ]);
      const end = (reader: TrackReader) => {
        const last = reader.segments[reader.segments.length - 1];
        return last ? last.time + last.duration : 0;
      };
      return {
        duration: session.duration_seconds || Math.max(end(videoReader), end(audioReader)),
        video: videoReader,
        audio: audioReader,
      };
    },
    onError,
  };
}

// -- prepared files (one regular MP4, both tracks interleaved) -----------------------------

interface Window {
  time: number;
  duration: number;
  /** Sample index ranges [from, to) in decode order. */
  video: [number, number];
  audio: [number, number];
  /** Inclusive byte range covering every sample of the window. */
  start: number;
  end: number;
}

function buildWindows(video: MovieTrack | undefined, audio: MovieTrack | undefined): Window[] {
  const pts = (track: MovieTrack, i: number) => track.table!.cts[i]! / track.timescale + track.shift;
  const starts: number[] = []; // window start times
  const videoStarts: number[] = [];
  if (video?.table) {
    const { keys, count } = video.table;
    for (let i = 0; i < count; i++) if (keys[i] || i === 0) videoStarts.push(i);
    for (const i of videoStarts) starts.push(pts(video, i));
  } else if (audio?.table) {
    const last = pts(audio, audio.table.count - 1);
    for (let t = Math.min(0, pts(audio, 0)); t <= last; t += AUDIO_WINDOW_SECONDS) starts.push(t);
  }

  const windows: Window[] = [];
  let audioIndex = 0;
  for (let w = 0; w < starts.length; w++) {
    const time = starts[w]!;
    const next = w + 1 < starts.length ? starts[w + 1]! : Infinity;
    const videoRange: [number, number] = video?.table
      ? [videoStarts[w]!, w + 1 < videoStarts.length ? videoStarts[w + 1]! : video.table.count]
      : [0, 0];
    const audioFrom = audioIndex;
    if (audio?.table) {
      // The first window also takes audio that starts before the first frame.
      while (audioIndex < audio.table.count && pts(audio, audioIndex) < next) audioIndex++;
    }
    let start = Infinity;
    let end = -1;
    let last = time;
    const span = (track: MovieTrack, [from, to]: [number, number]) => {
      const table = track.table!;
      for (let i = from; i < to; i++) {
        start = Math.min(start, table.offsets[i]!);
        end = Math.max(end, table.offsets[i]! + table.sizes[i]! - 1);
        last = Math.max(last, pts(track, i) + table.durations[i]! / track.timescale);
      }
    };
    if (video?.table) span(video, videoRange);
    if (audio?.table) span(audio, [audioFrom, audioIndex]);
    if (end < 0) continue;
    windows.push({
      time,
      duration: (Number.isFinite(next) ? next : last) - time,
      video: videoRange,
      audio: [audioFrom, audioIndex],
      start,
      end,
    });
  }
  return windows;
}

async function readMoov(fetcher: RangeFetcher, signal: AbortSignal): Promise<Uint8Array> {
  let head = await fetcher(0, FILE_HEAD_BYTES - 1, signal);
  let where = locateMoov(head);
  for (let guard = 0; guard < 8; guard++) {
    if (where.kind === "found") return new Uint8Array(head, where.start, where.end - where.start);
    if (where.kind === "need") {
      if (where.bytes > MAX_MOOV_BYTES) break;
      head = await fetcher(0, where.bytes - 1, signal);
      where = locateMoov(head);
      continue;
    }
    if (where.kind === "at") {
      // moov after a large mdat: read the next top-level box header, then the box.
      const probe = await fetcher(where.offset, where.offset + 15, signal);
      const box = probe.byteLength >= 8 ? readBox(new DataView(probe), 0, Number.MAX_SAFE_INTEGER) : null;
      if (!box || "need" in box) break;
      if (box.type === "moov") {
        if (box.size > MAX_MOOV_BYTES) break;
        return new Uint8Array(await fetchSpan(fetcher, where.offset, where.offset + box.size - 1, signal));
      }
      where = { kind: "at", offset: where.offset + box.size };
      continue;
    }
    break;
  }
  throw new Mp4Error("This file has no readable movie header.");
}

async function openFile(fetcher: RangeFetcher, signal: AbortSignal): Promise<MediaReaders> {
  const movie = parseMovie(await readMoov(fetcher, signal));
  if (movie.fragmented) throw new Mp4Error("Fragmented files are only read as DASH tracks.");
  const video = movie.tracks.find((t) => t.config?.kind === "video" && t.table);
  const audio = movie.tracks.find((t) => t.config?.kind === "audio" && t.table);
  if (!video && !audio) throw new Mp4Error("This file has no track the canvas engine can decode.");
  const windows = buildWindows(video, audio);
  if (windows.length === 0) throw new Mp4Error("This file has no samples.");

  // Both tracks are interleaved in the file, so a window is fetched once and shared.
  const cache = new Map<number, Promise<ArrayBuffer>>();
  const fetchWindow = (i: number) => {
    let pending = cache.get(i);
    if (!pending) {
      const window = windows[i]!;
      pending = fetchSpan(fetcher, window.start, window.end);
      pending.catch(() => cache.delete(i));
      cache.set(i, pending);
      for (const key of cache.keys()) {
        if (cache.size <= 8) break;
        cache.delete(key);
      }
    }
    return pending;
  };
  const untilAborted = <T,>(promise: Promise<T>, abort: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      if (abort.aborted) return reject(new DOMException("Aborted", "AbortError"));
      abort.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      promise.then(resolve, reject);
    });

  const reader = (track: MovieTrack, pick: (window: Window) => [number, number]): TrackReader => ({
    config: track.config!,
    segments: windows.map((window) => ({ time: window.time, duration: window.duration })),
    async load(i, loadSignal) {
      const window = windows[i]!;
      const bytes = await untilAborted(fetchWindow(i), loadSignal);
      const table = track.table!;
      const [from, to] = pick(window);
      const samples: EncodedSample[] = [];
      for (let s = from; s < to; s++) {
        samples.push({
          data: new Uint8Array(bytes, table.offsets[s]! - window.start, table.sizes[s]!),
          timestamp: micros(table.cts[s]!, track),
          duration: Math.round((table.durations[s]! / track.timescale) * 1e6),
          key: track.config!.kind === "audio" || table.keys[s] === 1,
        });
      }
      return samples;
    },
  });

  const lastWindow = windows[windows.length - 1]!;
  return {
    duration: movie.duration || Math.max(video?.duration ?? 0, audio?.duration ?? 0) || lastWindow.time + lastWindow.duration,
    video: video ? reader(video, (window) => window.video) : null,
    audio: audio ? reader(audio, (window) => window.audio) : null,
  };
}

/** A same-origin MP4 read with HTTP range requests (the prepared "Download first" file). */
export function fileSource(url: string): EngineSource {
  const fetcher = withRetries(async (start, end, signal) => {
    let response: Response;
    try {
      response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ApiError(0, { code: "network_error", message: "Lost contact with the server.", hint: null, retryable: true });
    }
    if (response.status === 416) return new ArrayBuffer(0);
    if (!response.ok) {
      throw new ApiError(response.status, {
        code: "error",
        message: `Reading the video failed (${response.status}).`,
        hint: null,
        retryable: response.status >= 500,
      });
    }
    const body = await response.arrayBuffer();
    // A server that ignores Range sends the whole file.
    return response.status === 200 && (start > 0 || body.byteLength > end + 1) ? body.slice(start, end + 1) : body;
  });
  return { id: url, open: (signal) => openFile(fetcher, signal) };
}

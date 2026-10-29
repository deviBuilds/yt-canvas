import { ApiError } from "../../api/http";
import type { StreamSession, StreamTrack } from "../../api/types";
import { streamsApi } from "./api";
import { parseTrackHead, segmentAt, type TrackIndex } from "./mp4Index";

// How much of each track to read first; YouTube's moov + sidx fit easily.
const HEAD_BYTES = 64 * 1024;
const MAX_HEAD_BYTES = 8 * 1024 * 1024;
// Keep this much buffered ahead of the playhead, and drop what's further behind.
const AHEAD_SECONDS = 30;
const BEHIND_SECONDS = 30;
const TICK_MS = 500;
// The playhead stops at a hole in the buffer instead of crossing it; holes up to this size are skipped.
const MAX_GAP_SECONDS = 1;
const MAX_RETRIES = 3;
// The backend proxies at most 16 MiB per request; 4K AV1 segments can come close.
const MAX_RANGE_BYTES = 12 * 1024 * 1024;

export interface StreamPicks {
  session: StreamSession;
  video: StreamTrack;
  audio: StreamTrack;
}

export interface StreamLoaderOptions extends StreamPicks {
  /** Something streaming can't recover from (expired session, YouTube refusing, unsupported track). */
  onError: (error: ApiError) => void;
}

interface Lane {
  track: StreamTrack;
  index: TrackIndex;
  buffer: SourceBuffer;
  /** Next segment to fetch. */
  next: number;
  busy: boolean;
  controller: AbortController | null;
}

export const mimeFor = (track: StreamTrack) => `${track.mime_type}; codecs="${track.codecs}"`;

export function canStream(track: StreamTrack): boolean {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mimeFor(track));
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function failure(code: string, message: string): ApiError {
  return new ApiError(422, { code, message, hint: null, retryable: false });
}

/** End of the buffered range that contains ``time``, or null when ``time`` isn't buffered. */
function bufferedEnd(buffer: SourceBuffer, time: number): number | null {
  const ranges = buffer.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= time + 0.05 && time < ranges.end(i)) return ranges.end(i);
  }
  return null;
}

function whenIdle(buffer: SourceBuffer): Promise<void> {
  if (!buffer.updating) return Promise.resolve();
  return new Promise((resolve) => buffer.addEventListener("updateend", () => resolve(), { once: true }));
}

/** Run one SourceBuffer operation (append or remove) and wait for it to finish. */
async function operate(buffer: SourceBuffer, run: (b: SourceBuffer) => void): Promise<void> {
  await whenIdle(buffer);
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      buffer.removeEventListener("updateend", done);
      buffer.removeEventListener("error", failed);
      resolve();
    };
    const failed = () => {
      buffer.removeEventListener("updateend", done);
      buffer.removeEventListener("error", failed);
      reject(failure("stream_unavailable", "The browser couldn't decode this stream."));
    };
    buffer.addEventListener("updateend", done);
    buffer.addEventListener("error", failed);
    try {
      run(buffer);
    } catch (err) {
      buffer.removeEventListener("updateend", done);
      buffer.removeEventListener("error", failed);
      reject(err);
    }
  });
}

/**
 * Stream a session into ``media`` through Media Source Extensions: read each
 * track's index, append the init segments, then keep about 30 s of segments
 * buffered ahead of the playhead, following seeks. Nothing is stored on disk;
 * the backend proxies each byte range from YouTube. Returns a detach function.
 */
export function attachStream(media: HTMLVideoElement, options: StreamLoaderOptions): () => void {
  const { session, onError } = options;
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  const lanes: Lane[] = [];
  const cleanups: Array<() => void> = [];
  let closed = false;
  let failed = false;

  const fail = (err: unknown) => {
    if (closed || failed || isAbort(err)) return;
    failed = true;
    onError(err instanceof ApiError ? err : failure("stream_unavailable", "Streaming stopped unexpectedly."));
  };

  // Network hiccups are retried; anything else (expired session, YouTube refusing) is reported.
  const fetchRange = async (track: StreamTrack, start: number, end: number, signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await streamsApi.range(session.session_id, track.id, start, end, signal);
      } catch (err) {
        const retryable = err instanceof ApiError && (err.isNetwork || (err.status >= 500 && err.status !== 502));
        if (isAbort(err) || !retryable || attempt >= MAX_RETRIES - 1) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
  };

  // One request per segment, split when a segment is bigger than the proxy allows.
  const fetchSegment = async (track: StreamTrack, start: number, end: number, signal: AbortSignal) => {
    if (end - start + 1 <= MAX_RANGE_BYTES) return fetchRange(track, start, end, signal);
    const parts: ArrayBuffer[] = [];
    for (let from = start; from <= end; from += MAX_RANGE_BYTES) {
      parts.push(await fetchRange(track, from, Math.min(end, from + MAX_RANGE_BYTES - 1), signal));
    }
    const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      joined.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return joined.buffer;
  };

  const loadIndex = async (track: StreamTrack) => {
    let head = await fetchRange(track, 0, HEAD_BYTES - 1);
    let parsed = parseTrackHead(head);
    if (parsed.kind === "need" && parsed.bytes <= MAX_HEAD_BYTES) {
      head = await fetchRange(track, 0, parsed.bytes - 1);
      parsed = parseTrackHead(head);
    }
    if (parsed.kind !== "index") throw failure("stream_unavailable", "This video's stream has no usable segment index.");
    return { index: parsed.index, init: head.slice(0, parsed.index.initEnd) };
  };

  const evictBehind = async (lane: Lane, keepFrom: number) => {
    const ranges = lane.buffer.buffered;
    if (ranges.length === 0 || keepFrom <= 0 || ranges.start(0) >= keepFrom - 1) return;
    await operate(lane.buffer, (b) => b.remove(0, keepFrom));
  };

  const append = async (lane: Lane, data: ArrayBuffer) => {
    try {
      await operate(lane.buffer, (b) => b.appendBuffer(data));
    } catch (err) {
      // The browser's buffer is full: drop everything but the last few seconds behind and retry once.
      if (!(err instanceof DOMException && err.name === "QuotaExceededError")) throw err;
      await evictBehind(lane, media.currentTime - 5);
      await operate(lane.buffer, (b) => b.appendBuffer(data));
    }
  };

  const maybeEnd = () => {
    if (source.readyState !== "open") return;
    if (lanes.length === 0 || lanes.some((lane) => lane.busy || lane.buffer.updating || lane.next < lane.index.segments.length)) return;
    try {
      source.endOfStream();
    } catch {
      // A buffer started updating in between; the next tick ends the stream.
    }
  };

  const pumpLane = async (lane: Lane): Promise<void> => {
    while (!closed && !failed && !lane.busy) {
      const segments = lane.index.segments;
      if (lane.next >= segments.length) return maybeEnd();
      const time = media.currentTime;
      const segment = segments[lane.next]!;
      if (segment.time > time + AHEAD_SECONDS) return; // far enough ahead
      if (bufferedEnd(lane.buffer, segment.time + segment.duration / 2) !== null) {
        lane.next++; // already there (e.g. after seeking back)
        continue;
      }
      const target = lane.next;
      lane.busy = true;
      lane.controller = new AbortController();
      try {
        const data = await fetchSegment(lane.track, segment.start, segment.end, lane.controller.signal);
        if (closed || lane.next !== target) continue; // a seek moved on while fetching
        await evictBehind(lane, media.currentTime - BEHIND_SECONDS);
        await append(lane, data);
        if (lane.next === target) lane.next = target + 1;
      } catch (err) {
        if (isAbort(err)) continue;
        return fail(err);
      } finally {
        lane.busy = false;
        lane.controller = null;
      }
    }
  };

  const pump = () => {
    for (const lane of lanes) void pumpLane(lane);
  };

  // Audio and video segments rarely line up exactly, so the buffer can start a little after 0 or
  // have a small hole between segments. Playback waits there forever; step over the hole instead.
  const skipGap = () => {
    if (media.paused || media.seeking || media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
    const time = media.currentTime;
    const ranges = media.buffered;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      if (start > time && start - time <= MAX_GAP_SECONDS) {
        media.currentTime = start + 0.01;
        return;
      }
    }
  };

  const tick = () => {
    skipGap();
    pump();
  };

  const onSeeking = () => {
    const time = media.currentTime;
    for (const lane of lanes) {
      const end = bufferedEnd(lane.buffer, time);
      // Not buffered: drop the fetch in flight and start from the segment that holds the new time.
      if (end === null) lane.controller?.abort();
      lane.next = segmentAt(lane.index.segments, end ?? time);
    }
    pump();
  };

  const start = async () => {
    try {
      const heads = await Promise.all([options.video, options.audio].map(loadIndex));
      if (closed || source.readyState !== "open") return;
      const tracks = [options.video, options.audio];
      tracks.forEach((track, i) => {
        if (!MediaSource.isTypeSupported(mimeFor(track))) throw failure("stream_unavailable", `This browser can't play ${track.codecs}.`);
        lanes.push({ track, index: heads[i]!.index, buffer: source.addSourceBuffer(mimeFor(track)), next: 0, busy: false, controller: null });
      });
      // Before the init segments, so "loadedmetadata" already sees a finite duration (resume needs it).
      source.duration = session.duration_seconds ?? Math.max(...lanes.map((lane) => lane.index.duration));
      await Promise.all(lanes.map((lane, i) => append(lane, heads[i]!.init)));
      if (closed) return;
      for (const [event, handler] of [["seeking", onSeeking], ["timeupdate", pump], ["playing", pump], ["waiting", tick]] as const) {
        media.addEventListener(event, handler);
        cleanups.push(() => media.removeEventListener(event, handler));
      }
      const timer = window.setInterval(tick, TICK_MS);
      cleanups.push(() => window.clearInterval(timer));
      pump();
    } catch (err) {
      fail(err);
    }
  };

  source.addEventListener("sourceopen", () => void start(), { once: true });
  media.src = url;

  return () => {
    closed = true;
    for (const lane of lanes) lane.controller?.abort();
    for (const cleanup of cleanups) cleanup();
    URL.revokeObjectURL(url);
  };
}

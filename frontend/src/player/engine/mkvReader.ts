import { findCluster, ID, MkvError, parseCues, parseHead, readClusters, readElement, type ClusterScan, type MkvHead, type MkvTrack } from "./mkv";
import {
  fetchSpan,
  httpRangeFetcher,
  untilAborted,
  type EncodedSample,
  type EngineSource,
  type MediaReaders,
  type RangeFetcher,
  type TrackReader,
} from "./readers";

/**
 * Plays a Matroska or WebM file by reading byte ranges: the head (tracks), the Cues, then
 * windows of clusters as playback reaches them. Nothing is downloaded first, and memory
 * holds only the windows the engine keeps (about 20 s ahead).
 *
 * A window starts at a key frame of the reference track (video, or audio in audio-only
 * files) and ends just before the next window's key frame. Clusters needn't start at key
 * frames (mkvmerge's don't), so the split is by the byte position of the key frame's
 * block, not by cluster: every frame belongs to exactly one window, and every window can be
 * decoded on its own after a seek. Without Cues, windows are fixed byte spans whose times
 * are estimated from their position, and each still starts at a key frame.
 */

const HEAD_BYTES = 1024 * 1024;
const MAX_HEAD_BYTES = 16 * 1024 * 1024;
const MAX_CUES_BYTES = 32 * 1024 * 1024;
// About 4 MiB per window (4.5 s of a 7 Mbit/s movie), and at most 10 s.
const WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_WINDOW_SECONDS = 10;
// Extra bytes read past a window to find the next window's key frame, when the file doesn't say where it is.
const PEEK_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const CACHED_WINDOWS = 6;

export interface MkvSourceOptions {
  /** The audio track number to play; otherwise the default (or first) decodable one. */
  audioTrack?: number;
  /** Tuning, mainly for tests: target bytes per window, and how much to read for the head. */
  windowBytes?: number;
  headBytes?: number;
}

/** Where a window's frames begin: a cue's key frame, or the first key frame after a byte offset. */
type Boundary =
  | { kind: "cue"; cluster: number; relative: number | null; time: number }
  | { kind: "bytes"; at: number }
  // The first window: every frame from the first cluster on, such as audio stored before the first key frame.
  | { kind: "start"; at: number };

interface Window {
  time: number;
  duration: number;
  from: Boundary;
  /** Null for the last window, which runs to the end of the clusters. */
  to: Boundary | null;
  /** Absolute byte range to read first, [start, end). */
  start: number;
  end: number;
}

interface WindowFrames {
  video: EncodedSample[];
  audio: EncodedSample[];
}

function pickTracks(head: MkvHead, options: MkvSourceOptions): { video: MkvTrack | null; audio: MkvTrack | null } {
  const usable = (kind: "video" | "audio") => head.tracks.filter((track) => track.kind === kind && track.enabled);
  const preferred = (tracks: MkvTrack[]) =>
    tracks.find((track) => track.config && track.isDefault) ?? tracks.find((track) => track.config) ?? null;
  const videos = usable("video");
  const audios = usable("audio");
  const video = preferred(videos);
  if (options.audioTrack !== undefined && !audios.some((track) => track.number === options.audioTrack)) {
    throw new MkvError(`This file has no audio track ${options.audioTrack}.`);
  }
  const audio =
    options.audioTrack !== undefined ? (audios.find((track) => track.number === options.audioTrack) ?? null) : preferred(audios);
  if (videos.length > 0 && !video) throw new MkvError(`This file's video (${videos[0]!.codecName}) can't be decoded in the browser.`);
  const wanted = options.audioTrack !== undefined ? audios.find((track) => track.number === options.audioTrack) : audios[0];
  if (wanted && !audio?.config) throw new MkvError(`This file's audio (${wanted.codecName}) can't be decoded in the browser.`);
  if (!video && !audio) throw new MkvError("This file has no track the canvas engine can decode.");
  return { video, audio };
}

/** Read one level-1 element at an absolute offset: its header first, then all of it. */
async function readElementAt(fetcher: RangeFetcher, at: number, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const probe = new Uint8Array(await fetcher(at, at + 15, signal));
  const element = readElement(probe, 0);
  if (!element || "need" in element || element.size < 0 || element.end > maxBytes) throw new MkvError("Can't read the file's index.");
  return new Uint8Array(await fetchSpan(fetcher, at, at + element.end - 1, signal));
}

async function readHead(fetcher: RangeFetcher, headBytes: number, signal: AbortSignal): Promise<MkvHead> {
  let bytes = new Uint8Array(await fetcher(0, headBytes - 1, signal));
  for (let guard = 0; guard < 6; guard++) {
    const head = parseHead(bytes);
    if (!("need" in head)) return head;
    if (head.need > MAX_HEAD_BYTES || bytes.length < headBytes) break; // already at the end of the file
    bytes = new Uint8Array(await fetchSpan(fetcher, 0, Math.min(MAX_HEAD_BYTES, Math.max(head.need, bytes.length * 2)) - 1, signal));
  }
  throw new MkvError("This Matroska file's tracks couldn't be read.");
}

/** The first frame time and the last frame end, from the head's first cluster and the file's tail. */
async function timeSpan(
  fetcher: RangeFetcher,
  head: MkvHead,
  tracks: MkvTrack[],
  clustersEnd: number,
  signal: AbortSignal,
): Promise<{ first: number; last: number }> {
  const firstBytes = new Uint8Array(await fetcher(head.firstCluster!, Math.min(clustersEnd, head.firstCluster! + PEEK_BYTES) - 1, signal));
  const first = readClusters(firstBytes, head.firstCluster!, head, tracks).frames[0]?.timestamp ?? 0;
  const tailStart = Math.max(head.firstCluster!, clustersEnd - TAIL_BYTES);
  const tail = new Uint8Array(await fetchSpan(fetcher, tailStart, clustersEnd - 1, signal));
  let last = first;
  // The first real cluster in the tail reads through to the end; skip false matches that yield nothing.
  for (let at = findCluster(tail, 0); at >= 0; at = findCluster(tail, at + 1)) {
    const frames = readClusters(tail.subarray(at), tailStart + at, head, tracks).frames;
    if (frames.length === 0) continue;
    for (const frame of frames) last = Math.max(last, frame.timestamp + frame.duration);
    break;
  }
  return { first: first / 1e6, last: last / 1e6 };
}

function cueWindows(cues: ReturnType<typeof parseCues>, reference: number, clustersEnd: number, duration: number, windowBytes: number): Window[] {
  const points = cues.filter((cue) => cue.track === reference);
  const unique = points.filter((cue, i) => i === 0 || cue.cluster !== points[i - 1]!.cluster || cue.relative !== points[i - 1]!.relative);
  const starts: typeof unique = [];
  for (const cue of unique) {
    const open = starts[starts.length - 1];
    if (!open || cue.cluster - open.cluster >= windowBytes || cue.time - open.time >= MAX_WINDOW_SECONDS) starts.push(cue);
  }
  const boundary = (cue: (typeof starts)[number]): Boundary => ({ kind: "cue", cluster: cue.cluster, relative: cue.relative, time: cue.time });
  return starts.map((cue, i) => {
    const next = starts[i + 1];
    // Read up to the next window's key frame block (or a little into its cluster to find it).
    const end = !next ? clustersEnd : next.relative !== null ? next.cluster + 12 + next.relative : Math.min(clustersEnd, next.cluster + PEEK_BYTES);
    return {
      time: cue.time,
      duration: (next ? next.time : Math.max(duration, cue.time)) - cue.time,
      from: boundary(cue),
      to: next ? boundary(next) : null,
      start: cue.cluster,
      end,
    };
  });
}

function byteWindows(firstCluster: number, clustersEnd: number, span: { first: number; last: number }, windowBytes: number): Window[] {
  const total = clustersEnd - firstCluster;
  const count = Math.max(1, Math.ceil(total / windowBytes));
  const timeAt = (offset: number) => span.first + ((offset - firstCluster) / total) * (span.last - span.first);
  return Array.from({ length: count }, (_, i) => {
    const at = firstCluster + i * windowBytes;
    const next = i + 1 < count ? firstCluster + (i + 1) * windowBytes : null;
    return {
      time: timeAt(at),
      duration: timeAt(next ?? clustersEnd) - timeAt(at),
      from: { kind: "bytes", at } as Boundary,
      to: next === null ? null : ({ kind: "bytes", at: next } as Boundary),
      start: at,
      end: next === null ? clustersEnd : Math.min(clustersEnd, next + PEEK_BYTES),
    };
  });
}

/** The absolute position where a boundary's frames start, or null if the bytes read don't reach it yet. */
function boundaryPosition(scan: ClusterScan, boundary: Boundary, reference: number): number | null {
  if (boundary.kind === "start") return boundary.at;
  if (boundary.kind === "cue") {
    const dataStart = scan.clusters.get(boundary.cluster);
    if (dataStart === undefined) return null;
    if (boundary.relative !== null) return dataStart + boundary.relative;
    const target = Math.round(boundary.time * 1e6) - 1000;
    return scan.frames.find((f) => f.track === reference && f.key && f.position >= boundary.cluster && f.timestamp >= target)?.position ?? null;
  }
  // The first cluster that starts at or after the offset, then its first key frame.
  let cluster = Infinity;
  for (const start of scan.clusters.keys()) if (start >= boundary.at && start < cluster) cluster = start;
  if (cluster === Infinity) return null;
  return scan.frames.find((f) => f.track === reference && f.key && f.position >= cluster)?.position ?? null;
}

export async function openMkv(
  fetcher: RangeFetcher,
  fileSize: () => number | null,
  signal: AbortSignal,
  options: MkvSourceOptions = {},
): Promise<MediaReaders> {
  const windowBytes = options.windowBytes ?? WINDOW_BYTES;
  const head = await readHead(fetcher, options.headBytes ?? HEAD_BYTES, signal);
  if (head.firstCluster === null) throw new MkvError("This Matroska file has no clusters.");
  const { video, audio } = pickTracks(head, options);
  const reference = (video ?? audio)!.number;
  const tracks = [video, audio].filter((track): track is MkvTrack => track !== null);

  // Clusters end where the next level-1 element after them starts, or with the Segment or file.
  const after = [...head.positions.entries()]
    .filter(([id, at]) => id !== ID.Cluster && at > head.firstCluster!)
    .map(([, at]) => at);
  const clustersEnd = Math.min(...after, head.segmentEnd, fileSize() ?? Infinity);
  if (!Number.isFinite(clustersEnd)) throw new MkvError("This file's size is unknown.");

  let cues = head.cues;
  const cuesAt = head.positions.get(ID.Cues);
  if (!cues && cuesAt !== undefined) {
    try {
      cues = parseCues(await readElementAt(fetcher, cuesAt, MAX_CUES_BYTES, signal), head);
    } catch (err) {
      if (!(err instanceof MkvError)) throw err; // a broken index: fall back to byte windows
    }
  }
  const hasCues = Boolean(cues?.some((cue) => cue.track === reference));
  const span = head.duration > 0 && hasCues ? { first: 0, last: head.duration } : await timeSpan(fetcher, head, tracks, clustersEnd, signal);
  const duration = head.duration || span.last;
  const windows = hasCues
    ? cueWindows(cues!, reference, clustersEnd, duration, windowBytes)
    : byteWindows(head.firstCluster, clustersEnd, span, windowBytes);
  if (windows.length === 0) throw new MkvError("This file has no frames to play.");
  windows[0]!.start = head.firstCluster;
  windows[0]!.from = { kind: "start", at: head.firstCluster };

  async function load(i: number): Promise<WindowFrames> {
    const window = windows[i]!;
    let end = window.end;
    let bytes = new Uint8Array(await fetchSpan(fetcher, window.start, end - 1));
    for (let peek = PEEK_BYTES; ; peek *= 2) {
      // Byte windows start mid-cluster: frames before the first cluster belong to the window before.
      const first = window.from.kind === "bytes" ? findCluster(bytes, 0) : 0;
      const scan = first < 0 ? null : readClusters(bytes.subarray(first), window.start + first, head, tracks);
      const from = scan ? boundaryPosition(scan, window.from, reference) : null;
      const to = window.to && scan ? boundaryPosition(scan, window.to, reference) : Infinity;
      if (scan && from !== null && to !== null) {
        const split = (track: MkvTrack | null): EncodedSample[] =>
          track
            ? scan.frames
                .filter((frame) => frame.track === track.number && frame.position >= from && frame.position < to)
                .map(({ data, timestamp, duration, key }) => ({ data, timestamp, duration, key }))
            : [];
        return { video: split(video), audio: split(audio) };
      }
      if (end >= clustersEnd) {
        if (scan && from !== null) {
          // The next key frame is past the end: this window takes everything after its own.
          const all = (track: MkvTrack | null) =>
            track ? scan.frames.filter((f) => f.track === track.number && f.position >= from).map(({ data, timestamp, duration, key }) => ({ data, timestamp, duration, key })) : [];
          return { video: all(video), audio: all(audio) };
        }
        return { video: [], audio: [] };
      }
      // Read further, to reach the key frame that ends (or starts) this window.
      const more = Math.min(clustersEnd, end + peek);
      const extra = new Uint8Array(await fetchSpan(fetcher, end, more - 1));
      const joined = new Uint8Array(bytes.length + extra.length);
      joined.set(bytes);
      joined.set(extra, bytes.length);
      bytes = joined;
      end = more;
    }
  }

  // Both tracks are interleaved, so a window is read and split once, for both lanes.
  const cache = new Map<number, Promise<WindowFrames>>();
  const framesOf = (i: number) => {
    let pending = cache.get(i);
    if (!pending) {
      pending = load(i);
      pending.catch(() => cache.delete(i));
      cache.set(i, pending);
      for (const key of cache.keys()) {
        if (cache.size <= CACHED_WINDOWS) break;
        cache.delete(key);
      }
    }
    return pending;
  };

  const reader = (track: MkvTrack, pick: (frames: WindowFrames) => EncodedSample[]): TrackReader => ({
    config: track.config!,
    segments: windows.map((window) => ({ time: window.time, duration: window.duration })),
    load: async (i, loadSignal) => pick(await untilAborted(framesOf(i), loadSignal)),
  });

  return {
    duration,
    video: video ? reader(video, (frames) => frames.video) : null,
    audio: audio ? reader(audio, (frames) => frames.audio) : null,
  };
}

/** A same-origin Matroska or WebM file, read with HTTP range requests. */
export function mkvSource(url: string, options: MkvSourceOptions = {}): EngineSource {
  const fetcher = httpRangeFetcher(url);
  return { id: url, open: (signal) => openMkv(fetcher, fetcher.size, signal, options) };
}

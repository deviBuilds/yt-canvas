/**
 * A Matroska / WebM demuxer for the canvas engine: enough of EBML to hand WebCodecs each
 * track's configuration and every compressed frame with its timing.
 *
 * It reads the segment's SeekHead, Info, Tracks and Cues, and the SimpleBlocks and
 * BlockGroups inside Clusters, including laced blocks, header stripping, unknown element
 * sizes (live-style files) and Opus codec delay. Reading byte ranges and deciding what to
 * fetch is the reader's job (``mkvReader.ts``); everything here works on buffers.
 */

import { aacCodec, aacConfig, av1Codec, avcCodec, CodecError, hevcCodec, vp9Codec } from "./codecs";
import type { TrackConfig } from "./mp4";

export class MkvError extends Error {
  override name = "MkvError";
}

/** Element IDs, with their length marker bits, as the specification writes them. */
export const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  DefaultDuration: 0x23e383,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentEncodingType: 0x5033,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
  Attachments: 0x1941a469,
  Void: 0xec,
  CRC32: 0xbf,
} as const;

/** Children of Segment: an element with an unknown size (a live Cluster) ends where one of these starts. */
const TOP_LEVEL = new Set<number>([
  ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Cluster, ID.Chapters, ID.Tags, ID.Attachments,
]);

export interface Element {
  id: number;
  /** Offset of the ID within the buffer. */
  start: number;
  dataStart: number;
  /** -1 when the size is "unknown" (all ones), as in live streams. */
  size: number;
  /** dataStart + size, or Infinity for an unknown size. */
  end: number;
}

export type Need = { need: number };

function vintLength(first: number): number {
  for (let length = 1; length <= 8; length++) if (first & (0x80 >> (length - 1))) return length;
  return 0;
}

/** The element at ``at``; ``need`` when its header runs past ``limit``; null for bytes that aren't EBML. */
export function readElement(bytes: Uint8Array, at: number, limit = bytes.length): Element | Need | null {
  if (at >= limit) return { need: at + 1 };
  const idLength = vintLength(bytes[at]!);
  if (idLength === 0 || idLength > 4) return null;
  if (at + idLength >= limit) return { need: at + idLength + 1 };
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[at + i]!;
  const sizeAt = at + idLength;
  const sizeLength = vintLength(bytes[sizeAt]!);
  if (sizeLength === 0) return null;
  if (sizeAt + sizeLength > limit) return { need: sizeAt + sizeLength };
  const mask = 0xff >> sizeLength;
  let size = bytes[sizeAt]! & mask;
  let allOnes = size === mask;
  for (let i = 1; i < sizeLength; i++) {
    const byte = bytes[sizeAt + i]!;
    size = size * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  const dataStart = sizeAt + sizeLength;
  return allOnes ? { id, start: at, dataStart, size: -1, end: Infinity } : { id, start: at, dataStart, size, end: dataStart + size };
}

const isElement = (value: Element | Need | null): value is Element => value !== null && !("need" in value);

/** Complete child elements of [from, to). */
function children(bytes: Uint8Array, from: number, to: number): Element[] {
  const out: Element[] = [];
  let at = from;
  while (at < to) {
    const element = readElement(bytes, at, to);
    if (!isElement(element) || element.end > to) break;
    out.push(element);
    at = element.end;
  }
  return out;
}

function uint(bytes: Uint8Array, element: Element): number {
  let value = 0;
  for (let i = element.dataStart; i < element.end; i++) value = value * 256 + bytes[i]!;
  return value;
}

function float(bytes: Uint8Array, element: Element): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataStart, element.size);
  if (element.size === 4) return view.getFloat32(0);
  if (element.size === 8) return view.getFloat64(0);
  return 0;
}

const text = (bytes: Uint8Array, element: Element) =>
  new TextDecoder().decode(bytes.subarray(element.dataStart, element.end)).replace(/\0+$/, "");

const binary = (bytes: Uint8Array, element: Element) => bytes.slice(element.dataStart, element.end);

// -- tracks -------------------------------------------------------------------------------

export type TrackKind = "video" | "audio" | "subtitle" | "other";

export interface MkvTrack {
  number: number;
  kind: TrackKind;
  codecId: string;
  /** A short name for people, e.g. "H.264" or "DTS". */
  codecName: string;
  /** Null when WebCodecs can't be given this track (DTS, image subtitles, encrypted, compressed). */
  config: TrackConfig | null;
  language: string | null;
  name: string | null;
  enabled: boolean;
  isDefault: boolean;
  /** Microseconds per frame when the file or codec says; used to time laced frames. */
  frameDuration: number | null;
  /** Microseconds to subtract from every timestamp (Opus pre-skip). */
  codecDelay: number;
  /** Bytes the muxer stripped from the start of every frame (header stripping). */
  strippedHeader: Uint8Array | null;
}

const CODEC_NAMES: Array<[string, string]> = [
  ["V_MPEG4/ISO/AVC", "H.264"],
  ["V_MPEGH/ISO/HEVC", "HEVC"],
  ["V_AV1", "AV1"],
  ["V_VP9", "VP9"],
  ["V_VP8", "VP8"],
  ["V_MPEG2", "MPEG-2"],
  ["V_MPEG4/ISO", "MPEG-4 Part 2"],
  ["V_MS/VFW", "VfW video"],
  ["A_AAC", "AAC"],
  ["A_OPUS", "Opus"],
  ["A_VORBIS", "Vorbis"],
  ["A_FLAC", "FLAC"],
  ["A_MPEG/L3", "MP3"],
  ["A_MPEG/L2", "MP2"],
  ["A_EAC3", "E-AC-3"],
  ["A_AC3", "AC-3"],
  ["A_DTS", "DTS"],
  ["A_TRUEHD", "TrueHD"],
  ["A_PCM", "PCM"],
  ["S_HDMV/PGS", "PGS subtitles"],
  ["S_TEXT/UTF8", "SRT subtitles"],
  ["S_TEXT/ASS", "ASS subtitles"],
  ["S_TEXT/SSA", "SSA subtitles"],
  ["S_VOBSUB", "VobSub subtitles"],
];

export function codecName(codecId: string): string {
  return CODEC_NAMES.find(([prefix]) => codecId.startsWith(prefix))?.[1] ?? codecId;
}

interface RawTrack {
  number: number;
  type: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  language: string | null;
  name: string | null;
  enabled: boolean;
  isDefault: boolean;
  defaultDuration: number | null; // ns
  codecDelay: number; // ns
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  encrypted: boolean;
  compression: number | null; // ContentCompAlgo
  strippedHeader: Uint8Array | null;
}

/** VP9's optional CodecPrivate: (id, length, value) features, 1 profile, 2 level, 3 bit depth. */
function vp9FromPrivate(codecPrivate: Uint8Array | null): string {
  const features = new Map<number, number>();
  for (let p = 0; codecPrivate && p + 2 < codecPrivate.length; ) {
    const id = codecPrivate[p]!;
    const length = codecPrivate[p + 1]!;
    if (length === 1) features.set(id, codecPrivate[p + 2]!);
    p += 2 + length;
  }
  return vp9Codec(features.get(1), features.get(2), features.get(3));
}

const AAC_OBJECT_TYPES: Record<string, number> = { MAIN: 1, LC: 2, SSR: 3, SBR: 5 };

function configOf(raw: RawTrack): TrackConfig | null {
  if (raw.encrypted || (raw.compression !== null && raw.compression !== 3)) return null;
  const cp = raw.codecPrivate;
  const id = raw.codecId;
  if (raw.type === 1) {
    const video = (codec: string, description?: Uint8Array): TrackConfig => ({
      kind: "video",
      codec,
      ...(description ? { description } : {}),
      width: raw.width,
      height: raw.height,
    });
    if (id === "V_MPEG4/ISO/AVC" && cp) return video(avcCodec("avc1", cp), cp);
    if (id === "V_MPEGH/ISO/HEVC" && cp) return video(hevcCodec("hvc1", cp), cp);
    if (id === "V_AV1") return cp && cp.length >= 4 ? video(av1Codec(cp), cp) : null;
    if (id === "V_VP9") return video(vp9FromPrivate(cp));
    if (id === "V_VP8") return video("vp8");
    return null;
  }
  if (raw.type === 2) {
    const audio = (codec: string, description?: Uint8Array | null): TrackConfig => ({
      kind: "audio",
      codec,
      ...(description ? { description } : {}),
      sampleRate: raw.sampleRate,
      channels: raw.channels,
    });
    if (id.startsWith("A_AAC")) {
      // Old files spell the profile in the codec ID (A_AAC/MPEG4/LC) and carry no config.
      const profile = id.split("/")[2] ?? "LC";
      const asc = cp && cp.length >= 2 ? cp : aacConfig(AAC_OBJECT_TYPES[profile] ?? 2, raw.sampleRate, raw.channels);
      return audio(aacCodec(asc), asc);
    }
    if (id === "A_OPUS") return audio("opus", cp);
    if (id === "A_VORBIS") return cp ? audio("vorbis", cp) : null;
    if (id === "A_FLAC") return cp ? audio("flac", cp) : null;
    if (id === "A_MPEG/L3") return audio("mp3");
    if (id === "A_AC3") return audio("ac-3");
    if (id === "A_EAC3") return audio("ec-3");
    if (id === "A_PCM/INT/LIT") {
      const codec = { 8: "pcm-u8", 16: "pcm-s16", 24: "pcm-s24", 32: "pcm-s32" }[raw.bitDepth];
      return codec ? audio(codec) : null;
    }
    if (id === "A_PCM/FLOAT/IEEE" && raw.bitDepth === 32) return audio("pcm-f32");
    return null;
  }
  return null;
}

/** Samples per frame for codecs with fixed frames, to time laced audio without DefaultDuration. */
function codecFrameSamples(raw: RawTrack, config: TrackConfig | null): number | null {
  if (raw.codecId.startsWith("A_AAC")) return config?.codec === "mp4a.40.5" || config?.codec === "mp4a.40.29" ? 2048 : 1024;
  if (raw.codecId === "A_MPEG/L3") return 1152;
  if (raw.codecId === "A_AC3" || raw.codecId === "A_EAC3") return 1536;
  return null;
}

function parseTrackEntry(bytes: Uint8Array, entry: Element): MkvTrack {
  const raw: RawTrack = {
    number: 0, type: 0, codecId: "", codecPrivate: null, language: "eng", name: null, enabled: true, isDefault: true,
    defaultDuration: null, codecDelay: 0, width: 0, height: 0, sampleRate: 8000, channels: 1, bitDepth: 0,
    encrypted: false, compression: null, strippedHeader: null,
  };
  for (const el of children(bytes, entry.dataStart, entry.end)) {
    switch (el.id) {
      case ID.TrackNumber: raw.number = uint(bytes, el); break;
      case ID.TrackType: raw.type = uint(bytes, el); break;
      case ID.CodecID: raw.codecId = text(bytes, el); break;
      case ID.CodecPrivate: raw.codecPrivate = binary(bytes, el); break;
      case ID.Language: raw.language = text(bytes, el); break;
      case ID.LanguageBCP47: raw.language = text(bytes, el); break;
      case ID.Name: raw.name = text(bytes, el); break;
      case ID.FlagEnabled: raw.enabled = uint(bytes, el) !== 0; break;
      case ID.FlagDefault: raw.isDefault = uint(bytes, el) !== 0; break;
      case ID.DefaultDuration: raw.defaultDuration = uint(bytes, el); break;
      case ID.CodecDelay: raw.codecDelay = uint(bytes, el); break;
      case ID.Video:
        for (const v of children(bytes, el.dataStart, el.end)) {
          if (v.id === ID.PixelWidth) raw.width = uint(bytes, v);
          if (v.id === ID.PixelHeight) raw.height = uint(bytes, v);
        }
        break;
      case ID.Audio:
        for (const a of children(bytes, el.dataStart, el.end)) {
          if (a.id === ID.SamplingFrequency) raw.sampleRate = Math.round(float(bytes, a));
          if (a.id === ID.Channels) raw.channels = uint(bytes, a);
          if (a.id === ID.BitDepth) raw.bitDepth = uint(bytes, a);
        }
        break;
      case ID.ContentEncodings:
        for (const encoding of children(bytes, el.dataStart, el.end)) {
          if (encoding.id !== ID.ContentEncoding) continue;
          for (const part of children(bytes, encoding.dataStart, encoding.end)) {
            if (part.id === ID.ContentEncodingType && uint(bytes, part) === 1) raw.encrypted = true;
            if (part.id !== ID.ContentCompression) continue;
            raw.compression = 0; // zlib unless said otherwise
            for (const c of children(bytes, part.dataStart, part.end)) {
              if (c.id === ID.ContentCompAlgo) raw.compression = uint(bytes, c);
              if (c.id === ID.ContentCompSettings) raw.strippedHeader = binary(bytes, c);
            }
          }
        }
        break;
    }
  }
  let config: TrackConfig | null = null;
  try {
    config = configOf(raw);
  } catch (err) {
    if (!(err instanceof CodecError)) throw err;
  }
  const kind: TrackKind = raw.type === 1 ? "video" : raw.type === 2 ? "audio" : raw.type === 17 ? "subtitle" : "other";
  const samples = codecFrameSamples(raw, config);
  const frameDuration = raw.defaultDuration
    ? raw.defaultDuration / 1000
    : samples && raw.sampleRate
      ? (samples / raw.sampleRate) * 1e6
      : null;
  return {
    number: raw.number,
    kind,
    codecId: raw.codecId,
    codecName: codecName(raw.codecId),
    config,
    language: raw.language,
    name: raw.name,
    enabled: raw.enabled,
    isDefault: raw.isDefault,
    frameDuration,
    codecDelay: raw.codecDelay / 1000,
    strippedHeader: raw.compression === 3 && raw.strippedHeader?.length ? raw.strippedHeader : null,
  };
}

// -- the segment head -------------------------------------------------------------------

export interface MkvHead {
  docType: string;
  /** Absolute offset of the Segment's data: Cue and Seek positions are relative to it. */
  segmentStart: number;
  /** Absolute end of the Segment, or Infinity when its size is unknown. */
  segmentEnd: number;
  /** Nanoseconds per timestamp tick. */
  timestampScale: number;
  /** Seconds; 0 when the file doesn't say. */
  duration: number;
  tracks: MkvTrack[];
  /** Absolute offsets of level-1 elements, from the SeekHead and from what was read. */
  positions: Map<number, number>;
  /** Absolute offset of the first Cluster, when the head reached it. */
  firstCluster: number | null;
  /** Cue points, when the Cues came before the first Cluster. */
  cues: CuePoint[] | null;
}

/**
 * Parse the start of a file: the EBML header and the Segment's elements up to the first
 * Cluster. ``bytes`` start at file offset 0. Returns ``need`` with a larger length when
 * Info or Tracks run past the buffer.
 */
export function parseHead(bytes: Uint8Array): MkvHead | Need {
  const ebml = readElement(bytes, 0);
  if (ebml && "need" in ebml) return ebml;
  if (!ebml || ebml.id !== ID.EBML) throw new MkvError("This isn't a Matroska or WebM file.");
  if (ebml.end > bytes.length) return { need: ebml.end };
  const docType = children(bytes, ebml.dataStart, ebml.end).find((el) => el.id === ID.DocType);
  const head: MkvHead = {
    docType: docType ? text(bytes, docType) : "matroska",
    segmentStart: 0,
    segmentEnd: Infinity,
    timestampScale: 1_000_000,
    duration: 0,
    tracks: [],
    positions: new Map(),
    firstCluster: null,
    cues: null,
  };

  let at = ebml.end;
  let segment: Element | null = null;
  while (!segment) {
    const el = readElement(bytes, at);
    if (el && "need" in el) return el;
    if (!el) throw new MkvError("This Matroska file has no Segment.");
    if (el.id === ID.Segment) segment = el;
    else if (el.end === Infinity) throw new MkvError("This Matroska file has no Segment.");
    else at = el.end;
  }
  head.segmentStart = segment.dataStart;
  head.segmentEnd = segment.end;

  let rawDuration = 0;
  let haveTracks = false;
  for (at = segment.dataStart; at < bytes.length; ) {
    const el = readElement(bytes, at);
    if (el && "need" in el) return haveTracks ? finish() : el;
    if (!el) break;
    head.positions.set(el.id, head.positions.get(el.id) ?? el.start);
    if (el.id === ID.Cluster) {
      head.firstCluster = el.start;
      break;
    }
    const needed = el.id === ID.Info || el.id === ID.Tracks || el.id === ID.SeekHead || el.id === ID.Cues;
    if (needed && el.end > bytes.length) {
      // Cues before the clusters can be read later from their position; the rest is required.
      if (el.id !== ID.Cues) return { need: el.end };
      at = el.end;
      continue;
    }
    if (el.id === ID.SeekHead) {
      for (const seek of children(bytes, el.dataStart, el.end)) {
        if (seek.id !== ID.Seek) continue;
        let id = 0;
        let position = -1;
        for (const part of children(bytes, seek.dataStart, seek.end)) {
          if (part.id === ID.SeekID) id = uint(bytes, part);
          if (part.id === ID.SeekPosition) position = uint(bytes, part);
        }
        if (id && position >= 0 && !head.positions.has(id)) head.positions.set(id, segment.dataStart + position);
      }
    } else if (el.id === ID.Info) {
      for (const part of children(bytes, el.dataStart, el.end)) {
        if (part.id === ID.TimestampScale) head.timestampScale = uint(bytes, part);
        if (part.id === ID.Duration) rawDuration = float(bytes, part);
      }
    } else if (el.id === ID.Tracks) {
      head.tracks = children(bytes, el.dataStart, el.end)
        .filter((entry) => entry.id === ID.TrackEntry)
        .map((entry) => parseTrackEntry(bytes, entry));
      haveTracks = true;
    } else if (el.id === ID.Cues) {
      head.cues = parseCues(bytes.subarray(el.start, el.end), head);
    }
    if (el.end === Infinity) break;
    at = el.end;
  }
  return haveTracks ? finish() : { need: Math.max(bytes.length * 2, bytes.length + 1) };

  function finish(): MkvHead {
    head.duration = (rawDuration * head.timestampScale) / 1e9;
    return head;
  }
}

// -- cues ---------------------------------------------------------------------------------

export interface CuePoint {
  /** Seconds. */
  time: number;
  track: number;
  /** Absolute offset of the Cluster holding the key frame. */
  cluster: number;
  /** Offset of the key frame's block from the Cluster's data start, when the file says. */
  relative: number | null;
}

/** The cue points in a buffer that starts with the Cues element, sorted by time. */
export function parseCues(bytes: Uint8Array, head: Pick<MkvHead, "segmentStart" | "timestampScale">): CuePoint[] {
  const cues = readElement(bytes, 0);
  if (!isElement(cues) || cues.id !== ID.Cues) throw new MkvError("Expected the Cues element.");
  const points: CuePoint[] = [];
  for (const point of children(bytes, cues.dataStart, Math.min(cues.end, bytes.length))) {
    if (point.id !== ID.CuePoint) continue;
    let ticks = 0;
    const positions: Array<Omit<CuePoint, "time">> = [];
    for (const part of children(bytes, point.dataStart, point.end)) {
      if (part.id === ID.CueTime) ticks = uint(bytes, part);
      if (part.id !== ID.CueTrackPositions) continue;
      let track = 0;
      let cluster = -1;
      let relative: number | null = null;
      for (const field of children(bytes, part.dataStart, part.end)) {
        if (field.id === ID.CueTrack) track = uint(bytes, field);
        if (field.id === ID.CueClusterPosition) cluster = uint(bytes, field);
        if (field.id === ID.CueRelativePosition) relative = uint(bytes, field);
      }
      if (cluster >= 0) positions.push({ track, cluster: head.segmentStart + cluster, relative });
    }
    const time = (ticks * head.timestampScale) / 1e9;
    for (const position of positions) points.push({ time, ...position });
  }
  return points.sort((a, b) => a.time - b.time || a.cluster - b.cluster);
}

// -- clusters and blocks ------------------------------------------------------------------

export interface MkvFrame {
  track: number;
  data: Uint8Array;
  /** Microseconds of presentation time. */
  timestamp: number;
  /** Microseconds; 0 when unknown. */
  duration: number;
  key: boolean;
  /** Absolute offset of the SimpleBlock or BlockGroup the frame came from. */
  position: number;
}

export interface ClusterScan {
  frames: MkvFrame[];
  /** Absolute offset just past the last complete element read. */
  end: number;
  /** Absolute data-start offsets of the clusters read, by cluster start. */
  clusters: Map<number, number>;
}

function lacedSizes(bytes: Uint8Array, at: number, end: number, lacing: number): { sizes: number[]; at: number } {
  if (lacing === 0) return { sizes: [end - at], at };
  const count = bytes[at++]! + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    // Xiph: each size is a run of bytes summed until one isn't 255.
    for (let i = 0; i < count - 1; i++) {
      let size = 0;
      let byte: number;
      do {
        byte = bytes[at++]!;
        size += byte;
      } while (byte === 255);
      sizes.push(size);
    }
  } else if (lacing === 3) {
    // EBML: the first size as a vint, then signed differences.
    for (let i = 0; i < count - 1; i++) {
      const length = vintLength(bytes[at]!);
      if (length === 0) throw new MkvError("Bad EBML lacing.");
      let value = bytes[at]! & (0xff >> length);
      for (let k = 1; k < length; k++) value = value * 256 + bytes[at + k]!;
      at += length;
      sizes.push(i === 0 ? value : sizes[i - 1]! + value - (2 ** (7 * length - 1) - 1));
    }
  } else {
    // Fixed: equal sizes.
    const size = Math.floor((end - at) / count);
    for (let i = 0; i < count - 1; i++) sizes.push(size);
  }
  sizes.push(end - at - sizes.reduce((sum, size) => sum + size, 0));
  if (sizes.some((size) => size < 0)) throw new MkvError("A laced block is larger than its element.");
  return { sizes, at };
}

interface BlockContext {
  bytes: Uint8Array;
  base: number;
  clusterTicks: number;
  scale: number;
  tracks: Map<number, MkvTrack>;
  out: MkvFrame[];
}

function readBlock(ctx: BlockContext, block: Element, position: number, simple: boolean, referenced: boolean, durationTicks: number | null) {
  const { bytes } = ctx;
  let at = block.dataStart;
  const length = vintLength(bytes[at]!);
  if (length === 0 || length > 8) throw new MkvError("Bad block track number.");
  let number = bytes[at]! & (0xff >> length);
  for (let i = 1; i < length; i++) number = number * 256 + bytes[at + i]!;
  at += length;
  const track = ctx.tracks.get(number);
  if (!track) return;
  const relative = (bytes[at]! << 24 >> 16) | bytes[at + 1]!; // signed 16-bit
  const flags = bytes[at + 2]!;
  at += 3;
  const key = track.kind !== "video" || (simple ? (flags & 0x80) !== 0 : !referenced);
  const { sizes, at: dataAt } = lacedSizes(bytes, at, block.end, (flags >> 1) & 3);
  const start = ((ctx.clusterTicks + relative) * ctx.scale) / 1000 - track.codecDelay;
  const blockDuration = durationTicks !== null ? (durationTicks * ctx.scale) / 1000 : null;
  const each = track.frameDuration ?? (blockDuration !== null ? blockDuration / sizes.length : 0);
  let offset = dataAt;
  sizes.forEach((size, i) => {
    let data = bytes.subarray(offset, offset + size);
    offset += size;
    if (track.strippedHeader) {
      const joined = new Uint8Array(track.strippedHeader.length + size);
      joined.set(track.strippedHeader);
      joined.set(data, track.strippedHeader.length);
      data = joined;
    }
    ctx.out.push({
      track: number,
      data,
      timestamp: Math.round(start + i * each),
      duration: Math.round(sizes.length === 1 && blockDuration !== null ? blockDuration : each),
      key: track.kind !== "video" || (key && i === 0),
      position: ctx.base + position,
    });
  });
}

/**
 * Read Clusters from a buffer that starts at a Cluster (``base`` is its absolute offset),
 * keeping frames of ``tracks``. Stops at the buffer's end or at a non-Cluster level-1
 * element; a Cluster cut off by the buffer's end yields the blocks that are complete.
 */
export function readClusters(bytes: Uint8Array, base: number, head: Pick<MkvHead, "timestampScale">, tracks: MkvTrack[]): ClusterScan {
  const byNumber = new Map(tracks.map((track) => [track.number, track]));
  const scan: ClusterScan = { frames: [], end: base, clusters: new Map() };
  let at = 0;
  while (at < bytes.length) {
    const cluster = readElement(bytes, at);
    if (!isElement(cluster)) break;
    if (cluster.id === ID.Void || cluster.id === ID.CRC32) {
      if (cluster.end > bytes.length) break;
      at = cluster.end;
      scan.end = base + at;
      continue;
    }
    if (cluster.id !== ID.Cluster) break;
    scan.clusters.set(base + cluster.start, base + cluster.dataStart);
    const limit = Math.min(cluster.end, bytes.length);
    const ctx: BlockContext = { bytes, base, clusterTicks: 0, scale: head.timestampScale, tracks: byNumber, out: scan.frames };
    let p = cluster.dataStart;
    let complete = true;
    while (p < limit) {
      const el = readElement(bytes, p, limit);
      if (!isElement(el) || el.end > limit) {
        complete = false;
        break;
      }
      if (cluster.size === -1 && TOP_LEVEL.has(el.id)) break; // an unknown-size cluster ends here
      if (el.id === ID.Timestamp) ctx.clusterTicks = uint(bytes, el);
      else if (el.id === ID.SimpleBlock) readBlock(ctx, el, el.start, true, false, null);
      else if (el.id === ID.BlockGroup) {
        let block: Element | null = null;
        let referenced = false;
        let duration: number | null = null;
        for (const part of children(bytes, el.dataStart, el.end)) {
          if (part.id === ID.Block) block = part;
          if (part.id === ID.ReferenceBlock) referenced = true;
          if (part.id === ID.BlockDuration) duration = uint(bytes, part);
        }
        if (block) readBlock(ctx, block, el.start, false, referenced, duration);
      }
      p = el.end;
      scan.end = base + p;
    }
    if (!complete || cluster.end > bytes.length) break;
    at = cluster.size === -1 ? p : cluster.end;
    scan.end = base + at;
  }
  return scan;
}

/** The offset of the first Cluster at or after ``from`` whose header and timestamp read back cleanly. */
export function findCluster(bytes: Uint8Array, from = 0): number {
  for (let at = from; at + 4 <= bytes.length; at++) {
    if (bytes[at] !== 0x1f || bytes[at + 1] !== 0x43 || bytes[at + 2] !== 0xb6 || bytes[at + 3] !== 0x75) continue;
    const cluster = readElement(bytes, at);
    if (!isElement(cluster)) continue;
    const first = readElement(bytes, cluster.dataStart);
    if (isElement(first) && (first.id === ID.Timestamp || first.id === ID.CRC32 || first.id === ID.Void)) return at;
  }
  return -1;
}

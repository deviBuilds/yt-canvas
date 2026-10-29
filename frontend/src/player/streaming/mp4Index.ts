/**
 * Just enough MP4 parsing to stream a DASH track: where the init segment ends
 * (after ``moov``) and the segment index (``sidx``) that maps time to byte ranges.
 * YouTube's DASH tracks, and the demo tracks the backend generates, put one
 * top-level ``sidx`` right after ``moov``.
 */

export interface Segment {
  /** Inclusive byte range in the track. */
  start: number;
  end: number;
  /** Seconds. */
  time: number;
  duration: number;
}

export interface TrackIndex {
  /** The init segment is bytes [0, initEnd). */
  initEnd: number;
  segments: Segment[];
  /** Seconds covered by the index. */
  duration: number;
}

export type ParseResult = { kind: "index"; index: TrackIndex } | { kind: "need"; bytes: number } | { kind: "invalid"; reason: string };

interface Box {
  type: string;
  start: number;
  size: number;
  headerSize: number;
}

function readBox(view: DataView, offset: number): Box | { need: number } | null {
  if (offset + 8 > view.byteLength) return { need: offset + 8 };
  let size = view.getUint32(offset);
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > view.byteLength) return { need: offset + 16 };
    size = Number(view.getBigUint64(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    return null; // "to end of file": only valid for the last box, never before sidx
  }
  if (size < headerSize) return null;
  return { type, start: offset, size, headerSize };
}

function parseSidx(view: DataView, box: Box): { timescale: number; earliest: number; firstOffset: number; references: Array<{ size: number; duration: number }> } {
  let p = box.start + box.headerSize;
  const version = view.getUint8(p);
  p += 4; // version + flags
  p += 4; // reference_ID
  const timescale = view.getUint32(p);
  p += 4;
  let earliest: number;
  let firstOffset: number;
  if (version === 0) {
    earliest = view.getUint32(p);
    firstOffset = view.getUint32(p + 4);
    p += 8;
  } else {
    earliest = Number(view.getBigUint64(p));
    firstOffset = Number(view.getBigUint64(p + 8));
    p += 16;
  }
  p += 2; // reserved
  const count = view.getUint16(p);
  p += 2;
  const references: Array<{ size: number; duration: number }> = [];
  for (let i = 0; i < count; i++) {
    const typeAndSize = view.getUint32(p);
    const duration = view.getUint32(p + 4);
    p += 12; // + SAP fields
    // reference_type 1 would point at another sidx; YouTube and FFmpeg use flat indexes.
    references.push({ size: typeAndSize & 0x7fffffff, duration });
  }
  return { timescale, earliest, firstOffset, references };
}

/**
 * Parse the head of a track. Returns ``need`` with the number of bytes to fetch
 * when ``moov`` or ``sidx`` doesn't fit in what was read yet.
 */
export function parseTrackHead(buffer: ArrayBuffer): ParseResult {
  const view = new DataView(buffer);
  let offset = 0;
  let initEnd = -1;
  for (let guard = 0; guard < 64; guard++) {
    const box = readBox(view, offset);
    if (box === null) return { kind: "invalid", reason: "malformed box before the segment index" };
    if ("need" in box) return { kind: "need", bytes: box.need };
    const end = box.start + box.size;
    if (box.type === "moov") initEnd = end;
    if (box.type === "sidx") {
      if (end > view.byteLength) return { kind: "need", bytes: end };
      if (initEnd < 0) return { kind: "invalid", reason: "sidx before moov" };
      const sidx = parseSidx(view, box);
      if (sidx.timescale === 0 || sidx.references.length === 0) return { kind: "invalid", reason: "empty segment index" };
      const segments: Segment[] = [];
      let byte = end + sidx.firstOffset; // offsets are relative to the first byte after the sidx box
      let ticks = sidx.earliest;
      for (const ref of sidx.references) {
        segments.push({ start: byte, end: byte + ref.size - 1, time: ticks / sidx.timescale, duration: ref.duration / sidx.timescale });
        byte += ref.size;
        ticks += ref.duration;
      }
      const last = segments[segments.length - 1]!;
      return { kind: "index", index: { initEnd, segments, duration: last.time + last.duration } };
    }
    if (box.type === "moof" || box.type === "mdat") return { kind: "invalid", reason: "no segment index before the media" };
    offset = end;
  }
  return { kind: "invalid", reason: "too many boxes before the segment index" };
}

/** Index of the segment that contains ``time`` (the last one before it, past the end). */
export function segmentAt(segments: Segment[], time: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.time <= time + 1e-3) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

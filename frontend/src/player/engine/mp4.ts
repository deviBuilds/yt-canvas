/**
 * An MP4 demuxer for the canvas engine: enough of ISO BMFF to hand WebCodecs
 * the codec configuration and every compressed sample with its timing.
 *
 * Two layouts are supported:
 *  - a regular MP4 whose ``moov`` holds the sample tables (``stbl``), like the
 *    faststart files the backend prepares;
 *  - fragmented MP4 (``moov`` with ``mvex``, then ``moof``/``mdat`` pairs), like
 *    YouTube's DASH tracks and the demo streaming tracks.
 */

export interface Box {
  type: string;
  /** Offset of the box header within the buffer being read. */
  start: number;
  size: number;
  headerSize: number;
}

export interface VideoTrackConfig {
  kind: "video";
  codec: string;
  description?: Uint8Array;
  width: number;
  height: number;
}

export interface AudioTrackConfig {
  kind: "audio";
  codec: string;
  description?: Uint8Array;
  sampleRate: number;
  channels: number;
}

export type TrackConfig = VideoTrackConfig | AudioTrackConfig;

/** Sample timing and placement from ``stbl``, in the track's timescale. */
export interface SampleTable {
  count: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  /** Decode times. */
  dts: Float64Array;
  /** Presentation (composition) times. */
  cts: Float64Array;
  durations: Uint32Array;
  keys: Uint8Array;
}

interface TrackDefaults {
  duration: number;
  size: number;
  flags: number;
}

export interface MovieTrack {
  id: number;
  handler: string;
  timescale: number;
  /** Null when the sample entry is something WebCodecs isn't given (e.g. HEVC, encrypted). */
  config: TrackConfig | null;
  /** Seconds added to media times to get presentation times (from the edit list). */
  shift: number;
  /** Seconds, from ``mdhd``; 0 for fragmented tracks. */
  duration: number;
  defaults: TrackDefaults;
  /** Present for regular (non-fragmented) files. */
  table: SampleTable | null;
}

export interface Movie {
  timescale: number;
  /** Seconds; 0 when unknown (fragmented files usually leave it empty). */
  duration: number;
  fragmented: boolean;
  tracks: MovieTrack[];
}

/** A sample cut out of a fragment, in the track's timescale. */
export interface FragmentSample {
  data: Uint8Array;
  dts: number;
  cts: number;
  duration: number;
  key: boolean;
}

export class Mp4Error extends Error {
  override name = "Mp4Error";
}

const fourcc = (view: DataView, at: number) =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/** The box starting at ``offset``, or ``need`` when its header isn't in the buffer yet. */
export function readBox(view: DataView, offset: number, limit = view.byteLength): Box | { need: number } | null {
  if (offset + 8 > limit) return { need: offset + 8 };
  let size = view.getUint32(offset);
  const type = fourcc(view, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return { need: offset + 16 };
    size = Number(view.getBigUint64(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset; // runs to the end of the enclosing data
  }
  if (size < headerSize) return null;
  return { type, start: offset, size, headerSize };
}

/** Child boxes of the range [from, to). */
function children(view: DataView, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    const box = readBox(view, offset, to);
    if (!box || "need" in box) break;
    boxes.push(box);
    offset += box.size;
  }
  return boxes;
}

const inside = (box: Box) => [box.start + box.headerSize, box.start + box.size] as const;

function child(view: DataView, parent: Box, type: string): Box | undefined {
  const [from, to] = inside(parent);
  return children(view, from, to).find((box) => box.type === type);
}

function path(view: DataView, parent: Box, ...types: string[]): Box | undefined {
  let box: Box | undefined = parent;
  for (const type of types) {
    if (!box) return undefined;
    box = child(view, box, type);
  }
  return box;
}

const payload = (view: DataView, box: Box) =>
  new Uint8Array(view.buffer, view.byteOffset + box.start + box.headerSize, box.size - box.headerSize).slice();

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

// -- codec configuration ---------------------------------------------------------

function avcCodec(type: string, avcC: Uint8Array): string {
  if (avcC.length < 4) throw new Mp4Error("truncated avcC");
  return `${type}.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`;
}

function av1Codec(av1C: Uint8Array): string {
  if (av1C.length < 4) throw new Mp4Error("truncated av1C");
  const profile = av1C[1]! >> 5;
  const level = av1C[1]! & 0x1f;
  const tier = av1C[2]! >> 7 ? "H" : "M";
  const highBitDepth = (av1C[2]! >> 6) & 1;
  const twelveBit = (av1C[2]! >> 5) & 1;
  const depth = highBitDepth ? (twelveBit ? 12 : 10) : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`;
}

/** Read an MPEG-4 descriptor header (tag + variable-length size). */
function descriptor(bytes: Uint8Array, at: number): { tag: number; size: number; body: number } | null {
  if (at >= bytes.length) return null;
  const tag = bytes[at]!;
  let size = 0;
  let p = at + 1;
  for (let i = 0; i < 4 && p < bytes.length; i++) {
    const b = bytes[p++]!;
    size = (size << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { tag, size, body: p };
}

/** ``esds`` → codec string and the AudioSpecificConfig WebCodecs wants as ``description``. */
function esdsConfig(esds: Uint8Array): { codec: string; description?: Uint8Array } {
  // esds is a full box: version + flags first.
  const es = descriptor(esds, 4);
  if (!es || es.tag !== 0x03) throw new Mp4Error("esds without an ES descriptor");
  let p = es.body + 2; // ES_ID
  const flags = esds[p++]!;
  if (flags & 0x80) p += 2; // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + esds[p]!; // URL
  if (flags & 0x20) p += 2; // OCR_ES_Id
  const dc = descriptor(esds, p);
  if (!dc || dc.tag !== 0x04) throw new Mp4Error("esds without a decoder config");
  const objectType = esds[dc.body]!;
  const dsi = descriptor(esds, dc.body + 13);
  const asc = dsi && dsi.tag === 0x05 ? esds.slice(dsi.body, dsi.body + dsi.size) : undefined;
  if (objectType === 0x40 || objectType === 0x66 || objectType === 0x67) {
    let aot = asc && asc.length > 0 ? asc[0]! >> 3 : 2;
    if (aot === 31 && asc && asc.length > 1) aot = 32 + (((asc[0]! & 7) << 3) | (asc[1]! >> 5));
    return { codec: `mp4a.40.${aot}`, description: asc };
  }
  if (objectType === 0x69 || objectType === 0x6b) return { codec: "mp3" };
  return { codec: `mp4a.${hex(objectType)}` };
}

function sampleEntryConfig(view: DataView, stsd: Box, handler: string): TrackConfig | null {
  const [from, to] = inside(stsd);
  const entry = children(view, from + 8, to)[0]; // skip version/flags and entry_count
  if (!entry) return null;
  const body = entry.start + entry.headerSize;
  if (handler === "vide") {
    const width = view.getUint16(body + 24);
    const height = view.getUint16(body + 26);
    const boxes = children(view, body + 78, entry.start + entry.size);
    const find = (type: string) => boxes.find((box) => box.type === type);
    if (entry.type === "avc1" || entry.type === "avc3") {
      const avcC = find("avcC");
      if (!avcC) return null;
      const description = payload(view, avcC);
      return { kind: "video", codec: avcCodec(entry.type, description), description, width, height };
    }
    if (entry.type === "av01") {
      const av1C = find("av1C");
      if (!av1C) return null;
      const description = payload(view, av1C);
      return { kind: "video", codec: av1Codec(description), description, width, height };
    }
    return null;
  }
  if (handler === "soun") {
    const version = view.getUint16(body + 8); // QuickTime sound description version
    const channels = view.getUint16(body + 16);
    const sampleRate = view.getUint32(body + 24) >>> 16;
    const extra = version === 1 ? 16 : version === 2 ? 36 : 0;
    const boxes = children(view, body + 28 + extra, entry.start + entry.size);
    if (entry.type === "mp4a") {
      const esds = boxes.find((box) => box.type === "esds");
      if (!esds) return null;
      return { kind: "audio", ...esdsConfig(payload(view, esds)), sampleRate, channels };
    }
    return null;
  }
  return null;
}

// -- tables ------------------------------------------------------------------------

function fullBoxBody(box: Box): number {
  return box.start + box.headerSize + 4;
}

function editShift(view: DataView, trak: Box, movieTimescale: number, mediaTimescale: number): number {
  const elst = path(view, trak, "edts", "elst");
  if (!elst) return 0;
  const version = view.getUint8(elst.start + elst.headerSize);
  let p = fullBoxBody(elst);
  const count = view.getUint32(p);
  p += 4;
  let empty = 0;
  for (let i = 0; i < count; i++) {
    const duration = version === 1 ? Number(view.getBigUint64(p)) : view.getUint32(p);
    const mediaTime = version === 1 ? Number(view.getBigInt64(p + 8)) : view.getInt32(p + 4);
    p += version === 1 ? 20 : 12;
    if (mediaTime === -1) {
      empty += duration / movieTimescale;
      continue;
    }
    return empty - mediaTime / mediaTimescale;
  }
  return empty;
}

function sampleTable(view: DataView, stbl: Box): SampleTable | null {
  const stsz = child(view, stbl, "stsz");
  const stts = child(view, stbl, "stts");
  const stsc = child(view, stbl, "stsc");
  const stco = child(view, stbl, "stco") ?? child(view, stbl, "co64");
  if (!stsz || !stts || !stsc || !stco) return null;

  let p = fullBoxBody(stsz);
  const fixedSize = view.getUint32(p);
  const count = view.getUint32(p + 4);
  p += 8;
  if (count === 0) return null;
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixedSize || view.getUint32(p + i * 4);

  const dts = new Float64Array(count);
  const durations = new Uint32Array(count);
  p = fullBoxBody(stts);
  let runs = view.getUint32(p);
  p += 4;
  let n = 0;
  let time = 0;
  for (let r = 0; r < runs && n < count; r++, p += 8) {
    const samples = view.getUint32(p);
    const delta = view.getUint32(p + 4);
    for (let i = 0; i < samples && n < count; i++, n++) {
      dts[n] = time;
      durations[n] = delta;
      time += delta;
    }
  }

  const cts = Float64Array.from(dts);
  const ctts = child(view, stbl, "ctts");
  if (ctts) {
    p = fullBoxBody(ctts);
    runs = view.getUint32(p);
    p += 4;
    n = 0;
    for (let r = 0; r < runs && n < count; r++, p += 8) {
      const samples = view.getUint32(p);
      const offset = view.getInt32(p + 4);
      for (let i = 0; i < samples && n < count; i++, n++) cts[n] = dts[n]! + offset;
    }
  }

  const keys = new Uint8Array(count);
  const stss = child(view, stbl, "stss");
  if (stss) {
    p = fullBoxBody(stss);
    const entries = view.getUint32(p);
    p += 4;
    for (let i = 0; i < entries; i++) {
      const index = view.getUint32(p + i * 4) - 1;
      if (index >= 0 && index < count) keys[index] = 1;
    }
  } else {
    keys.fill(1);
  }

  const wide = stco.type === "co64";
  p = fullBoxBody(stco);
  const chunkCount = view.getUint32(p);
  p += 4;
  const chunkOffset = (c: number) => (wide ? Number(view.getBigUint64(p + c * 8)) : view.getUint32(p + c * 4));
  let q = fullBoxBody(stsc);
  const stscCount = view.getUint32(q);
  q += 4;
  const offsets = new Float64Array(count);
  let sample = 0;
  for (let e = 0; e < stscCount && sample < count; e++) {
    const firstChunk = view.getUint32(q + e * 12) - 1;
    const perChunk = view.getUint32(q + e * 12 + 4);
    const lastChunk = e + 1 < stscCount ? view.getUint32(q + (e + 1) * 12) - 1 : chunkCount;
    for (let c = firstChunk; c < lastChunk && sample < count; c++) {
      let offset = chunkOffset(c);
      for (let i = 0; i < perChunk && sample < count; i++, sample++) {
        offsets[sample] = offset;
        offset += sizes[sample]!;
      }
    }
  }
  return { count, offsets, sizes, dts, cts, durations, keys };
}

/**
 * Parse ``moov``. ``data`` must contain the whole box; ``moovStart`` is where it
 * begins within ``data``.
 */
export function parseMovie(data: ArrayBuffer | Uint8Array, moovStart = 0): Movie {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = readBox(view, moovStart);
  if (!moov || "need" in moov || moov.type !== "moov") throw new Mp4Error("no moov box");
  if (moov.start + moov.size > view.byteLength) throw new Mp4Error("truncated moov box");

  const mvhd = child(view, moov, "mvhd");
  if (!mvhd) throw new Mp4Error("moov without mvhd");
  const mvhdVersion = view.getUint8(mvhd.start + mvhd.headerSize);
  const mvhdBody = fullBoxBody(mvhd) + (mvhdVersion === 1 ? 16 : 8);
  const timescale = view.getUint32(mvhdBody) || 1000;
  const movieDuration = mvhdVersion === 1 ? Number(view.getBigUint64(mvhdBody + 4)) : view.getUint32(mvhdBody + 4);

  const mvex = child(view, moov, "mvex");
  const trexDefaults = new Map<number, TrackDefaults>();
  if (mvex) {
    for (const trex of children(view, ...inside(mvex)).filter((box) => box.type === "trex")) {
      const p = fullBoxBody(trex);
      trexDefaults.set(view.getUint32(p), {
        duration: view.getUint32(p + 8),
        size: view.getUint32(p + 12),
        flags: view.getUint32(p + 16),
      });
    }
  }

  const tracks: MovieTrack[] = [];
  for (const trak of children(view, ...inside(moov)).filter((box) => box.type === "trak")) {
    const tkhd = child(view, trak, "tkhd");
    const mdhd = path(view, trak, "mdia", "mdhd");
    const hdlr = path(view, trak, "mdia", "hdlr");
    const stbl = path(view, trak, "mdia", "minf", "stbl");
    if (!tkhd || !mdhd || !hdlr || !stbl) continue;
    const id = view.getUint32(fullBoxBody(tkhd) + (view.getUint8(tkhd.start + tkhd.headerSize) === 1 ? 16 : 8));
    const mdhdVersion = view.getUint8(mdhd.start + mdhd.headerSize);
    const mdhdBody = fullBoxBody(mdhd) + (mdhdVersion === 1 ? 16 : 8);
    const mediaTimescale = view.getUint32(mdhdBody) || 1;
    const mediaDuration = mdhdVersion === 1 ? Number(view.getBigUint64(mdhdBody + 4)) : view.getUint32(mdhdBody + 4);
    const handler = fourcc(view, fullBoxBody(hdlr) + 4);
    const stsd = child(view, stbl, "stsd");
    let config: TrackConfig | null = null;
    try {
      config = stsd ? sampleEntryConfig(view, stsd, handler) : null;
    } catch (err) {
      if (!(err instanceof Mp4Error)) throw err;
    }
    tracks.push({
      id,
      handler,
      timescale: mediaTimescale,
      config,
      shift: editShift(view, trak, timescale, mediaTimescale),
      duration: mediaDuration > 0 && mediaDuration < 0xffffffff ? mediaDuration / mediaTimescale : 0,
      defaults: trexDefaults.get(id) ?? { duration: 0, size: 0, flags: 0 },
      table: mvex ? null : sampleTable(view, stbl),
    });
  }
  return {
    timescale,
    duration: movieDuration > 0 && movieDuration < 0xffffffff ? movieDuration / timescale : 0,
    fragmented: Boolean(mvex),
    tracks,
  };
}

/**
 * Where ``moov`` is, from the first bytes of a file: ``found`` (complete in
 * ``data``), ``need`` (read [0, bytes) and ask again) or ``at`` (read the box
 * at that offset; used when ``moov`` comes after a large ``mdat``).
 */
export function locateMoov(
  data: ArrayBuffer,
  from = 0,
): { kind: "found"; start: number; end: number } | { kind: "need"; bytes: number } | { kind: "at"; offset: number } | { kind: "missing" } {
  const view = new DataView(data);
  let offset = from;
  for (let guard = 0; guard < 1024; guard++) {
    if (offset + 8 > view.byteLength) return { kind: "at", offset };
    if (view.getUint32(offset) === 0) return { kind: "missing" }; // a box running to the end of the file
    const box = readBox(view, offset, Number.MAX_SAFE_INTEGER);
    if (!box) return { kind: "missing" };
    if ("need" in box) return { kind: "at", offset };
    if (box.type === "moov") {
      const end = box.start + box.size;
      return end <= view.byteLength ? { kind: "found", start: box.start, end } : { kind: "need", bytes: end };
    }
    offset = box.start + box.size;
  }
  return { kind: "missing" };
}

// -- fragments ---------------------------------------------------------------------

const NON_SYNC = 0x00010000;

/**
 * Samples of ``track`` in the ``moof``/``mdat`` pairs of ``data``, in decode order.
 * ``dataStart`` is the file offset of ``data[0]``; it resolves absolute base offsets.
 */
export function parseFragments(data: Uint8Array, dataStart: number, track: MovieTrack): FragmentSample[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const samples: FragmentSample[] = [];
  const audio = track.config?.kind === "audio";
  let nextDts = 0;
  for (const moof of children(view, 0, view.byteLength).filter((box) => box.type === "moof")) {
    for (const traf of children(view, ...inside(moof)).filter((box) => box.type === "traf")) {
      const tfhd = child(view, traf, "tfhd");
      if (!tfhd) continue;
      const tfhdFlags = view.getUint32(tfhd.start + tfhd.headerSize) & 0xffffff;
      let p = fullBoxBody(tfhd);
      if (view.getUint32(p) !== track.id) continue;
      p += 4;
      let base = moof.start;
      if (tfhdFlags & 0x1) {
        base = Number(view.getBigUint64(p)) - dataStart;
        p += 8;
      }
      if (tfhdFlags & 0x2) p += 4; // sample_description_index
      let defaultDuration = track.defaults.duration;
      let defaultSize = track.defaults.size;
      let defaultFlags = track.defaults.flags;
      if (tfhdFlags & 0x8) {
        defaultDuration = view.getUint32(p);
        p += 4;
      }
      if (tfhdFlags & 0x10) {
        defaultSize = view.getUint32(p);
        p += 4;
      }
      if (tfhdFlags & 0x20) defaultFlags = view.getUint32(p);

      const tfdt = child(view, traf, "tfdt");
      if (tfdt) {
        const version = view.getUint8(tfdt.start + tfdt.headerSize);
        nextDts = version === 1 ? Number(view.getBigUint64(fullBoxBody(tfdt))) : view.getUint32(fullBoxBody(tfdt));
      }

      let dataEnd = base; // consecutive truns without data_offset continue where the last ended
      for (const trun of children(view, ...inside(traf)).filter((box) => box.type === "trun")) {
        const version = view.getUint8(trun.start + trun.headerSize);
        const flags = view.getUint32(trun.start + trun.headerSize) & 0xffffff;
        let q = fullBoxBody(trun);
        const count = view.getUint32(q);
        q += 4;
        let position = dataEnd;
        if (flags & 0x1) {
          position = base + view.getInt32(q);
          q += 4;
        }
        let firstFlags: number | null = null;
        if (flags & 0x4) {
          firstFlags = view.getUint32(q);
          q += 4;
        }
        for (let i = 0; i < count; i++) {
          let duration = defaultDuration;
          let size = defaultSize;
          let sampleFlags = i === 0 && firstFlags !== null ? firstFlags : defaultFlags;
          let offset = 0;
          if (flags & 0x100) {
            duration = view.getUint32(q);
            q += 4;
          }
          if (flags & 0x200) {
            size = view.getUint32(q);
            q += 4;
          }
          if (flags & 0x400) {
            const value = view.getUint32(q);
            if (!(i === 0 && firstFlags !== null)) sampleFlags = value;
            q += 4;
          }
          if (flags & 0x800) {
            offset = version === 0 ? view.getUint32(q) : view.getInt32(q);
            q += 4;
          }
          if (position < 0 || position + size > data.byteLength) throw new Mp4Error("sample data outside the fragment");
          samples.push({
            data: data.subarray(position, position + size),
            dts: nextDts,
            cts: nextDts + offset,
            duration,
            key: audio || !(sampleFlags & NON_SYNC),
          });
          position += size;
          nextDts += duration;
        }
        dataEnd = position;
      }
    }
  }
  return samples;
}

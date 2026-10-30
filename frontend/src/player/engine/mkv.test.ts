import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findCluster, ID, parseCues, parseHead, readClusters, readElement, type MkvFrame, type MkvHead } from "./mkv";

// Real files from scripts/make-mkv-fixtures.sh, checked against what ffprobe reads from them.

interface Probe {
  streams: Array<{ index: number; type: string; codec: string }>;
  packets: Array<{ stream: number; pts: number | null; size: number; key: boolean }>;
}

// Vitest runs from the frontend folder.
const FIXTURES = path.resolve("src/player/engine/fixtures/mkv");
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));
const probe = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Probe;

function headOf(bytes: Uint8Array): MkvHead {
  const head = parseHead(bytes);
  if ("need" in head) throw new Error(`head needs ${head.need} bytes`);
  return head;
}

function framesOf(bytes: Uint8Array, head: MkvHead): MkvFrame[] {
  const start = head.firstCluster!;
  return readClusters(bytes.subarray(start), start, head, head.tracks).frames;
}

const FILES: Array<[string, string, string]> = [
  ["h264-aac.mkv", "avc1.", "mp4a.40.2"],
  ["hevc-aac.mkv", "hvc1.", "mp4a.40.2"],
  ["av1-opus.webm", "av01.", "opus"],
  ["vp9-opus.webm", "vp09.", "opus"],
  ["h264-ac3.mkv", "avc1.", "ac-3"],
  ["h264-flac.mkv", "avc1.", "flac"],
  ["h264-aac-live.mkv", "avc1.", "mp4a.40.2"],
];

describe.each(FILES)("%s", (name, videoCodec, audioCodec) => {
  const bytes = fixture(name);
  const expected = probe(name);
  const head = headOf(bytes);

  it("reads the tracks and their WebCodecs configurations", () => {
    const [video, audio] = head.tracks;
    expect(video).toMatchObject({ kind: "video", number: 1 });
    expect(video!.config).toMatchObject({ kind: "video", width: 160 });
    expect(video!.config!.codec.startsWith(videoCodec)).toBe(true);
    expect(audio).toMatchObject({ kind: "audio", number: 2 });
    expect(audio!.config).toMatchObject({ kind: "audio", codec: audioCodec, sampleRate: 48000 });
    expect(head.timestampScale).toBe(1_000_000);
  });

  it("cuts out every frame ffprobe sees, with the same size, key flag and timestamp", () => {
    const frames = framesOf(bytes, head);
    for (const stream of expected.streams) {
      const mine = frames.filter((frame) => frame.track === stream.index + 1);
      const theirs = expected.packets.filter((packet) => packet.stream === stream.index);
      expect(mine.map((frame) => frame.data.length)).toEqual(theirs.map((packet) => packet.size));
      expect(mine.map((frame) => frame.key)).toEqual(theirs.map((packet) => packet.key));
      // ffprobe works in the file's 1 ms ticks and rounds the codec delay (AAC and Opus priming)
      // to them; the demuxer subtracts it exactly, as the specification says.
      const off = mine.map((frame, i) => Math.abs(frame.timestamp - theirs[i]!.pts!));
      expect(Math.max(...off)).toBeLessThanOrEqual(1000);
    }
  });
});

describe("cues", () => {
  it("point at clusters, and at the key frame inside them", () => {
    const bytes = fixture("h264-aac.mkv");
    const head = headOf(bytes);
    const at = head.positions.get(ID.Cues)!;
    expect(at).toBeGreaterThan(head.firstCluster!); // written after the clusters, found through the SeekHead
    const cues = parseCues(bytes.subarray(at), head);
    const scan = readClusters(bytes.subarray(head.firstCluster!), head.firstCluster!, head, head.tracks);
    const videoKeys = scan.frames.filter((frame) => frame.track === 1 && frame.key);
    expect(cues.filter((cue) => cue.track === 1).map((cue) => Math.round(cue.time * 1e6))).toEqual(
      videoKeys.map((frame) => frame.timestamp),
    );
    for (const cue of cues) {
      const dataStart = scan.clusters.get(cue.cluster);
      expect(dataStart).toBeDefined();
      if (cue.relative !== null) {
        const keyFrame = scan.frames.find((frame) => frame.position === dataStart! + cue.relative!);
        expect(keyFrame).toMatchObject({ track: cue.track, key: true });
      }
    }
  });

  it("a live file has none, and unknown sizes", () => {
    const head = headOf(fixture("h264-aac-live.mkv"));
    expect(head.segmentEnd).toBe(Infinity);
    expect(head.positions.has(ID.Cues)).toBe(false);
  });
});

describe("tracks WebCodecs can't take", () => {
  it("DTS is named but has no configuration", () => {
    const head = headOf(fixture("h264-dts.mkv"));
    expect(head.tracks[1]).toMatchObject({ kind: "audio", codecId: "A_DTS", codecName: "DTS", config: null });
  });
});

describe("parseHead", () => {
  it("asks for more bytes until it has the tracks", () => {
    const bytes = fixture("h264-aac.mkv");
    expect(parseHead(bytes.subarray(0, 20))).toHaveProperty("need");
    let length = 20;
    let head = parseHead(bytes.subarray(0, length));
    for (let guard = 0; "need" in head && guard < 20; guard++) {
      length = Math.min(bytes.length, head.need);
      head = parseHead(bytes.subarray(0, length));
    }
    expect("need" in head).toBe(false);
    expect(length).toBeLessThan(bytes.length);
  });

  it("refuses files that aren't Matroska", () => {
    expect(() => parseHead(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toThrow("isn't a Matroska");
  });
});

describe("findCluster", () => {
  it("resynchronizes on the next real cluster", () => {
    const bytes = fixture("h264-aac.mkv");
    const head = headOf(bytes);
    expect(findCluster(bytes, 0)).toBe(head.firstCluster);
    const second = findCluster(bytes, head.firstCluster! + 1);
    expect(second).toBeGreaterThan(head.firstCluster!);
    const cluster = readElement(bytes, second);
    expect(cluster).toMatchObject({ id: ID.Cluster });
  });
});

// -- hand-built EBML for what ffmpeg doesn't write: lacing, header stripping, BlockGroups ------

const idBytes = (id: number) => {
  const out: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) out.unshift(value & 0xff);
  return out;
};
const sizeBytes = (n: number) => (n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff]);
const uintBytes = (n: number) => {
  const out: number[] = [];
  for (let value = n; out.length === 0 || value > 0; value = Math.floor(value / 256)) out.unshift(value & 0xff);
  return out;
};
const el = (id: number, ...parts: number[][]) => {
  const body = parts.flat();
  return [...idBytes(id), ...sizeBytes(body.length), ...body];
};
const uel = (id: number, n: number) => el(id, uintBytes(n));
const str = (id: number, s: string) => el(id, [...s].map((c) => c.charCodeAt(0)));
const int16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const bytesOf = (n: number, fill: number) => new Array<number>(n).fill(fill);

function synthetic(clusterParts: number[][]): Uint8Array {
  const tracks = el(
    ID.Tracks,
    el(ID.TrackEntry, uel(ID.TrackNumber, 1), uel(ID.TrackType, 1), str(ID.CodecID, "V_MPEG4/ISO/AVC"),
      el(ID.CodecPrivate, [1, 0x64, 0x00, 0x1e, 0xff]), el(ID.Video, uel(ID.PixelWidth, 64), uel(ID.PixelHeight, 36))),
    el(ID.TrackEntry, uel(ID.TrackNumber, 2), uel(ID.TrackType, 2), str(ID.CodecID, "A_AAC"),
      el(ID.CodecPrivate, [0x11, 0x90]), uel(ID.DefaultDuration, 21_333_333),
      el(ID.Audio, el(ID.SamplingFrequency, [0x47, 0x3b, 0x80, 0x00]), uel(ID.Channels, 2)),
      // Header stripping: every frame of this track lost its first two bytes.
      el(ID.ContentEncodings, el(ID.ContentEncoding, el(ID.ContentCompression, uel(ID.ContentCompAlgo, 3), el(ID.ContentCompSettings, [0xff, 0xf1]))))),
  );
  const segment = el(ID.Segment, el(ID.Info, uel(ID.TimestampScale, 1_000_000)), tracks, el(ID.Cluster, uel(ID.Timestamp, 1000), ...clusterParts));
  return new Uint8Array([...el(ID.EBML, str(ID.DocType, "matroska")), ...segment]);
}

function syntheticFrames(...clusterParts: number[][]): MkvFrame[] {
  const bytes = synthetic(clusterParts);
  const head = headOf(bytes);
  return framesOf(bytes, head);
}

describe("blocks", () => {
  it("reads key and delta frames from SimpleBlocks and BlockGroups, with signed timecodes", () => {
    const frames = syntheticFrames(
      el(ID.SimpleBlock, [0x81, ...int16(0), 0x80, ...bytesOf(10, 1)]),
      el(ID.BlockGroup, el(ID.Block, [0x81, ...int16(-40), 0x00, ...bytesOf(6, 2)]), el(ID.ReferenceBlock, [0xd8]), uel(ID.BlockDuration, 40)),
    );
    expect(frames.map((frame) => [frame.track, frame.timestamp, frame.key, frame.data.length, frame.duration])).toEqual([
      [1, 1_000_000, true, 10, 0],
      [1, 960_000, false, 6, 40_000],
    ]);
  });

  it.each([
    ["Xiph", 0x02, [2, 3, 4]],
    ["EBML", 0x06, [2, 0x83, 0xbf + 1]],
    ["fixed", 0x04, [2]],
  ])("splits %s-laced audio and restores stripped headers", (_name, flags, lacing) => {
    const sizes = flags === 0x04 ? [3, 3, 3] : [3, 4, 2];
    const payload = sizes.flatMap((size, i) => bytesOf(size, 10 + i));
    const frames = syntheticFrames(el(ID.SimpleBlock, [0x82, ...int16(0), 0x80 | flags, ...lacing, ...payload]));
    expect(frames.map((frame) => frame.data.length)).toEqual(sizes.map((size) => size + 2));
    expect(frames.every((frame) => frame.data[0] === 0xff && frame.data[1] === 0xf1)).toBe(true);
    expect(frames.map((frame) => frame.data[2])).toEqual([10, 11, 12]);
    // Each laced frame advances by the track's DefaultDuration (21.333 ms).
    expect(frames.map((frame) => frame.timestamp)).toEqual([1_000_000, 1_021_333, 1_042_667]);
    expect(frames.every((frame) => frame.key)).toBe(true);
  });
});

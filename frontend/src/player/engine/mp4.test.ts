import { describe, expect, it } from "vitest";

import { locateMoov, parseFragments, parseMovie } from "./mp4";

const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n: number) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
const zeros = (n: number) => new Array<number>(n).fill(0);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function box(type: string, ...parts: number[][]): number[] {
  const body = parts.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}
const full = (type: string, version: number, flags: number, ...parts: number[][]) =>
  box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);

const mvhd = (timescale: number, duration: number) => full("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), zeros(80));
const tkhd = (id: number) => full("tkhd", 0, 3, u32(0), u32(0), u32(id), u32(0), u32(0), zeros(60));
const mdhd = (timescale: number, duration: number) => full("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0));
const hdlr = (handler: string) => full("hdlr", 0, 0, u32(0), ascii(handler), zeros(12), [0]);

const avc1 = (width: number, height: number) =>
  box("avc1", zeros(6), u16(1), zeros(16), u16(width), u16(height), zeros(50), box("avcC", [1, 0x64, 0x00, 0x1f, 0xff, 0xe1]));

// ES descriptor → decoder config (AAC, 0x40) → AudioSpecificConfig 0x12 0x10 (AAC-LC, 44.1 kHz, stereo).
const esds = full(
  "esds", 0, 0,
  [0x03, 25, ...u16(1), 0],
  [0x04, 17, 0x40, 0x15, ...zeros(3), ...u32(128000), ...u32(128000)],
  [0x05, 2, 0x12, 0x10],
  [0x06, 1, 0x02],
);
const mp4a = (rate: number, channels: number) =>
  box("mp4a", zeros(6), u16(1), zeros(8), u16(channels), u16(16), zeros(4), u32(rate * 65536), esds);

const stsd = (entry: number[]) => full("stsd", 0, 0, u32(1), entry);

function videoTrak(withTables: boolean) {
  const tables = withTables
    ? [
        full("stts", 0, 0, u32(1), u32(4), u32(40)),
        full("ctts", 0, 0, u32(1), u32(4), u32(40)),
        full("stss", 0, 0, u32(2), u32(1), u32(3)),
        full("stsz", 0, 0, u32(0), u32(4), u32(10), u32(5), u32(5), u32(5)),
        full("stsc", 0, 0, u32(1), u32(1), u32(2), u32(1)),
        full("stco", 0, 0, u32(2), u32(1000), u32(2000)),
      ]
    : [full("stts", 0, 0, u32(0)), full("stsz", 0, 0, u32(0), u32(0)), full("stsc", 0, 0, u32(0)), full("stco", 0, 0, u32(0))];
  return box(
    "trak",
    tkhd(1),
    // Edit list: start presenting at media time 40 (the B-frame delay).
    box("edts", full("elst", 0, 0, u32(1), u32(160), u32(40), u16(1), u16(0))),
    box("mdia", mdhd(1000, 160), hdlr("vide"), box("minf", box("stbl", stsd(avc1(640, 360)), ...tables))),
  );
}

const audioTrak = box(
  "trak",
  tkhd(2),
  box(
    "mdia",
    mdhd(44100, 4096),
    hdlr("soun"),
    box(
      "minf",
      box(
        "stbl",
        stsd(mp4a(44100, 2)),
        full("stts", 0, 0, u32(1), u32(4), u32(1024)),
        full("stsz", 0, 0, u32(6), u32(4)),
        full("stsc", 0, 0, u32(1), u32(1), u32(4), u32(1)),
        full("stco", 0, 0, u32(1), u32(3000)),
      ),
    ),
  ),
);

describe("parseMovie", () => {
  it("reads codec configs, edit lists and sample tables of a regular MP4", () => {
    const moov = box("moov", mvhd(1000, 160), videoTrak(true), audioTrak);
    const movie = parseMovie(new Uint8Array(moov));
    expect(movie.fragmented).toBe(false);
    expect(movie.duration).toBeCloseTo(0.16);

    const [video, audio] = movie.tracks;
    expect(video!.config).toMatchObject({ kind: "video", codec: "avc1.64001F", width: 640, height: 360 });
    expect(video!.config!.description).toEqual(new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1]));
    expect(video!.shift).toBeCloseTo(-0.04);
    const table = video!.table!;
    expect([...table.offsets]).toEqual([1000, 1010, 2000, 2005]);
    expect([...table.sizes]).toEqual([10, 5, 5, 5]);
    expect([...table.dts]).toEqual([0, 40, 80, 120]);
    expect([...table.cts]).toEqual([40, 80, 120, 160]);
    expect([...table.keys]).toEqual([1, 0, 1, 0]);

    expect(audio!.config).toMatchObject({ kind: "audio", codec: "mp4a.40.2", sampleRate: 44100, channels: 2 });
    expect(audio!.config!.description).toEqual(new Uint8Array([0x12, 0x10]));
    expect([...audio!.table!.offsets]).toEqual([3000, 3006, 3012, 3018]);
    expect([...audio!.table!.keys]).toEqual([1, 1, 1, 1]);
  });

  it("builds HEVC codec strings from hvcC", () => {
    const record = [1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0];
    const hvc1 = box("hvc1", zeros(6), u16(1), zeros(16), u16(1920), u16(1080), zeros(50), box("hvcC", record));
    const trak = box("trak", tkhd(1), box("mdia", mdhd(90000, 0), hdlr("vide"), box("minf", box("stbl", stsd(hvc1)))));
    const movie = parseMovie(new Uint8Array(box("moov", mvhd(1000, 0), trak, box("mvex", full("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))))));
    expect(movie.tracks[0]!.config).toMatchObject({ codec: "hvc1.1.6.L93.B0", width: 1920, height: 1080 });
    expect(movie.tracks[0]!.config!.description).toEqual(new Uint8Array(record));
  });

  it("builds AV1 codec strings from av1C", () => {
    const av01 = box("av01", zeros(6), u16(1), zeros(16), u16(1920), u16(1080), zeros(50), box("av1C", [0x81, 0x08, 0x0c, 0x00]));
    const trak = box("trak", tkhd(1), box("mdia", mdhd(90000, 0), hdlr("vide"), box("minf", box("stbl", stsd(av01)))));
    const movie = parseMovie(new Uint8Array(box("moov", mvhd(1000, 0), trak, box("mvex", full("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))))));
    expect(movie.tracks[0]!.config).toMatchObject({ codec: "av01.0.08M.08", width: 1920, height: 1080 });
  });
});

describe("parseFragments", () => {
  it("cuts samples out of moof/mdat with per-sample sizes, flags and composition offsets", () => {
    const trex = full("trex", 0, 0, u32(1), u32(1), u32(1000), u32(0), u32(0x01010000));
    const moov = box("moov", mvhd(1000, 0), videoTrak(false), box("mvex", trex));
    const track = parseMovie(new Uint8Array(moov)).tracks[0]!;
    expect(track.table).toBeNull();

    const payload = [1, 1, 1, 2, 2, 3, 3, 3, 3];
    const trun = (dataOffset: number) =>
      full("trun", 1, 0x1 | 0x200 | 0x400 | 0x800, u32(3), u32(dataOffset),
        u32(3), u32(0x02000000), u32(1000),
        u32(2), u32(0x01010000), u32(-500 >>> 0),
        u32(4), u32(0x01010000), u32(0));
    const traf = (dataOffset: number) =>
      box("traf", full("tfhd", 0, 0x20000, u32(1)), full("tfdt", 1, 0, u64(9000)), trun(dataOffset));
    const moofSize = box("moof", full("mfhd", 0, 0, u32(1)), traf(0)).length;
    const moof = box("moof", full("mfhd", 0, 0, u32(1)), traf(moofSize + 8));
    const segment = new Uint8Array([...moof, ...box("mdat", payload)]);

    const samples = parseFragments(segment, 5000, track);
    expect(samples.map((s) => [...s.data])).toEqual([[1, 1, 1], [2, 2], [3, 3, 3, 3]]);
    expect(samples.map((s) => s.dts)).toEqual([9000, 10000, 11000]);
    expect(samples.map((s) => s.cts)).toEqual([10000, 9500, 11000]);
    expect(samples.map((s) => s.key)).toEqual([true, false, false]);
    expect(samples.map((s) => s.duration)).toEqual([1000, 1000, 1000]);
  });
});

describe("locateMoov", () => {
  const ftyp = box("ftyp", ascii("isom"), u32(0));
  it("finds a complete moov, or says how much more to read", () => {
    const moov = box("moov", mvhd(1000, 0));
    const file = [...ftyp, ...moov, ...box("mdat", [1, 2, 3])];
    expect(locateMoov(new Uint8Array(file).buffer)).toEqual({ kind: "found", start: ftyp.length, end: ftyp.length + moov.length });
    expect(locateMoov(new Uint8Array(file.slice(0, ftyp.length + 20)).buffer)).toEqual({ kind: "need", bytes: ftyp.length + moov.length });
  });

  it("points past a large mdat when moov comes last", () => {
    const head = [...ftyp, ...u32(1_000_000), ...ascii("mdat"), ...zeros(64)];
    expect(locateMoov(new Uint8Array(head).buffer)).toEqual({ kind: "at", offset: ftyp.length + 1_000_000 });
  });

  it("reads 64-bit box sizes", () => {
    const big = [...u32(1), ...ascii("mdat"), ...u64(2 ** 33), ...zeros(8)];
    expect(locateMoov(new Uint8Array([...ftyp, ...big]).buffer)).toEqual({ kind: "at", offset: ftyp.length + 2 ** 33 });
  });
});

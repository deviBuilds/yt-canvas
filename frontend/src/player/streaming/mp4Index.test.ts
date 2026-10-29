import { describe, expect, it } from "vitest";

import { parseTrackHead, segmentAt } from "./mp4Index";

function box(type: string, payload: number[] = []): number[] {
  const size = 8 + payload.length;
  return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...payload];
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];

function sidxV0(timescale: number, earliest: number, firstOffset: number, refs: Array<[size: number, duration: number]>) {
  return box("sidx", [
    0, 0, 0, 0, // version 0, flags
    ...u32(1), // reference_ID
    ...u32(timescale),
    ...u32(earliest),
    ...u32(firstOffset),
    ...u16(0),
    ...u16(refs.length),
    ...refs.flatMap(([size, duration]) => [...u32(size), ...u32(duration), ...u32(0x90000000)]),
  ]);
}

const bytes = (...parts: number[][]) => new Uint8Array(parts.flat()).buffer;

describe("parseTrackHead", () => {
  it("finds the init segment and maps the index to byte ranges and times", () => {
    const head = [...box("ftyp", [0, 0, 0, 0]), ...box("moov", new Array(20).fill(0))];
    const sidx = sidxV0(1000, 0, 0, [[100, 2000], [150, 2000], [80, 1500]]);
    const result = parseTrackHead(bytes(head, sidx));
    expect(result.kind).toBe("index");
    if (result.kind !== "index") return;
    const { initEnd, segments, duration } = result.index;
    expect(initEnd).toBe(head.length);
    const first = head.length + sidx.length;
    expect(segments).toEqual([
      { start: first, end: first + 99, time: 0, duration: 2 },
      { start: first + 100, end: first + 249, time: 2, duration: 2 },
      { start: first + 250, end: first + 329, time: 4, duration: 1.5 },
    ]);
    expect(duration).toBe(5.5);
  });

  it("asks for more bytes when the index doesn't fit yet", () => {
    const head = [...box("ftyp", [0, 0, 0, 0]), ...box("moov", new Array(20).fill(0))];
    const sidx = sidxV0(1000, 0, 0, [[100, 2000]]);
    const full = [...head, ...sidx];
    expect(parseTrackHead(bytes(full.slice(0, full.length - 5)))).toEqual({ kind: "need", bytes: full.length });
    expect(parseTrackHead(bytes(head.slice(0, 10)))).toMatchObject({ kind: "need" });
  });

  it("rejects tracks without an index before the media", () => {
    const noIndex = bytes(box("ftyp", [0, 0, 0, 0]), box("moov"), box("moof"), box("mdat"));
    expect(parseTrackHead(noIndex)).toMatchObject({ kind: "invalid" });
  });

  it("honours first_offset and a non-zero earliest presentation time", () => {
    const head = [...box("ftyp"), ...box("moov")];
    const sidx = sidxV0(90000, 9000, 16, [[50, 180000]]);
    const result = parseTrackHead(bytes(head, sidx));
    if (result.kind !== "index") throw new Error(result.kind);
    expect(result.index.segments[0]).toEqual({ start: head.length + sidx.length + 16, end: head.length + sidx.length + 65, time: 0.1, duration: 2 });
  });
});

describe("segmentAt", () => {
  const segments = [0, 2, 4, 6].map((time, i) => ({ start: i * 10, end: i * 10 + 9, time, duration: 2 }));
  it("finds the segment containing a time", () => {
    expect(segmentAt(segments, 0)).toBe(0);
    expect(segmentAt(segments, 1.99)).toBe(0);
    expect(segmentAt(segments, 2)).toBe(1);
    expect(segmentAt(segments, 5.5)).toBe(2);
    expect(segmentAt(segments, 100)).toBe(3);
  });
});

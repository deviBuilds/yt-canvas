import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseHead, readClusters, type MkvFrame } from "./mkv";
import { openMkv } from "./mkvReader";
import type { EncodedSample, MediaReaders, RangeFetcher } from "./readers";

const FIXTURES = path.resolve("src/player/engine/fixtures/mkv");
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

/** Serves a fixture like an HTTP server with Range support, and records what was asked for. */
function server(bytes: Uint8Array) {
  const requests: Array<[number, number]> = [];
  const fetcher: RangeFetcher = async (start, end) => {
    requests.push([start, end]);
    return bytes.slice(start, Math.min(end, bytes.length - 1) + 1).buffer;
  };
  return { fetcher, size: () => bytes.length, requests };
}

const signal = new AbortController().signal;

/** Everything the demuxer reads from the whole file, per track: the reference to compare windows to. */
function allFrames(bytes: Uint8Array, track: number): MkvFrame[] {
  const head = parseHead(bytes);
  if ("need" in head) throw new Error("short");
  return readClusters(bytes.subarray(head.firstCluster!), head.firstCluster!, head, head.tracks).frames.filter((f) => f.track === track);
}

async function loadAll(readers: MediaReaders) {
  const video: EncodedSample[][] = [];
  const audio: EncodedSample[][] = [];
  for (let i = 0; i < readers.video!.segments.length; i++) {
    video.push(await readers.video!.load(i, signal));
    audio.push(await readers.audio!.load(i, signal));
  }
  return { video, audio };
}

const shape = (frames: Array<EncodedSample | MkvFrame>) => frames.map((f) => [f.timestamp, f.data.length, f.key]);

describe.each(["h264-aac.mkv", "hevc-aac.mkv", "vp9-opus.webm", "av1-opus.webm", "h264-aac-live.mkv"])("%s in windows", (name) => {
  const bytes = fixture(name);
  const live = name.includes("live");

  it("puts every frame in exactly one window, and starts each window on a key frame", async () => {
    const { fetcher, size } = server(bytes);
    // Tiny windows, so even a 2 s file is split many times.
    const readers = await openMkv(fetcher, size, signal, { windowBytes: live ? 6000 : 1 });
    expect(readers.video!.segments.length).toBeGreaterThan(2);
    expect(readers.duration).toBeGreaterThan(1.9);
    expect(readers.duration).toBeLessThan(2.2);

    const { video, audio } = await loadAll(readers);
    expect(shape(video.flat())).toEqual(shape(allFrames(bytes, 1)));
    expect(shape(audio.flat())).toEqual(shape(allFrames(bytes, 2)));
    for (const window of video) if (window.length > 0) expect(window[0]!.key).toBe(true);

    const times = readers.video!.segments.map((segment) => segment.time);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    if (!live) {
      // With Cues, a window's time is its first key frame's.
      video.forEach((window, i) => window.length > 0 && expect(window[0]!.timestamp).toBe(Math.round(times[i]! * 1e6)));
    }
  });
});

describe("reading economy", () => {
  it("loads a window with reads inside its own byte span", async () => {
    const bytes = fixture("h264-aac.mkv");
    const { fetcher, size, requests } = server(bytes);
    const readers = await openMkv(fetcher, size, signal, { windowBytes: 1, headBytes: 4096 });
    const opened = requests.length;
    expect(requests.every(([start, end]) => end - start < 64 * 1024)).toBe(true); // no whole-file read to open
    await readers.video!.load(2, signal);
    await readers.audio!.load(2, signal); // shared with the video lane: no second read
    const reads = requests.slice(opened);
    expect(reads).toHaveLength(1);
    const [[start, end]] = reads as [[number, number]];
    expect(end - start).toBeLessThan(bytes.length / 2);
  });
});

describe("tracks it can't play", () => {
  it("says which audio the browser can't decode", async () => {
    const { fetcher, size } = server(fixture("h264-dts.mkv"));
    await expect(openMkv(fetcher, size, signal)).rejects.toThrow("This file's audio (DTS) can't be decoded in the browser.");
  });

  it("refuses an audio track that doesn't exist", async () => {
    const { fetcher, size } = server(fixture("h264-aac.mkv"));
    await expect(openMkv(fetcher, size, signal, { audioTrack: 9 })).rejects.toThrow("This file has no audio track 9.");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fillTemplate, isoSeconds, openDash, parseManifest, type UrlFetcher } from "./dashSegments";

// DASH made by scripts/make-dash-fixtures.sh: 2 s of H.264 + AAC in 0.5 s segments.
const FIXTURES = path.resolve("src/player/engine/fixtures/dash");
const BASE = "http://localhost/fixtures/";
const signal = new AbortController().signal;

function files() {
  const fetched: string[] = [];
  const fetcher: UrlFetcher = async (url) => {
    fetched.push(url);
    return new Uint8Array(readFileSync(path.join(FIXTURES, url.slice(BASE.length)))).buffer;
  };
  return { fetcher, fetched };
}

describe("manifest helpers", () => {
  it("reads ISO 8601 durations and fills templates", () => {
    expect(isoSeconds("PT1H2M3.5S")).toBe(3723.5);
    expect(isoSeconds("P1DT1S")).toBe(86401);
    expect(isoSeconds(null)).toBe(0);
    expect(fillTemplate("chunk-$RepresentationID$-$Number%05d$.m4s", { id: "0", number: 7 })).toBe("chunk-0-00007.m4s");
    expect(fillTemplate("session/abc/$RepresentationID$/$Number$.m4s", { id: "1", number: 12 })).toBe("session/abc/1/12.m4s");
    expect(fillTemplate("t-$Time$-$Bandwidth$-$$", { id: "0", time: 6144, bandwidth: 64000 })).toBe("t-6144-64000-$");
  });

  it("rejects what isn't a manifest", () => {
    expect(() => parseManifest("<html></html>", BASE)).toThrow("couldn't be read");
  });
});

describe.each(["timeline", "number"])("a %s manifest", (layout) => {
  const url = `${BASE}${layout}/manifest.mpd`;

  it("lists the tracks and segments with absolute addresses", () => {
    const manifest = parseManifest(readFileSync(path.join(FIXTURES, layout, "manifest.mpd"), "utf8"), url);
    expect(manifest.duration).toBeCloseTo(2, 0);
    expect(manifest.video).toMatchObject({ codecs: "avc1.64000a", init: `${BASE}${layout}/init-0.m4s` });
    expect(manifest.video!.segments.map((s) => s.time)).toEqual([0, 0.5, 1, 1.5]);
    expect(manifest.video!.segments[3]!.url).toBe(`${BASE}${layout}/chunk-0-00004.m4s`);
    expect(manifest.audio!.codecs).toBe("mp4a.40.2");
  });

  it("decodes into every frame, each segment starting on a key frame", async () => {
    const { fetcher, fetched } = files();
    const readers = await openDash(url, fetcher, signal);
    expect(readers.video!.config).toMatchObject({ kind: "video", width: 160 });
    expect(readers.audio!.config).toMatchObject({ kind: "audio", codec: "mp4a.40.2" });
    expect(fetched.some((u) => u.includes("chunk"))).toBe(false); // opening reads only the manifest and init segments
    const frames = [];
    for (let i = 0; i < readers.video!.segments.length; i++) {
      const segment = await readers.video!.load(i, signal);
      expect(segment[0]!.key).toBe(true);
      frames.push(...segment);
    }
    expect(frames).toHaveLength(48);
    expect(new Set(frames.map((f) => f.timestamp)).size).toBe(48);
    const audio = await readers.audio!.load(1, signal);
    expect(audio.length).toBeGreaterThan(20);
    expect(audio.every((f) => f.key)).toBe(true);
  });
});

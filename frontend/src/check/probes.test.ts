import { afterEach, describe, expect, it, vi } from "vitest";

import { flacDescription, parseBrowser, probeAudio, probeVideo } from "./probes";

describe("parseBrowser", () => {
  it("reads the Chromium version and the Tesla build from a car's user agent", () => {
    const ua =
      "Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/88.0.4324.150 " +
      "Chrome/88.0.4324.150 Safari/537.36 Tesla/2021.36.5.5-c6d521764ab9";
    expect(parseBrowser(ua)).toEqual({ chromium: "88.0.4324.150", tesla: "2021.36.5.5-c6d521764ab9" });
  });

  it("knows a desktop Chrome isn't a Tesla, and Safari isn't Chromium", () => {
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
    expect(parseBrowser(chrome)).toEqual({ chromium: "156.0.0.0", tesla: null });
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
    expect(parseBrowser(safari)).toEqual({ chromium: null, tesla: null });
  });
});

describe("flacDescription", () => {
  it("is the fLaC marker and a STREAMINFO block with the rate, channels and sample size", () => {
    const bytes = flacDescription(48000, 2);
    expect(bytes.length).toBe(42);
    expect([...bytes.subarray(0, 8)]).toEqual([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
    // 48000 Hz = 0x0BB80, 2 channels (stored as 1), 16 bits (stored as 15)
    expect([...bytes.subarray(18, 22)]).toEqual([0x0b, 0xb8, 0x02, 0xf0]);
    const info = bytes.subarray(8);
    const rate = (info[10]! << 12) | (info[11]! << 4) | (info[12]! >> 4);
    expect(rate).toBe(48000);
  });
});

describe("codec probes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("say so when the browser has no WebCodecs", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    vi.stubGlobal("AudioDecoder", undefined);
    expect(await probeVideo("h264", "H.264", "avc1.640028")).toMatchObject({ supported: false, error: "NoWebCodecs" });
    expect(await probeAudio({ name: "aac", label: "AAC", codec: "mp4a.40.2", channels: 2 })).toMatchObject({
      supported: false,
      error: "NoWebCodecs",
    });
  });

  it("ask about hardware only for codecs that decode, and record probes that throw", async () => {
    const isConfigSupported = vi.fn(async (config: VideoDecoderConfig) => {
      if (config.codec.startsWith("vp09")) throw new TypeError("bad config");
      const supported = config.codec.startsWith("avc1");
      return { supported: config.hardwareAcceleration === "prefer-hardware" ? false : supported, config };
    });
    vi.stubGlobal("VideoDecoder", { isConfigSupported });
    expect(await probeVideo("h264", "H.264", "avc1.640028")).toMatchObject({ supported: true, hardware: false });
    expect(await probeVideo("hevc", "HEVC", "hvc1.1.6.L120.90")).toMatchObject({ supported: false, hardware: null });
    expect(await probeVideo("vp9", "VP9", "vp09.00.40.08")).toMatchObject({ supported: false, error: "TypeError" });
    expect(isConfigSupported).toHaveBeenCalledTimes(4); // hardware asked once, for H.264
  });

  it("pass audio descriptions through", async () => {
    const isConfigSupported = vi.fn(async (config: AudioDecoderConfig) => ({ supported: Boolean(config.description), config }));
    vi.stubGlobal("AudioDecoder", { isConfigSupported });
    const description = flacDescription(48000, 2);
    expect(await probeAudio({ name: "flac", label: "FLAC", codec: "flac", channels: 2, description })).toMatchObject({ supported: true });
    expect(isConfigSupported.mock.calls[0]![0]).toMatchObject({ codec: "flac", sampleRate: 48000, numberOfChannels: 2, description });
  });
});

import { describe, expect, it } from "vitest";

import { aacCodec, aacConfig, avcCodec, hevcCodec, vp9Codec, vpcCCodec } from "./codecs";

/** An hvcC record's first 13 bytes: version, profile byte, compatibility flags, constraints, level. */
function hvcC(profileByte: number, compatibility: number, constraints: number[], level: number): Uint8Array {
  const bytes = new Uint8Array(23);
  bytes[0] = 1;
  bytes[1] = profileByte;
  new DataView(bytes.buffer).setUint32(2, compatibility);
  bytes.set(constraints, 6);
  bytes[12] = level;
  return bytes;
}

describe("hevcCodec", () => {
  it("spells Main and Main 10 the way browsers expect", () => {
    // Main profile (1), compatible with profiles 1 and 2 (bits 30 and 29 → reversed 0x6), level 3.1 (93).
    expect(hevcCodec("hvc1", hvcC(0x01, 0x60000000, [0xb0], 93))).toBe("hvc1.1.6.L93.B0");
    // Main 10 (2), compatible with profile 2 only (→ 0x4), level 4 (120).
    expect(hevcCodec("hev1", hvcC(0x02, 0x20000000, [0x90], 120))).toBe("hev1.2.4.L120.90");
  });

  it("writes the high tier, profile spaces and every non-zero constraint byte", () => {
    expect(hevcCodec("hvc1", hvcC(0x21, 0x40000000, [0x90, 0, 0, 0x01], 153))).toBe("hvc1.1.2.H153.90.00.00.01");
    expect(hevcCodec("hvc1", hvcC(0x41, 0x60000000, [], 93))).toBe("hvc1.A1.6.L93");
  });

  it("refuses a truncated record", () => {
    expect(() => hevcCodec("hvc1", new Uint8Array(5))).toThrow("truncated hvcC");
  });
});

describe("other codec strings", () => {
  it("AVC from avcC", () => {
    expect(avcCodec("avc1", new Uint8Array([1, 0x64, 0x00, 0x28]))).toBe("avc1.640028");
  });

  it("VP9 with defaults, and from vpcC", () => {
    expect(vp9Codec()).toBe("vp09.00.10.08");
    expect(vp9Codec(2)).toBe("vp09.02.10.10");
    // vpcC: version 1, flags, profile 0, level 4.1 (41), 8-bit (0x80 = bit depth 8, chroma 0, full range 0).
    expect(vpcCCodec(new Uint8Array([1, 0, 0, 0, 0, 41, 0x80, 1, 1, 1, 0, 0]))).toBe("vp09.00.41.08");
  });

  it("AAC object types, including the escape for types above 30", () => {
    expect(aacCodec(new Uint8Array([0x12, 0x10]))).toBe("mp4a.40.2");
    expect(aacCodec(new Uint8Array([0x2b, 0x92]))).toBe("mp4a.40.5");
    expect(aacCodec(new Uint8Array([0xf8, 0x40]))).toBe("mp4a.40.34"); // 31 → 32 + 2
    expect(aacCodec(undefined)).toBe("mp4a.40.2");
  });

  it("builds an AudioSpecificConfig from a rate and channel count", () => {
    expect([...aacConfig(2, 48000, 6)]).toEqual([0x11, 0xb0]);
    expect([...aacConfig(2, 44100, 2)]).toEqual([0x12, 0x10]);
    expect(() => aacConfig(2, 12345, 2)).toThrow("frequency index");
  });
});

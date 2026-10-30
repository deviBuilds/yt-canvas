/**
 * WebCodecs codec strings and decoder descriptions, built from the configuration records
 * containers carry (MP4 sample entries, Matroska CodecPrivate). Shared by the demuxers.
 */

export class CodecError extends Error {
  override name = "CodecError";
}

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

/** ``avc1.PPCCLL`` from an AVCDecoderConfigurationRecord (``avcC``). */
export function avcCodec(type: string, avcC: Uint8Array): string {
  if (avcC.length < 4) throw new CodecError("truncated avcC");
  return `${type}.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`;
}

/**
 * ``hvc1.<space><profile>.<compatibility>.<tier><level>.<constraints>`` from an
 * HEVCDecoderConfigurationRecord (``hvcC``), as ISO/IEC 14496-15 Annex E spells it.
 */
export function hevcCodec(type: string, hvcC: Uint8Array): string {
  if (hvcC.length < 13) throw new CodecError("truncated hvcC");
  const profileSpace = ["", "A", "B", "C"][hvcC[1]! >> 6]!;
  const tier = (hvcC[1]! >> 5) & 1 ? "H" : "L";
  const profile = hvcC[1]! & 0x1f;
  const flags = ((hvcC[2]! << 24) | (hvcC[3]! << 16) | (hvcC[4]! << 8) | hvcC[5]!) >>> 0;
  let compatibility = 0; // the flags in reverse bit order
  for (let bit = 0; bit < 32; bit++) if (flags & (1 << bit)) compatibility |= 1 << (31 - bit);
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.length > 0 && constraints.at(-1) === 0) constraints.pop();
  const level = hvcC[12]!;
  const tail = constraints.map((byte) => `.${hex(byte)}`).join("");
  return `${type}.${profileSpace}${profile}.${(compatibility >>> 0).toString(16).toUpperCase()}.${tier}${level}${tail}`;
}

/** ``av01.P.LLT.DD`` from an AV1CodecConfigurationRecord (``av1C``). */
export function av1Codec(av1C: Uint8Array): string {
  if (av1C.length < 4) throw new CodecError("truncated av1C");
  const profile = av1C[1]! >> 5;
  const level = av1C[1]! & 0x1f;
  const tier = av1C[2]! >> 7 ? "H" : "M";
  const highBitDepth = (av1C[2]! >> 6) & 1;
  const twelveBit = (av1C[2]! >> 5) & 1;
  const depth = highBitDepth ? (twelveBit ? 12 : 10) : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`;
}

/** ``vp09.PP.LL.DD``. Level 10 (1.0) when unknown: decoders don't limit on it. */
export function vp9Codec(profile = 0, level = 10, bitDepth = profile >= 2 ? 10 : 8): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `vp09.${two(profile)}.${two(level)}.${two(bitDepth)}`;
}

/** The VP9 codec string from an MP4 ``vpcC`` box payload (a full box: version and flags first). */
export function vpcCCodec(vpcC: Uint8Array): string {
  if (vpcC.length < 7) throw new CodecError("truncated vpcC");
  return vp9Codec(vpcC[4], vpcC[5], vpcC[6]! >> 4);
}

/** ``mp4a.40.<object type>`` from an AAC AudioSpecificConfig; the config is also the description. */
export function aacCodec(asc: Uint8Array | undefined): string {
  let objectType = asc && asc.length > 0 ? asc[0]! >> 3 : 2;
  if (objectType === 31 && asc && asc.length > 1) objectType = 32 + (((asc[0]! & 7) << 3) | (asc[1]! >> 5));
  return `mp4a.40.${objectType}`;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** A two-byte AudioSpecificConfig, for containers that only give the rate and channel count. */
export function aacConfig(objectType: number, sampleRate: number, channels: number): Uint8Array {
  const index = AAC_RATES.indexOf(sampleRate);
  if (index < 0) throw new CodecError(`no AAC frequency index for ${sampleRate} Hz`);
  return new Uint8Array([(objectType << 3) | (index >> 1), ((index & 1) << 7) | ((channels & 0x0f) << 3)]);
}

/**
 * The ``description`` WebCodecs needs for FLAC: the "fLaC" marker and a STREAMINFO block.
 * Only the fields a decoder checks are filled in; frame sizes, sample count and MD5 stay 0.
 */
export function flacDescription(sampleRate: number, channels: number, bitsPerSample = 16): Uint8Array {
  const out = new Uint8Array(8 + 34);
  out.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
  out.set([0x80, 0, 0, 34], 4); // last metadata block, type 0 (STREAMINFO), 34 bytes
  const info = out.subarray(8);
  info.set([0x10, 0x00, 0x10, 0x00], 0); // min and max block size: 4096
  // 20 bits sample rate, 3 bits channels - 1, 5 bits bits-per-sample - 1, then 36 bits of sample count.
  info[10] = (sampleRate >> 12) & 0xff;
  info[11] = (sampleRate >> 4) & 0xff;
  info[12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bitsPerSample - 1) >> 4) & 0x01);
  info[13] = ((bitsPerSample - 1) & 0x0f) << 4;
  return out;
}

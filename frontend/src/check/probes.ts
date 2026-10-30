import { flacDescription } from "@/player/engine/codecs";

/**
 * What this browser offers the player: WebCodecs codecs (and whether they run in
 * hardware), Media Source types, and the other web APIs the app may rely on. Used by
 * the /check page, which is meant to run in other browsers too, such as a car's.
 */

export interface BrowserInfo {
  /** Chromium version from the user agent, e.g. "156.0.0.0". */
  chromium: string | null;
  /** Tesla software build from the user agent's ``Tesla/`` token, e.g. "2026.32.5". */
  tesla: string | null;
}

export interface CodecResult {
  name: string;
  label: string;
  codec: string;
  supported: boolean;
  /** Video only: whether the browser reports a hardware decoder (null when not asked or unknown). */
  hardware?: boolean | null;
  /** The exception's name when the probe itself threw, e.g. "TypeError" for a config it rejects. */
  error?: string;
}

export interface Capabilities {
  userAgent: string;
  browser: BrowserInfo;
  device: {
    screen: [number, number];
    viewport: [number, number];
    pixelRatio: number;
    cores: number | null;
    memoryGB: number | null;
    touchPoints: number;
  };
  apis: Record<string, boolean>;
  video: CodecResult[];
  audio: CodecResult[];
  mse: Array<{ type: string; supported: boolean }>;
  drm: { widevine: boolean | null };
  network: { effectiveType: string | null; downlinkMbps: number | null; rttMs: number | null } | null;
}

export const VIDEO_CODECS = [
  { name: "h264", label: "H.264 High", codec: "avc1.640028" },
  { name: "h264-baseline", label: "H.264 Baseline", codec: "avc1.42E01E" },
  { name: "hevc", label: "HEVC Main", codec: "hvc1.1.6.L120.90" },
  { name: "hevc10", label: "HEVC Main 10", codec: "hvc1.2.4.L120.90" },
  { name: "av1", label: "AV1", codec: "av01.0.08M.08" },
  { name: "av1-10", label: "AV1 10-bit", codec: "av01.0.08M.10" },
  { name: "vp9", label: "VP9", codec: "vp09.00.40.08" },
  { name: "vp9-10", label: "VP9 10-bit", codec: "vp09.02.40.10" },
] as const;

interface AudioCodec {
  name: string;
  label: string;
  codec: string;
  channels: number;
  description?: Uint8Array;
}

export const AUDIO_CODECS: readonly AudioCodec[] = [
  { name: "aac", label: "AAC (stereo)", codec: "mp4a.40.2", channels: 2 },
  { name: "aac51", label: "AAC (5.1)", codec: "mp4a.40.2", channels: 6 },
  { name: "mp3", label: "MP3", codec: "mp3", channels: 2 },
  { name: "opus", label: "Opus", codec: "opus", channels: 2 },
  { name: "flac", label: "FLAC", codec: "flac", channels: 2, description: flacDescription(48000, 2) },
  { name: "vorbis", label: "Vorbis", codec: "vorbis", channels: 2 },
  { name: "ac3", label: "AC-3 (Dolby Digital)", codec: "ac-3", channels: 6 },
  { name: "eac3", label: "E-AC-3 (Dolby Digital Plus)", codec: "ec-3", channels: 6 },
  { name: "dts", label: "DTS", codec: "dtsc", channels: 6 },
  { name: "truehd", label: "Dolby TrueHD", codec: "mlpa", channels: 6 },
];

export const MSE_TYPES = [
  'video/mp4; codecs="avc1.640028"',
  'video/mp4; codecs="hvc1.1.6.L120.90"',
  'video/mp4; codecs="av01.0.08M.08"',
  'video/webm; codecs="vp9"',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/webm; codecs="opus"',
  "video/x-matroska",
] as const;

export function parseBrowser(userAgent: string): BrowserInfo {
  return {
    chromium: /(?:Chromium|Chrome)\/([\d.]+)/.exec(userAgent)?.[1] ?? null,
    tesla: /\bTesla\/(\S+)/.exec(userAgent)?.[1] ?? null,
  };
}

const errorName = (err: unknown) => (err instanceof Error ? err.name : String(err));

export { flacDescription };

export async function probeVideo(name: string, label: string, codec: string): Promise<CodecResult> {
  if (typeof VideoDecoder === "undefined") return { name, label, codec, supported: false, hardware: null, error: "NoWebCodecs" };
  const config: VideoDecoderConfig = { codec, codedWidth: 1920, codedHeight: 1080 };
  try {
    const supported = (await VideoDecoder.isConfigSupported(config)).supported ?? false;
    let hardware: boolean | null = null;
    if (supported) {
      const hw = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: "prefer-hardware" }).catch(() => null);
      hardware = hw?.supported ?? null;
    }
    return { name, label, codec, supported, hardware };
  } catch (err) {
    return { name, label, codec, supported: false, hardware: null, error: errorName(err) };
  }
}

export async function probeAudio({ name, label, codec, channels, description }: AudioCodec): Promise<CodecResult> {
  if (typeof AudioDecoder === "undefined") return { name, label, codec, supported: false, error: "NoWebCodecs" };
  try {
    const config: AudioDecoderConfig = { codec, sampleRate: 48000, numberOfChannels: channels, ...(description ? { description } : {}) };
    return { name, label, codec, supported: (await AudioDecoder.isConfigSupported(config)).supported ?? false };
  } catch (err) {
    return { name, label, codec, supported: false, error: errorName(err) };
  }
}

function webgl2(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(gl);
  } catch {
    return false;
  }
}

async function widevine(): Promise<boolean | null> {
  if (typeof navigator.requestMediaKeySystemAccess !== "function") return null;
  try {
    await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [
      { initDataTypes: ["cenc"], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] },
    ]);
    return true;
  } catch {
    return false;
  }
}

interface NetworkInformationLike {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

export async function collectCapabilities(): Promise<Capabilities> {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: NetworkInformationLike };
  const [video, audio, drm] = await Promise.all([
    Promise.all(VIDEO_CODECS.map(({ name, label, codec }) => probeVideo(name, label, codec))),
    Promise.all(AUDIO_CODECS.map(probeAudio)),
    widevine(),
  ]);
  return {
    userAgent: navigator.userAgent,
    browser: parseBrowser(navigator.userAgent),
    device: {
      screen: [screen.width, screen.height],
      viewport: [window.innerWidth, window.innerHeight],
      pixelRatio: window.devicePixelRatio,
      cores: nav.hardwareConcurrency ?? null,
      memoryGB: nav.deviceMemory ?? null,
      touchPoints: nav.maxTouchPoints ?? 0,
    },
    apis: {
      webCodecs: typeof VideoDecoder !== "undefined" && typeof AudioDecoder !== "undefined",
      videoFrame: typeof VideoFrame !== "undefined",
      audioContext: typeof AudioContext !== "undefined",
      mediaSource: typeof MediaSource !== "undefined",
      managedMediaSource: "ManagedMediaSource" in window,
      videoFrameCallback: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
      offscreenCanvas: typeof OffscreenCanvas !== "undefined",
      webgl2: webgl2(),
      webgpu: "gpu" in navigator,
      mediaRecorder: typeof MediaRecorder !== "undefined",
      geolocation: "geolocation" in navigator,
      wakeLock: "wakeLock" in navigator,
      fullscreen: Boolean(document.fullscreenEnabled),
      fetchStreams: typeof ReadableStream !== "undefined" && "body" in Response.prototype,
    },
    video,
    audio,
    mse: MSE_TYPES.map((type) => ({
      type,
      supported: typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type),
    })),
    drm: { widevine: drm },
    network: nav.connection
      ? {
          effectiveType: nav.connection.effectiveType ?? null,
          downlinkMbps: nav.connection.downlink ?? null,
          rttMs: nav.connection.rtt ?? null,
        }
      : null,
  };
}

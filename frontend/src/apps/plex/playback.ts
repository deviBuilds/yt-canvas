import { readJson, writeJson } from "@/library/storage";
import { CanvasEngine, type EngineSupport } from "@/player/engine/CanvasEngine";
import { dashManifestSource } from "@/player/engine/dashSegments";
import { mkvSource } from "@/player/engine/mkvReader";
import { fileSource, type EngineSource } from "@/player/engine/readers";

import type { Capabilities, PlayResponse } from "./api";

/** What the engine decodes here, in Plex's codec names, sent with every play request. */
export function capabilities(support: EngineSupport): Capabilities {
  const pick = (pairs: Array<[boolean, string]>) => pairs.filter(([ok]) => ok).map(([, name]) => name);
  return {
    video: pick([[support.avc, "h264"], [support.hevc, "hevc"], [support.av1, "av1"], [support.vp9, "vp9"]]),
    audio: pick([[support.aac, "aac"], [support.mp3, "mp3"], [support.opus, "opus"], [support.flac, "flac"]]),
  };
}

export const detectCapabilities = async () => capabilities(await CanvasEngine.probe());

/** The engine source for a play response: the original file, or the transcoder's DASH. */
export function sourceFor(play: PlayResponse, onError: (error: unknown) => boolean): EngineSource {
  if (play.mode === "transcode") return dashManifestSource(play.url, onError);
  const source = play.container === "matroska" ? mkvSource(play.url, play.audio_track ? { audioTrack: play.audio_track } : {}) : fileSource(play.url);
  return { ...source, onError };
}

/** The quality menu: Original, or a cap that makes Plex transcode down to it. Remembered per device. */
export const QUALITIES: Array<{ value: number | null; label: string }> = [
  { value: null, label: "Original" },
  { value: 20000, label: "20 Mbit/s (1080p)" },
  { value: 12000, label: "12 Mbit/s (1080p)" },
  { value: 8000, label: "8 Mbit/s (1080p)" },
  { value: 4000, label: "4 Mbit/s (720p)" },
  { value: 2000, label: "2 Mbit/s (480p)" },
];

const QUALITY_KEY = "ytc.plex.quality.v1";

export function savedQuality(): number | null {
  return readJson(QUALITY_KEY, (value) => (typeof value === "number" ? value : null), null);
}

export function saveQuality(value: number | null): void {
  writeJson(QUALITY_KEY, value);
}

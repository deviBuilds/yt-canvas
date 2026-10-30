import { useEffect, useMemo, useState } from "react";

import type { StreamTrack } from "../../api/types";
import type { EngineKind } from "../media";
import { CanvasEngine, type EngineSupport } from "./CanvasEngine";

let known: EngineSupport | null = null;

export interface EngineChoice {
  kind: EngineKind;
  /** Can this engine decode ``track``? */
  canDecode: (track: StreamTrack) => boolean;
}

/**
 * WebCodecs when the browser decodes H.264 + AAC with it, otherwise the hidden
 * <video> fallback. ``forced`` ("element" or "webcodecs", e.g. from ?engine=)
 * overrides it. Until the async probe settles, the APIs' presence is the guess.
 */
export function useEngineChoice(forced: string | null): EngineChoice {
  const [support, setSupport] = useState<EngineSupport | null>(known);
  useEffect(() => {
    if (support) return;
    let live = true;
    void CanvasEngine.probe().then((result) => {
      known = result;
      if (live) setSupport(result);
    });
    return () => {
      live = false;
    };
  }, [support]);

  const webcodecs = forced === "element" ? false : forced === "webcodecs" ? CanvasEngine.available : (support?.supported ?? CanvasEngine.available);
  return useMemo<EngineChoice>(() => {
    if (!webcodecs) return { kind: "element", canDecode: canStreamWithMediaSource };
    return {
      kind: "webcodecs",
      canDecode: (track) => canEngineDecode(track.codecs, support),
    };
  }, [webcodecs, support]);
}

function canStreamWithMediaSource(track: StreamTrack): boolean {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(`${track.mime_type}; codecs="${track.codecs}"`);
}

/** Can the WebCodecs engine decode ``codecs``? Before the probe settles, only H.264 and AAC count. */
export function canEngineDecode(codecs: string, support: EngineSupport | null): boolean {
  if (codecs.startsWith("avc1") || codecs.startsWith("avc3")) return support?.avc ?? true;
  if (codecs.startsWith("hvc1") || codecs.startsWith("hev1")) return support?.hevc ?? false;
  if (codecs.startsWith("av01")) return support?.av1 ?? false;
  if (codecs.startsWith("vp09")) return support?.vp9 ?? false;
  if (codecs.startsWith("mp4a")) return support?.aac ?? true;
  if (codecs === "mp3") return support?.mp3 ?? false;
  if (codecs === "opus") return support?.opus ?? false;
  if (codecs === "flac") return support?.flac ?? false;
  return false;
}

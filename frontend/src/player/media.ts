import { CanvasEngine } from "./engine/CanvasEngine";
import { fileSource } from "./engine/readers";

/**
 * What the player drives: the WebCodecs engine (no media element at all), or a
 * hidden <video> in browsers without WebCodecs. Both expose this much of
 * HTMLMediaElement.
 */
export interface PlaybackMedia extends EventTarget {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly buffered: TimeRanges;
  readonly readyState: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly error: { readonly code: number; readonly message: string } | null;
  volume: number;
  muted: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  play(): Promise<void>;
  pause(): void;
  requestVideoFrameCallback?(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback?(handle: number): void;
}

export type EngineKind = "webcodecs" | "element";

export function hasSource(media: PlaybackMedia): boolean {
  return media instanceof CanvasEngine ? media.hasSource : Boolean((media as HTMLVideoElement).getAttribute("src"));
}

/** Play a same-origin MP4 URL. */
export function loadUrl(media: PlaybackMedia, url: string): void {
  if (media instanceof CanvasEngine) {
    media.open(fileSource(url));
    return;
  }
  const video = media as HTMLVideoElement;
  video.src = url;
  video.load();
}

export function clearSource(media: PlaybackMedia): void {
  if (media instanceof CanvasEngine) {
    media.close();
    return;
  }
  const video = media as HTMLVideoElement;
  if (!video.getAttribute("src")) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/** The picture to draw: the engine's current VideoFrame, or the element itself. */
export function currentImage(media: PlaybackMedia): CanvasImageSource | null {
  return media instanceof CanvasEngine ? media.frame : (media as HTMLVideoElement);
}

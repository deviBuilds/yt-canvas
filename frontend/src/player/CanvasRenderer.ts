import { getEffect, supportsCanvasFilter, type Effect, type EffectId } from "./effects";
import { currentImage, type PlaybackMedia } from "./media";
import { backingSize, type Size } from "./sizing";

/**
 * Draws frames into a 2D canvas: VideoFrames from the WebCodecs engine, or the
 * picture of a hidden video element in browsers without WebCodecs.
 *
 * The media stays the decoder, audio output and clock; this class only copies
 * pixels. With requestVideoFrameCallback (rVFC) it draws exactly
 * once per presented video frame; elsewhere it falls back to
 * requestAnimationFrame while playing and skips frames whose currentTime
 * hasn't changed.
 *
 * Invariants:
 *  - at most one rVFC *or* rAF callback is pending at any time (no duplicate loops);
 *  - paused/seeked/source-change/effect-change states are redrawn explicitly,
 *    because no new frames are presented then;
 *  - dispose() cancels callbacks and removes every listener it added.
 */

export type RenderMode = "video-frame-callback" | "animation-frame";

export interface RendererOptions {
  effect?: EffectId;
  /** Use the requestAnimationFrame fallback even if rVFC exists. */
  forceFallback?: boolean;
  /** Called after each drawn frame with the frame's media time. */
  onFrame?: (mediaTime: number) => void;
  /** Called when drawing fails (e.g. a tainted canvas). */
  onDrawError?: (error: unknown) => void;
  /** Letterbox/clear colour; the canvas is opaque. */
  background?: string;
}

export interface RendererStats {
  mode: RenderMode;
  framesDrawn: number;
  lastMediaTime: number;
  pending: boolean;
  backing: Size;
}

const HAVE_CURRENT_DATA = 2;

export class CanvasRenderer {
  readonly mode: RenderMode;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly filterSupported: boolean;
  private readonly listeners: Array<[string, () => void]>;
  private effect: Effect;
  private frameHandle: number | null = null;
  private rafHandle: number | null = null;
  private disposed = false;
  private framesDrawn = 0;
  private lastMediaTime = -1;
  private display: Size = { width: 0, height: 0 };
  private dpr = 1;
  private scratch: HTMLCanvasElement | null = null;

  constructor(
    private readonly video: PlaybackMedia,
    private readonly canvas: HTMLCanvasElement,
    private readonly options: RendererOptions = {},
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not supported in this browser.");
    this.ctx = ctx;
    this.filterSupported = supportsCanvasFilter(ctx);
    this.mode =
      !options.forceFallback && typeof video.requestVideoFrameCallback === "function"
        ? "video-frame-callback"
        : "animation-frame";
    this.effect = getEffect(options.effect ?? "none");

    this.listeners = [
      ["loadeddata", () => this.drawNow()],
      ["seeked", () => this.drawNow()],
      ["play", () => this.schedule()],
      ["playing", () => this.schedule()],
      ["pause", () => this.drawNow()],
      ["emptied", () => this.reset()],
      // Fired when the intrinsic size changes (new source or adaptive stream).
      ["resize", () => this.applyBacking(true)],
    ];
    for (const [type, listener] of this.listeners) video.addEventListener(type, listener);

    this.clear();
    this.schedule();
  }

  /** Tell the renderer how large the canvas is displayed (CSS pixels). */
  setDisplaySize(display: Size, devicePixelRatio: number): void {
    this.display = display;
    this.dpr = devicePixelRatio;
    this.applyBacking(true);
  }

  setEffect(id: EffectId): void {
    this.effect = getEffect(id);
    this.drawNow();
  }

  /** Redraw the current frame immediately (paused, seeked, resized, effect changed). */
  drawNow(): void {
    if (this.disposed) return;
    if (!this.draw(this.video.currentTime)) this.clear();
  }

  get stats(): RendererStats {
    return {
      mode: this.mode,
      framesDrawn: this.framesDrawn,
      lastMediaTime: this.lastMediaTime,
      pending: this.frameHandle !== null || this.rafHandle !== null,
      backing: { width: this.canvas.width, height: this.canvas.height },
    };
  }

  /** Forget the previous source: cancel callbacks, blank the canvas, re-arm. */
  reset(): void {
    if (this.disposed) return;
    this.cancelPending();
    this.framesDrawn = 0;
    this.lastMediaTime = -1;
    this.clear();
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending();
    for (const [type, listener] of this.listeners) this.video.removeEventListener(type, listener);
    this.scratch = null;
  }

  // -- scheduling ---------------------------------------------------------------

  private schedule(): void {
    if (this.disposed) return;
    if (this.mode === "video-frame-callback" && this.video.requestVideoFrameCallback) {
      if (this.frameHandle === null) this.frameHandle = this.video.requestVideoFrameCallback(this.onVideoFrame);
    } else if (this.rafHandle === null) {
      this.rafHandle = requestAnimationFrame(this.onAnimationFrame);
    }
  }

  private cancelPending(): void {
    if (this.frameHandle !== null) {
      this.video.cancelVideoFrameCallback?.(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private onVideoFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
    this.frameHandle = null;
    if (this.disposed) return;
    this.draw(metadata.mediaTime);
    // rVFC only fires for presented frames, so a pending callback costs nothing while paused.
    this.schedule();
  };

  private onAnimationFrame = (): void => {
    this.rafHandle = null;
    if (this.disposed) return;
    const time = this.video.currentTime;
    if (time !== this.lastMediaTime) this.draw(time);
    // Only loop while playing; pause/seek redraw explicitly.
    if (!this.video.paused && !this.video.ended) this.schedule();
  };

  // -- drawing ------------------------------------------------------------------

  private clear(): void {
    this.ctx.fillStyle = this.options.background ?? "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private applyBacking(redraw: boolean): void {
    if (this.disposed) return;
    const intrinsic = { width: this.video.videoWidth, height: this.video.videoHeight };
    let target: Size;
    if (this.display.width > 0 && this.display.height > 0) target = backingSize(this.display, this.dpr, intrinsic);
    else if (intrinsic.width > 0) target = intrinsic;
    else return;
    if (this.canvas.width === target.width && this.canvas.height === target.height) return;
    // Assigning width/height reallocates and clears the buffer.
    this.canvas.width = target.width;
    this.canvas.height = target.height;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
    if (redraw) this.drawNow();
  }

  private draw(mediaTime: number): boolean {
    const video = this.video;
    if (video.readyState < HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) return false;
    const image = currentImage(video);
    if (!image) return false;
    this.applyBacking(false);
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return false;

    const ctx = this.ctx;
    const effect = this.effect;
    try {
      if (effect.pixelate) {
        this.drawPixelated(image, effect.pixelate, width, height);
      } else if (effect.filter && this.filterSupported) {
        ctx.filter = effect.filter;
        ctx.drawImage(image, 0, 0, width, height);
        ctx.filter = "none";
      } else {
        ctx.drawImage(image, 0, 0, width, height);
        if (effect.transform) {
          const image = ctx.getImageData(0, 0, width, height);
          effect.transform(image.data);
          ctx.putImageData(image, 0, 0);
        }
      }
    } catch (error) {
      this.options.onDrawError?.(error);
      return false;
    }

    this.framesDrawn++;
    this.lastMediaTime = mediaTime;
    this.options.onFrame?.(mediaTime);
    return true;
  }

  private drawPixelated(image: CanvasImageSource, block: number, width: number, height: number): void {
    const w = Math.max(1, Math.round(width / block));
    const h = Math.max(1, Math.round(height / block));
    const scratch = (this.scratch ??= document.createElement("canvas"));
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    const small = scratch.getContext("2d");
    if (!small) throw new Error("Canvas 2D is not supported in this browser.");
    small.drawImage(image, 0, 0, w, h);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(scratch, 0, 0, width, height);
    this.ctx.imageSmoothingEnabled = true;
  }
}

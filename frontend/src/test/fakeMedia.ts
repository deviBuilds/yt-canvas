/**
 * Controllable stand-ins for HTMLMediaElement playback, requestVideoFrameCallback
 * and CanvasRenderingContext2D, which jsdom does not implement.
 */
import { vi } from "vitest";

interface FakeMediaState {
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  error: { code: number } | null;
  frameCallbacks: Map<number, VideoFrameRequestCallback>;
  nextHandle: number;
  playResult: (() => Promise<void>) | null;
}

const states = new WeakMap<HTMLMediaElement, FakeMediaState>();

export function mediaState(el: HTMLMediaElement): FakeMediaState {
  let state = states.get(el);
  if (!state) {
    state = {
      paused: true,
      ended: false,
      seeking: false,
      currentTime: 0,
      duration: NaN,
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      volume: 1,
      muted: false,
      playbackRate: 1,
      defaultPlaybackRate: 1,
      error: null,
      frameCallbacks: new Map(),
      nextHandle: 1,
      playResult: null,
    };
    states.set(el, state);
  }
  return state;
}

const fire = (el: HTMLMediaElement, ...types: string[]) => {
  for (const type of types) el.dispatchEvent(new Event(type));
};

export const mediaSpies = {
  play: vi.fn(),
  pause: vi.fn(),
  load: vi.fn(),
};

export function installFakeMedia(): void {
  const media = HTMLMediaElement.prototype;
  const accessor = <K extends keyof FakeMediaState>(
    target: object,
    name: string,
    key: K,
    onSet?: (el: HTMLMediaElement, value: FakeMediaState[K]) => void,
  ) =>
    Object.defineProperty(target, name, {
      configurable: true,
      get(this: HTMLMediaElement) {
        return mediaState(this)[key];
      },
      set: onSet
        ? function (this: HTMLMediaElement, value: FakeMediaState[K]) {
            onSet(this, value);
          }
        : undefined,
    });

  accessor(media, "paused", "paused");
  accessor(media, "ended", "ended");
  accessor(media, "seeking", "seeking");
  accessor(media, "duration", "duration");
  accessor(media, "readyState", "readyState");
  accessor(media, "error", "error");
  accessor(media, "currentTime", "currentTime", (el, value) => {
    const s = mediaState(el);
    s.currentTime = Number.isFinite(s.duration) ? Math.min(Math.max(0, value), s.duration) : value;
    s.ended = false;
    fire(el, "seeking", "timeupdate", "seeked");
  });
  accessor(media, "volume", "volume", (el, value) => {
    mediaState(el).volume = value;
    fire(el, "volumechange");
  });
  accessor(media, "muted", "muted", (el, value) => {
    mediaState(el).muted = value;
    fire(el, "volumechange");
  });
  accessor(media, "playbackRate", "playbackRate", (el, value) => {
    mediaState(el).playbackRate = value;
    fire(el, "ratechange");
  });
  accessor(media, "defaultPlaybackRate", "defaultPlaybackRate", (el, value) => {
    mediaState(el).defaultPlaybackRate = value;
  });
  Object.defineProperty(media, "buffered", {
    configurable: true,
    get: () => ({ length: 0, start: () => 0, end: () => 0 }),
  });

  media.play = function (this: HTMLMediaElement) {
    mediaSpies.play(this);
    const s = mediaState(this);
    if (s.playResult) return s.playResult();
    s.paused = false;
    s.ended = false;
    fire(this, "play", "playing");
    return Promise.resolve();
  };
  media.pause = function (this: HTMLMediaElement) {
    mediaSpies.pause(this);
    const s = mediaState(this);
    if (!s.paused) {
      s.paused = true;
      fire(this, "pause");
    }
  };
  media.load = function (this: HTMLMediaElement) {
    mediaSpies.load(this);
    const s = mediaState(this);
    Object.assign(s, { paused: true, ended: false, currentTime: 0, duration: NaN, readyState: 0, videoWidth: 0, videoHeight: 0, error: null });
    fire(this, "emptied", "loadstart");
  };

  const video = HTMLVideoElement.prototype;
  accessor(video, "videoWidth", "videoWidth");
  accessor(video, "videoHeight", "videoHeight");
  video.requestVideoFrameCallback = function (this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
    const s = mediaState(this);
    const handle = s.nextHandle++;
    s.frameCallbacks.set(handle, callback);
    return handle;
  };
  video.cancelVideoFrameCallback = function (this: HTMLVideoElement, handle: number) {
    mediaState(this).frameCallbacks.delete(handle);
  };
}

/** Simulate the browser finishing metadata/first-frame loading. */
export function loadMetadata(el: HTMLVideoElement, { duration = 60, width = 1280, height = 720 } = {}): void {
  Object.assign(mediaState(el), { duration, readyState: 4, videoWidth: width, videoHeight: height });
  fire(el, "loadedmetadata", "durationchange", "resize", "loadeddata", "canplay");
}

/** Present one video frame: run (and clear) the pending rVFC callbacks. */
export function presentFrame(el: HTMLVideoElement, mediaTime?: number): number {
  const s = mediaState(el);
  if (mediaTime !== undefined) s.currentTime = mediaTime;
  const callbacks = [...s.frameCallbacks.values()];
  s.frameCallbacks.clear();
  for (const callback of callbacks) {
    callback(performance.now(), {
      mediaTime: s.currentTime,
      presentationTime: 0,
      expectedDisplayTime: 0,
      width: s.videoWidth,
      height: s.videoHeight,
      presentedFrames: 0,
    } as VideoFrameCallbackMetadata);
  }
  return callbacks.length;
}

export function pendingFrameCallbacks(el: HTMLVideoElement): number {
  return mediaState(el).frameCallbacks.size;
}

export function failMedia(el: HTMLVideoElement, code: number): void {
  mediaState(el).error = { code };
  fire(el, "error");
}

// -- canvas ------------------------------------------------------------------------------

export interface FakeContext {
  filter: string | undefined;
  fillStyle: string;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  draws: Array<{ source: unknown; filter: string | undefined; args: number[] }>;
  drawImage: (source: unknown, ...args: number[]) => void;
  fillRect: ReturnType<typeof vi.fn>;
  getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray; width: number; height: number };
  putImageData: ReturnType<typeof vi.fn>;
  /** Colour that drawImage(video) "paints" into the fake pixel buffer. */
  paint: [number, number, number];
}

const contexts = new WeakMap<HTMLCanvasElement, FakeContext>();

export function installFakeCanvas({ filterSupport = true } = {}): void {
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    let ctx = contexts.get(this);
    if (!ctx) {
      const created: FakeContext = {
        filter: filterSupport ? "none" : undefined,
        fillStyle: "#000",
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "low",
        draws: [],
        paint: [255, 0, 0],
        drawImage(source, ...args) {
          created.draws.push({ source, filter: created.filter, args });
        },
        fillRect: vi.fn(),
        getImageData: (_x, _y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) {
            data.set([...created.paint, 255], i);
          }
          return { data, width: w, height: h };
        },
        putImageData: vi.fn(),
      };
      ctx = created;
      contexts.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

export function fakeContext(canvas: HTMLCanvasElement): FakeContext {
  canvas.getContext("2d");
  return contexts.get(canvas)!;
}

/** Number of frames drawn from a <video> (ignores scratch-canvas draws). */
export function videoDraws(canvas: HTMLCanvasElement): number {
  return fakeContext(canvas).draws.filter((d) => d.source instanceof HTMLVideoElement).length;
}

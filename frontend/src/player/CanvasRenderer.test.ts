import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeContext,
  installFakeCanvas,
  installFakeMedia,
  loadMetadata,
  mediaState,
  pendingFrameCallbacks,
  presentFrame,
  videoDraws,
} from "../test/fakeMedia";
import { CanvasRenderer } from "./CanvasRenderer";

function setup(options: ConstructorParameters<typeof CanvasRenderer>[2] = {}) {
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  video.setAttribute("src", "/api/media/x");
  const renderer = new CanvasRenderer(video, canvas, options);
  return { video, canvas, renderer };
}

describe("CanvasRenderer with requestVideoFrameCallback", () => {
  beforeEach(() => {
    installFakeMedia();
    installFakeCanvas();
  });

  it("keeps exactly one frame callback pending and draws once per presented frame", () => {
    const { video, canvas, renderer } = setup();
    expect(renderer.mode).toBe("video-frame-callback");
    expect(pendingFrameCallbacks(video)).toBe(1);

    loadMetadata(video, { width: 640, height: 360 });
    const afterLoad = videoDraws(canvas); // loadeddata redraws the first frame
    // Repeated play/playing events must not start extra loops.
    for (let i = 0; i < 5; i++) {
      video.dispatchEvent(new Event("play"));
      video.dispatchEvent(new Event("playing"));
    }
    expect(pendingFrameCallbacks(video)).toBe(1);

    expect(presentFrame(video, 0.5)).toBe(1);
    expect(presentFrame(video, 0.533)).toBe(1);
    expect(videoDraws(canvas)).toBe(afterLoad + 2);
    expect(renderer.stats.lastMediaTime).toBeCloseTo(0.533);
    // The count lives in stats, not in the DOM: nothing is written to the canvas element per frame.
    expect(canvas.hasAttribute("data-frames")).toBe(false);
    expect(pendingFrameCallbacks(video)).toBe(1);
  });

  it("redraws on seek and pause, when no new frames are presented", () => {
    const { video, canvas } = setup();
    loadMetadata(video);
    const before = videoDraws(canvas);
    video.currentTime = 12; // fires seeked
    video.dispatchEvent(new Event("pause"));
    expect(videoDraws(canvas)).toBe(before + 2);
  });

  it("does not draw before the video has a current frame", () => {
    const { video, canvas } = setup();
    presentFrame(video, 0);
    expect(videoDraws(canvas)).toBe(0);
    expect(fakeContext(canvas).fillRect).toHaveBeenCalled(); // cleared to the background instead
  });

  it("applies effects through ctx.filter and redraws immediately when changed", () => {
    const { video, canvas, renderer } = setup();
    loadMetadata(video);
    renderer.setEffect("grayscale");
    const draws = fakeContext(canvas).draws;
    expect(draws.at(-1)?.filter).toBe("grayscale(1)");
    expect(fakeContext(canvas).filter).toBe("none"); // restored after drawing
    renderer.setEffect("none");
    expect(draws.at(-1)?.filter).toBe("none");
  });

  it("falls back to a per-pixel transform without ctx.filter support", () => {
    installFakeCanvas({ filterSupport: false });
    const { video, canvas, renderer } = setup();
    loadMetadata(video);
    renderer.setEffect("grayscale");
    const ctx = fakeContext(canvas);
    expect(ctx.putImageData).toHaveBeenCalled();
    const image = ctx.putImageData.mock.calls.at(-1)![0] as { data: Uint8ClampedArray };
    const [r, g, b] = image.data;
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBe(Math.round(0.2126 * 255));
  });

  it("pixelates via a scratch canvas without smoothing", () => {
    const { video, canvas, renderer } = setup();
    loadMetadata(video, { width: 640, height: 360 });
    renderer.setDisplaySize({ width: 640, height: 360 }, 1);
    renderer.setEffect("pixelate");
    const last = fakeContext(canvas).draws.at(-1)!;
    expect(last.source).toBeInstanceOf(HTMLCanvasElement);
    expect(last.args).toEqual([0, 0, 640, 360]);
  });

  it("resets on a source change and re-arms a single callback", () => {
    const { video, renderer } = setup();
    loadMetadata(video);
    presentFrame(video, 1);
    expect(renderer.stats.framesDrawn).toBeGreaterThan(0);
    video.load(); // fires emptied
    expect(renderer.stats.framesDrawn).toBe(0);
    expect(pendingFrameCallbacks(video)).toBe(1);
  });

  it("dispose cancels the pending callback and stops listening", () => {
    const { video, canvas, renderer } = setup();
    loadMetadata(video);
    renderer.dispose();
    expect(pendingFrameCallbacks(video)).toBe(0);
    const draws = videoDraws(canvas);
    video.currentTime = 3;
    video.dispatchEvent(new Event("play"));
    expect(videoDraws(canvas)).toBe(draws);
    expect(pendingFrameCallbacks(video)).toBe(0);
  });

  it("sizes the backing buffer to device pixels, capped at the video's resolution", () => {
    const { video, canvas, renderer } = setup();
    loadMetadata(video, { width: 1280, height: 720 });
    renderer.setDisplaySize({ width: 320, height: 180 }, 2);
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
    renderer.setDisplaySize({ width: 1920, height: 1080 }, 2);
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
  });

  it("updates the backing buffer when the source's intrinsic size changes", () => {
    const { video, canvas, renderer } = setup();
    renderer.setDisplaySize({ width: 360, height: 640 }, 1);
    loadMetadata(video, { width: 360, height: 640 });
    expect([canvas.width, canvas.height]).toEqual([360, 640]);
  });
});

describe("CanvasRenderer requestAnimationFrame fallback", () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    installFakeMedia();
    installFakeCanvas();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tick = () => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(performance.now());
  };

  it("loops only while playing and skips unchanged frames", async () => {
    const { video, canvas, renderer } = setup({ forceFallback: true });
    expect(renderer.mode).toBe("animation-frame");
    loadMetadata(video);
    await video.play();
    expect(frames.length).toBe(1); // a single loop despite play + playing

    mediaState(video).currentTime = 1;
    tick();
    const drawn = videoDraws(canvas);
    tick(); // same currentTime: nothing new to draw
    expect(videoDraws(canvas)).toBe(drawn);
    mediaState(video).currentTime = 1.04;
    tick();
    expect(videoDraws(canvas)).toBe(drawn + 1);

    video.pause();
    tick();
    expect(frames.length).toBe(0); // loop stopped
  });
});

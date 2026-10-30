import type { StreamSession } from "@/api/types";
import { CanvasRenderer } from "@/player/CanvasRenderer";
import { CanvasEngine } from "@/player/engine/CanvasEngine";
import { dashSource } from "@/player/engine/readers";
import { streamsApi } from "@/player/streaming/api";

/**
 * Plays the 1080p60 H.264 demo clip through the real player (WebCodecs engine and canvas
 * renderer), muted, and measures how many frames it shows per second and how many it drops.
 *
 * The whole clip is buffered before the timed run, so a slow connection shows up in the
 * speed test rather than here.
 */

export const BENCH_SAMPLE = { source: "demo", id: "bench1080" } as const;

const BUFFER_TIMEOUT_MS = 45_000;
const SKIP_SECONDS = 0.5; // ignore the start-up
const MEASURE_SECONDS = 10;
const RUN_TIMEOUT_MS = 20_000;

export interface BenchmarkResult {
  clip: string;
  targetFps: number;
  /** From the tap to the first decoded frame on the canvas. */
  firstFrameMs: number;
  /** Until the whole clip was loaded (null: gave up and measured anyway). */
  bufferedMs: number | null;
  seconds: number;
  /** Frames the engine showed per second during the timed run. */
  fps: number;
  frames: number;
  dropped: number;
  /** Frames the renderer drew to the canvas. */
  drawn: number;
  /** Times playback stalled waiting for data. */
  waiting: number;
  /** Media seconds played per wall-clock second (1 = real time). */
  speed: number;
  /** The page's own animation frame rate during the run, and its longest gap. */
  animationFps: number;
  longestGapMs: number;
  audio: { sampleRate: number; baseLatency: number | null; outputLatency: number | null } | null;
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function once(target: EventTarget, type: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => done(false), timeoutMs);
    const handler = () => done(true);
    function done(ok: boolean) {
      window.clearTimeout(timer);
      target.removeEventListener(type, handler);
      resolve(ok);
    }
    target.addEventListener(type, handler);
  });
}

function bufferedToEnd(engine: CanvasEngine): boolean {
  const { buffered, duration } = engine;
  return buffered.length > 0 && Number.isFinite(duration) && buffered.end(buffered.length - 1) >= duration - 0.1;
}

/** Make the stream session ahead of time, so the run can start inside the tap. */
export function prepareBenchmark(signal?: AbortSignal): Promise<StreamSession> {
  return streamsApi.create(BENCH_SAMPLE, signal);
}

/**
 * Call from a tap or click handler: the first play() must happen while the gesture counts,
 * or the browser keeps the audio clock (and so playback) suspended.
 */
export function runBenchmark(canvas: HTMLCanvasElement, session: StreamSession): Promise<BenchmarkResult> {
  const video = session.video_tracks[0];
  const audio = session.audio_tracks[0];
  if (!video || !audio) return Promise.reject(new Error("The benchmark clip has no tracks."));

  const engine = new CanvasEngine();
  engine.muted = true;
  const renderer = new CanvasRenderer(engine, canvas);
  const start = performance.now();
  engine.open(dashSource(session, video, audio));
  const firstPlay = engine.play(); // synchronously inside the gesture

  const measure = async (): Promise<BenchmarkResult> => {
    const firstFrame = once(engine, "loadeddata", BUFFER_TIMEOUT_MS);
    await firstPlay;
    engine.pause();
    if (!(await firstFrame)) throw new Error(engine.error?.message ?? "The benchmark clip didn't start.");
    const firstFrameMs = performance.now() - start;

    let bufferedMs: number | null = null;
    while (performance.now() - start < BUFFER_TIMEOUT_MS) {
      if (engine.error) throw new Error(engine.error.message);
      if (bufferedToEnd(engine)) {
        bufferedMs = performance.now() - start;
        break;
      }
      await sleep(200);
    }

    const seeked = once(engine, "seeked", 5000);
    engine.currentTime = 0;
    await seeked;
    let waiting = 0;
    const onWaiting = () => waiting++;
    engine.addEventListener("waiting", onWaiting);

    let animationFrames = 0;
    let longestGap = 0;
    let lastFrame = performance.now();
    let animating = true;
    const tick = (now: number) => {
      animationFrames++;
      longestGap = Math.max(longestGap, now - lastFrame);
      lastFrame = now;
      if (animating) requestAnimationFrame(tick);
    };

    await engine.play();
    const runStart = performance.now();
    while (engine.currentTime < SKIP_SECONDS && performance.now() - runStart < RUN_TIMEOUT_MS) await sleep(20);

    const from = { at: performance.now(), media: engine.currentTime, ...engine.diagnostics, drawn: renderer.stats.framesDrawn };
    waiting = 0;
    lastFrame = from.at;
    requestAnimationFrame(tick);
    while (
      engine.currentTime < from.media + MEASURE_SECONDS &&
      !engine.ended &&
      performance.now() - runStart < RUN_TIMEOUT_MS
    ) {
      if (engine.error) throw new Error(engine.error.message);
      await sleep(50);
    }
    animating = false;
    const to = { at: performance.now(), media: engine.currentTime, ...engine.diagnostics, drawn: renderer.stats.framesDrawn };
    engine.removeEventListener("waiting", onWaiting);

    const seconds = (to.at - from.at) / 1000;
    return {
      clip: `${video.width}x${video.height} ${video.fps} fps ${video.codecs}`,
      targetFps: video.fps ?? 60,
      firstFrameMs: Math.round(firstFrameMs),
      bufferedMs: bufferedMs === null ? null : Math.round(bufferedMs),
      seconds: round(seconds, 2),
      fps: round((to.framesPresented - from.framesPresented) / seconds),
      frames: to.framesPresented - from.framesPresented,
      dropped: to.framesDropped - from.framesDropped,
      drawn: to.drawn - from.drawn,
      waiting,
      speed: round((to.media - from.media) / seconds, 2),
      animationFps: round(animationFrames / seconds),
      longestGapMs: Math.round(longestGap),
      audio: to.audioOutput,
    };
  };

  return measure().finally(() => {
    renderer.dispose();
    engine.dispose();
  });
}

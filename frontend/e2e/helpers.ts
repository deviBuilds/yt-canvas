import { expect, type Page } from "@playwright/test";

export interface DemoLayout {
  id: string;
  width: number;
  height: number;
  duration: number;
  time_bar_height: number;
  swatch_size: number;
  swatches: Record<"red" | "green" | "blue", [number, number]>;
}

export interface CanvasSample {
  time: number;
  duration: number;
  paused: boolean;
  frames: number;
  mode: string;
  width: number;
  height: number;
  /** Fraction of the time bar that is white, i.e. the drawn frame's T / duration. */
  bar: number;
  red: [number, number, number];
  green: [number, number, number];
  /** Checksum over the animated middle band of the frame. */
  hash: number;
}

export async function demoLayout(page: Page, id: string): Promise<DemoLayout> {
  const response = await page.request.get(`/api/demo/${id}/layout`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as DemoLayout;
}

/** Read pixels back from the player's canvas (getImageData) and decode the demo layout. */
export async function sampleCanvas(page: Page, layout: DemoLayout): Promise<CanvasSample> {
  return page.evaluate((layout) => {
    const canvas = document.querySelector<
      HTMLCanvasElement & { ytcMedia?: HTMLMediaElement; ytcRenderer?: { stats: { framesDrawn: number; mode: string } } }
    >('[data-testid="video-canvas"]');
    const video = canvas?.ytcMedia;
    if (!canvas || !video) throw new Error("player not found");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    const sx = canvas.width / layout.width;
    const sy = canvas.height / layout.height;

    const barY = Math.floor((layout.time_bar_height / 2) * sy);
    const row = ctx.getImageData(0, barY, canvas.width, 1).data;
    let white = 0;
    for (let x = 0; x < canvas.width; x++) {
      const i = x * 4;
      if ((row[i]! + row[i + 1]! + row[i + 2]!) / 3 > 128) white++;
    }

    const swatch = (name: "red" | "green") => {
      const [x, y] = layout.swatches[name];
      const half = layout.swatch_size / 2;
      const cx = Math.floor((x + half) * sx);
      const cy = Math.floor((y + half) * sy);
      const px = ctx.getImageData(cx - 2, cy - 2, 5, 5).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < px.length; i += 4) {
        sum[0]! += px[i]!;
        sum[1]! += px[i + 1]!;
        sum[2]! += px[i + 2]!;
      }
      const n = px.length / 4;
      return [Math.round(sum[0]! / n), Math.round(sum[1]! / n), Math.round(sum[2]! / n)] as [number, number, number];
    };

    const top = Math.floor(canvas.height * 0.3);
    const band = ctx.getImageData(0, top, canvas.width, Math.max(1, Math.floor(canvas.height * 0.3))).data;
    let hash = 0;
    for (let i = 0; i < band.length; i += 12) hash = (Math.imul(hash, 31) + band[i]! + band[i + 1]! * 7) >>> 0;

    return {
      time: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      frames: canvas.ytcRenderer?.stats.framesDrawn ?? 0,
      mode: canvas.ytcRenderer?.stats.mode ?? "",
      width: canvas.width,
      height: canvas.height,
      bar: white / canvas.width,
      red: swatch("red"),
      green: swatch("green"),
      hash,
    };
  }, layout);
}

export async function framesDrawn(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.querySelector<HTMLCanvasElement & { ytcRenderer?: { stats: { framesDrawn: number } } }>('[data-testid="video-canvas"]')
        ?.ytcRenderer?.stats.framesDrawn ?? 0,
  );
}

/** The playing source: the engine's source id, or the fallback element's src attribute. */
export async function currentSrc(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const media = document.querySelector<HTMLCanvasElement & { ytcMedia?: EventTarget & { src: string } }>('[data-testid="video-canvas"]')?.ytcMedia;
    if (!media) return null;
    return (media instanceof HTMLMediaElement ? media.getAttribute("src") : media.src) || null;
  });
}

/** "webcodecs" (no media element) or "element" (the hidden-video fallback). */
export async function engineKind(page: Page): Promise<"webcodecs" | "element" | null> {
  return page.evaluate(() => {
    const media = document.querySelector<HTMLCanvasElement & { ytcMedia?: object }>('[data-testid="video-canvas"]')?.ytcMedia;
    if (!media) return null;
    return media instanceof HTMLMediaElement ? "element" : "webcodecs";
  });
}

/** Move focus off any control so key presses reach the document-level shortcuts. */
export async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/**
 * Wait until playback renders frames, clicking "Click to play" if the autoplay
 * policy requires a gesture. Pass ``previousSrc`` after a source change so the
 * old video's frames don't count.
 */
export async function startPlayback(page: Page, previousSrc?: string | null): Promise<void> {
  if (previousSrc !== undefined) {
    await expect.poll(() => currentSrc(page), { timeout: 60_000 }).not.toBe(previousSrc);
    await expect.poll(async () => (await currentSrc(page)) !== null, { timeout: 60_000 }).toBe(true);
  }
  const bigPlay = page.getByRole("button", { name: "Play video" });
  await expect
    .poll(async () => (await bigPlay.isVisible()) || (await framesDrawn(page)) > 3, { timeout: 60_000 })
    .toBe(true);
  if (await bigPlay.isVisible()) await bigPlay.click();
  await expect.poll(() => framesDrawn(page), { timeout: 30_000 }).toBeGreaterThan(3);
}

export async function openDemo(page: Page, id: string, query = ""): Promise<DemoLayout> {
  const layout = await demoLayout(page, id);
  await page.goto(`/watch?demo=${id}${query}`);
  await startPlayback(page);
  return layout;
}

export async function videoState(page: Page) {
  return page.evaluate(() => {
    const v = document.querySelector<HTMLCanvasElement & { ytcMedia: HTMLMediaElement }>('[data-testid="video-canvas"]')!.ytcMedia;
    return { time: v.currentTime, paused: v.paused, seeking: v.seeking, muted: v.muted, volume: v.volume, rate: v.playbackRate };
  });
}

export const isGray = ([r, g, b]: [number, number, number], tolerance = 8) =>
  Math.abs(r - g) <= tolerance && Math.abs(g - b) <= tolerance && Math.abs(r - b) <= tolerance;

import { expect, test } from "@playwright/test";

import { currentSrc, demoLayout, engineKind, sampleCanvas, startPlayback, videoState } from "./helpers";

// Direct play: a Matroska or WebM file read in byte ranges by the MKV reader and decoded
// with WebCodecs, nothing prepared first. The path the Plex app uses for decodable files.

for (const [id, label] of [["bars", "H.264 + AAC in Matroska"], ["sweep", "VP9 + Opus in WebM"]] as const) {
  test(`plays ${label} directly, and seeks`, async ({ page }) => {
    const layout = await demoLayout(page, id);
    const ranges: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/demo/${id}/source`)) ranges.push(request.headers()["range"] ?? "none");
    });
    await page.goto(`/play?demo=${id}`);
    await startPlayback(page);
    expect(await engineKind(page)).toBe("webcodecs");
    expect(await currentSrc(page)).toBe(`/api/demo/${id}/source`);
    await expect(page.locator("video, audio")).toHaveCount(0);
    // Every read is a byte range; nothing went through preparation.
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((range) => /^bytes=\d+-\d+$/.test(range))).toBe(true);

    // Frames advance, and the drawn frame's time bar follows the clock.
    await expect.poll(async () => (await sampleCanvas(page, layout)).time, { timeout: 20_000 }).toBeGreaterThan(1);
    const playing = await sampleCanvas(page, layout);
    expect(Math.abs(playing.bar - playing.time / layout.duration)).toBeLessThan(0.1);
    expect(playing.red[0]).toBeGreaterThan(180);

    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement & { ytcMedia?: { currentTime: number } }>('[data-testid="video-canvas"]');
      canvas!.ytcMedia!.currentTime = 9;
    });
    await expect.poll(async () => (await sampleCanvas(page, layout)).time, { timeout: 20_000 }).toBeGreaterThan(9);
    const after = await sampleCanvas(page, layout);
    expect(Math.abs(after.bar - after.time / layout.duration)).toBeLessThan(0.1);
    expect((await videoState(page)).paused).toBe(false);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

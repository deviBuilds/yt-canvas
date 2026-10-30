import { expect, test } from "@playwright/test";

// The /check page: capability probes, the 1080p60 benchmark through the canvas player,
// the speed test, the drive-lock probe, and a report this computer can read back.

interface StoredReport {
  id: string;
  report: {
    browser: { chromium: string | null; tesla: string | null };
    video: Array<{ name: string; supported: boolean }>;
    benchmark: { fps: number; frames: number; dropped: number; targetFps: number; bufferedMs: number | null } | null;
    speed: { mbps: number; complete: boolean } | null;
    driveLock: { browserPauses: number; events: Array<{ event: string }> } | null;
  };
}

test("the browser check measures this browser and sends a report", async ({ page, request }) => {
  await page.goto("/check");
  await expect(page.getByRole("heading", { name: "Browser check" })).toBeVisible();
  await expect(page.getByRole("region", { name: "This browser" })).toContainText("not a Tesla");
  await expect(page.getByRole("region", { name: "Video decoding (1080p)" })).toContainText("H.264 High");

  const bench = page.getByRole("region", { name: "Playback benchmark" });
  const run = bench.getByRole("button", { name: /^Run/ });
  await expect(run).toBeEnabled({ timeout: 60_000 }); // the clip is generated on first use
  await run.click();
  await expect(bench).toContainText("Frames per second", { timeout: 60_000 });

  const speed = page.getByRole("region", { name: "Connection to this server" });
  await speed.getByRole("button", { name: "Test speed" }).click();
  await expect(speed).toContainText("Mbit/s");

  const probe = page.getByRole("region", { name: "Drive lock probe (optional, in the car)" });
  await probe.getByRole("button", { name: "Start" }).click();
  await expect(probe).toContainText("playing");
  await page.waitForTimeout(1500);
  await probe.getByRole("button", { name: "Stop" }).click();
  await expect(probe).toContainText("Paused by the browser");

  const send = page.getByRole("region", { name: "Send the report" });
  await send.getByRole("button", { name: "Send" }).click();
  await expect(send).toContainText("Sent. Report");
  const id = await send.locator("strong").textContent();

  const { reports } = (await (await request.get("/api/diagnostics/browser")).json()) as { reports: StoredReport[] };
  const mine = reports.find((entry) => entry.id === id)?.report;
  expect(mine).toBeTruthy();
  expect(mine!.browser.chromium).toMatch(/^\d+\./);
  expect(mine!.video.find((codec) => codec.name === "h264")?.supported).toBe(true);
  expect(mine!.benchmark!.targetFps).toBe(60);
  expect(mine!.benchmark!.bufferedMs).not.toBeNull();
  expect(mine!.benchmark!.frames).toBeGreaterThan(100);
  expect(mine!.benchmark!.fps).toBeGreaterThan(20);
  expect(mine!.speed!.mbps).toBeGreaterThan(1);
  expect(mine!.driveLock!.browserPauses).toBe(0);
  expect(mine!.driveLock!.events.map((event) => event.event)).toContain("playing");
});

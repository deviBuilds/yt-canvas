import { expect, test, devices } from "@playwright/test";

import { startPlayback } from "./helpers";

const SHOTS = "test-results/screens";

async function noHorizontalScroll(page: import("@playwright/test").Page) {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(width + 1);
}

test.describe("desktop layout", () => {
  test("home and watch pages", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Topic shortcuts" })).toBeVisible();
    await expect(page.getByText("This is not a personalized feed")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Demo & test media" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/desktop-home.png`, fullPage: true });
    await noHorizontalScroll(page);

    await page.goto("/watch?demo=bars");
    await startPlayback(page);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SHOTS}/desktop-watch.png` });
    await noHorizontalScroll(page);
  });
});

test.describe("mobile layout", () => {
  const pixel = devices["Pixel 7"];
  test.use({ viewport: pixel.viewport, userAgent: pixel.userAgent, deviceScaleFactor: pixel.deviceScaleFactor, isMobile: true, hasTouch: true });

  test("home, watch and library pages fit a phone", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("search")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/mobile-home.png`, fullPage: true });
    await noHorizontalScroll(page);

    await page.goto("/watch?demo=vertical");
    await startPlayback(page);
    await page.waitForTimeout(800);
    const canvas = await page.getByTestId("video-canvas").boundingBox();
    const viewport = page.viewportSize()!;
    expect(canvas!.width).toBeLessThanOrEqual(viewport.width);
    // Backing buffer follows devicePixelRatio but never exceeds the video's 360×640.
    const backing = await page.getByTestId("video-canvas").evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
    expect(backing[0]).toBeLessThanOrEqual(360);
    expect(backing[1]! / backing[0]!).toBeCloseTo(16 / 9, 1);
    await page.screenshot({ path: `${SHOTS}/mobile-watch.png`, fullPage: true });
    await noHorizontalScroll(page);

    await page.goto("/library");
    await page.screenshot({ path: `${SHOTS}/mobile-library.png`, fullPage: true });
    await noHorizontalScroll(page);
  });
});

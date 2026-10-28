import { expect, test } from "@playwright/test";

import { framesDrawn } from "./helpers";

// Opt-in: E2E_LIVE=1 npm run e2e -- live-youtube
// This contacts YouTube for real. It reports exactly how far the pipeline got;
// it does not fall back to fixtures, so a refused download fails the test.
test.skip(process.env.E2E_LIVE !== "1", "set E2E_LIVE=1 to run against real YouTube");

test("search, open and play a public YouTube video through the canvas", async ({ page }, testInfo) => {
  test.setTimeout(15 * 60_000);
  const query = process.env.E2E_LIVE_QUERY ?? "Big Buck Bunny Blender";

  await page.goto("/");
  await page.getByRole("searchbox").fill(query);
  await page.getByRole("searchbox").press("Enter");
  await expect(page).toHaveURL(/\/search\?q=/);
  const cards = page.locator("article.card:not(.unavailable)");
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  const count = await cards.count();
  console.log(`live search "${query}": ${count} playable cards`);
  expect(count).toBeGreaterThan(0);

  const title = (await cards.first().locator(".card-title").textContent())?.trim();
  await cards.first().locator("a.card-link").click();
  await expect(page).toHaveURL(/\/watch\?v=/);

  const error = page.getByTestId("preparation-error");
  const states = new Set<string>();
  await expect
    .poll(
      async () => {
        const state = await page.getByTestId("preparation").getAttribute("data-state", { timeout: 500 }).catch(() => null);
        if (state) states.add(state);
        return (await error.isVisible()) || (await framesDrawn(page)) > 3 || (await page.getByRole("button", { name: "Play video" }).isVisible());
      },
      { timeout: 14 * 60_000, intervals: [500] },
    )
    .toBe(true);

  const outcome = {
    title,
    states: [...states],
    error: (await error.isVisible()) ? { code: await error.getAttribute("data-code"), text: await error.innerText() } : null,
  };
  await testInfo.attach("live-outcome.json", { body: JSON.stringify(outcome, null, 2), contentType: "application/json" });
  console.log(`live outcome: ${JSON.stringify(outcome)}`);
  expect(outcome.error, `preparation failed: ${outcome.error?.text}`).toBeNull();

  if (await page.getByRole("button", { name: "Play video" }).isVisible()) {
    await page.getByRole("button", { name: "Play video" }).click();
  }
  const before = await framesDrawn(page);
  await page.waitForTimeout(2000);
  expect(await framesDrawn(page)).toBeGreaterThan(before);
});

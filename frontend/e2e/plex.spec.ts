import { expect, test } from "@playwright/test";

import { engineKind, framesDrawn, startPlayback } from "./helpers";

// The Plex app end to end, against backend/tests/fakeplex.py: connect through the approval
// page, browse, play a file directly, play one through the transcoder (DTS audio), report
// progress, disconnect.

const fakePlex = `http://127.0.0.1:${Number(process.env.E2E_FAKE_PLEX_PORT ?? Number(process.env.E2E_PORT ?? 8790) + 7)}`;

test("connect, browse and play from Plex", async ({ page }) => {
  expect((await page.request.put("/api/apps/plex", { data: { enabled: true } })).ok()).toBe(true);
  await page.goto("/apps/plex");

  // Connect: Plex's approval page opens in a new tab; approving it connects this page.
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Plex" }).click();
  const approval = await popup;
  await expect(approval.getByRole("heading", { name: "yt-canvas is approved" })).toBeVisible();
  expect(new URL(approval.url()).hash).toContain("code=fakecode");
  await approval.close();
  await expect(page.getByText("Fake Server")).toBeVisible({ timeout: 15_000 });

  // Browse: home rows with posters, a library grid, search.
  const recent = page.getByRole("region", { name: "Recently added in Movies" });
  await expect(recent.getByRole("link", { name: /Direct Movie/ })).toBeVisible();
  await expect(recent.locator("img").first()).toHaveJSProperty("complete", true);
  await page.getByRole("link", { name: "Movies", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Movies" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search your Plex libraries" }).fill("transcoded");
  await page.getByRole("button", { name: "Search Plex" }).click();
  await expect(page.getByRole("link", { name: /Transcoded Movie/ })).toBeVisible();

  // Direct play: H.264 + AAC in Matroska, read in byte ranges.
  await page.goto("/apps/plex/item/101");
  await expect(page.getByText("MKV · H.264 SD · AAC 2 ch")).toBeVisible();
  // The poster keeps its 2:3 shape, whatever the image's own and whatever the text beside it.
  const poster = await page.getByTestId("plex-poster").boundingBox();
  expect(poster && poster.height / poster.width).toBeCloseTo(1.5, 2);
  await page.getByRole("link", { name: "Play" }).click();
  await startPlayback(page);
  expect(await engineKind(page)).toBe("webcodecs");
  await expect(page.locator("video, audio")).toHaveCount(0);
  await expect(page.getByTestId("plex-playback")).toContainText("Direct play: Plays the original file.");
  expect((await (await page.request.get(`${fakePlex}/test/state`)).json()).bytes).toBeGreaterThan(0);

  // Through Plex: DTS audio isn't decodable, so the transcoder's DASH is played.
  await page.goto("/apps/plex/item/102");
  await page.getByRole("link", { name: "Play" }).click();
  await startPlayback(page);
  await expect(page.getByTestId("plex-playback")).toContainText("can't decode DTS audio, so Plex converts the audio");
  await expect.poll(() => framesDrawn(page), { timeout: 20_000 }).toBeGreaterThan(20);

  // Progress went back to Plex (on pause at the end of the 2 s clip, or on leaving).
  await page.goto("/apps/plex");
  await expect
    .poll(async () => ((await (await page.request.get(`${fakePlex}/test/state`)).json()).timeline as Array<{ ratingKey: string }>).some((t) => t.ratingKey === "102"))
    .toBe(true);

  // Disconnect.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("heading", { name: "Connect your Plex account" })).toBeVisible();
});

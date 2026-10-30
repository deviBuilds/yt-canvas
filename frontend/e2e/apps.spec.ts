import { expect, test } from "@playwright/test";

// Add-on apps: off until turned on in Apps, their code loaded only then, and the
// sidebar following the choice without a restart.

test("an app stays off and unloaded until turned on, then shows up in the sidebar", async ({ page }) => {
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/assets/")) chunks.push(new URL(request.url()).pathname);
  });
  const sidebar = page.getByRole("navigation", { name: "Main" });

  await page.goto("/apps");
  await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Plex app" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(sidebar.getByRole("link", { name: "Plex" })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Add apps" })).toBeVisible();
  expect(await (await page.request.get("/api/apps/plex/status")).json()).toMatchObject({ error: { code: "app_disabled" } });

  await page.goto("/apps/plex");
  await expect(page.getByRole("heading", { name: "The Plex app is off" })).toBeVisible();
  expect(chunks.filter((chunk) => /PlexApp/.test(chunk))).toEqual([]);

  await page.goto("/apps");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(sidebar.getByRole("link", { name: "Plex" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Manage apps" })).toBeVisible();

  await sidebar.getByRole("link", { name: "Plex" }).click();
  await expect(page).toHaveURL(/\/apps\/plex$/);
  await expect(page.getByRole("heading", { name: "Connect your Plex account" })).toBeVisible();
  expect(chunks.some((chunk) => /PlexApp/.test(chunk))).toBe(true);

  // The choice is kept by the server.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect your Plex account" })).toBeVisible();

  await page.goto("/apps");
  await page.getByRole("switch", { name: "Plex app" }).click();
  await expect(page.getByRole("switch", { name: "Plex app" })).toHaveAttribute("aria-checked", "false");
  await expect(sidebar.getByRole("link", { name: "Plex" })).toHaveCount(0);
  await page.goto("/apps/plex");
  await expect(page.getByRole("heading", { name: "The Plex app is off" })).toBeVisible();
});

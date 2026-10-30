import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

// The e2e suite runs the *production* build served by the FastAPI backend, i.e.
// one origin for pages, API and media, exactly like a deployment. Each run gets
// an empty media cache, and demo generation is capped at 4× real time, so
// preparation states stay observable even on machines that finish in a blink.
const port = Number(process.env.E2E_PORT ?? 8790);
const backendDir = path.resolve(import.meta.dirname, "../backend");
const python = process.env.YTC_PYTHON ?? path.join(backendDir, ".venv/bin/python");
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "ytc-e2e-"));
// A fake plex.tv and Plex Media Server (backend/tests/fakeplex.py) for the Plex app's tests.
const fakePlexPort = Number(process.env.E2E_FAKE_PLEX_PORT ?? port + 7);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [{
    command: `"${python}" -m uvicorn tests.fakeplex:app --host 127.0.0.1 --port ${fakePlexPort}`,
    cwd: backendDir,
    url: `http://127.0.0.1:${fakePlexPort}/identity`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { FAKE_PLEX_PORT: String(fakePlexPort), YTC_IGNORE_DOTENV: "1" },
  }, {
    command: `"${python}" -m uvicorn app.main:app --host 127.0.0.1 --port ${port}`,
    cwd: backendDir,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      YTC_DATA_DIR: dataDir,
      // Which add-on apps are on: a fresh, empty choice per run, never ~/.config/yt-canvas.
      YTC_CONFIG_DIR: path.join(dataDir, "config"),
      YTC_FRONTEND_DIST: path.resolve(import.meta.dirname, "dist"),
      YTC_MIN_FREE_DISK_MB: "0",
      YTC_DEMO_READRATE: "4",
      // Keep the suite off YouTube: no Music/News/... shelves or related videos.
      YTC_ENABLE_FEEDS: "false",
      // Ignore the developer's .env, which may turn on YouTube sign-in (real browser cookies).
      YTC_IGNORE_DOTENV: "1",
      YTC_LOG_LEVEL: "WARNING",
      YTC_PLEX_TV_URL: `http://127.0.0.1:${fakePlexPort}`,
      YTC_PLEX_AUTH_URL: `http://127.0.0.1:${fakePlexPort}/auth`,
    },
  }],
});

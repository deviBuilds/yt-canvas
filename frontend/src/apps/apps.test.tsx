import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RouterProvider } from "@/router/router";
import { AppRouteView, AppsView } from "@/views/AppsView";

import { appIdFromPath } from "./registry";
import { resetApps } from "./store";

interface FakeApp {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  connected: boolean;
  holds_private_data: boolean;
}

let available = true;
let apps: FakeApp[];
let calls: Array<{ method: string; url: string; body?: unknown }>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  available = true;
  apps = [{ id: "plex", name: "Plex", description: "Your Plex server.", enabled: false, connected: false, holds_private_data: true }];
  calls = [];
  resetApps();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/apps") return json({ available, apps });
      if (url === "/api/apps/plex" && method === "PUT") {
        if (!available) return json({ error: { code: "forbidden", message: "Apps are turned off on this server." } }, 403);
        apps[0] = { ...apps[0]!, enabled: (JSON.parse(String(init.body)) as { enabled: boolean }).enabled };
        return json(apps[0]);
      }
      if (url === "/api/apps/plex/status") return json({ connected: false, signed_in: false, account: null, avatar: null, server: null, connection: null });
      return json({ error: { code: "not_found", message: "nope" } }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderWith = (ui: React.ReactNode) => render(<RouterProvider>{ui}</RouterProvider>);

describe("AppsView", () => {
  it("lists the apps and turns one on and off", async () => {
    renderWith(<AppsView />);
    const toggle = await screen.findByRole("switch", { name: "Plex app" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("link", { name: "Open Plex" })).toBeNull();
    expect(screen.getByText(/only answers requests from this computer/)).toBeInTheDocument();

    await act(async () => fireEvent.click(toggle));
    expect(calls.at(-1)).toEqual({ method: "PUT", url: "/api/apps/plex", body: { enabled: true } });
    expect(screen.getByRole("switch", { name: "Plex app" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("link", { name: "Open Plex" })).toHaveAttribute("href", "/apps/plex");

    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Plex app" })));
    expect(calls.at(-1)?.body).toEqual({ enabled: false });
    expect(screen.getByRole("switch", { name: "Plex app" })).toHaveAttribute("aria-checked", "false");
  });

  it("says so when the server keeps apps off", async () => {
    available = false;
    renderWith(<AppsView />);
    expect(await screen.findByText(/YTC_ENABLE_APPS=false/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Plex app" })).toBeDisabled();
  });
});

describe("AppRouteView", () => {
  it("doesn't load a turned-off app, and explains", async () => {
    renderWith(<AppRouteView id="plex" />);
    expect(await screen.findByRole("heading", { name: "The Plex app is off" })).toBeInTheDocument();
    expect(calls.some((call) => call.url.startsWith("/api/apps/plex/"))).toBe(false);
  });

  it("loads the app's own view once it's on", async () => {
    apps[0]!.enabled = true;
    renderWith(<AppRouteView id="plex" />);
    expect(await screen.findByRole("heading", { name: "Connect your Plex account" })).toBeInTheDocument();
    expect(calls.map((call) => call.url)).toContain("/api/apps/plex/status");
  });

  it("knows apps it has never heard of", async () => {
    renderWith(<AppRouteView id="jellyfin" />);
    expect(await screen.findByRole("heading", { name: "There's no app here" })).toBeInTheDocument();
  });
});

describe("appIdFromPath", () => {
  it("finds the app in its paths only", () => {
    expect(appIdFromPath("/apps/plex")).toBe("plex");
    expect(appIdFromPath("/apps/plex/watch")).toBe("plex");
    expect(appIdFromPath("/apps")).toBeNull();
    expect(appIdFromPath("/appstore")).toBeNull();
  });
});

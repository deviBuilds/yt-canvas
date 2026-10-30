import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DevicesView } from "@/views/DevicesView";

import { PairingGate } from "./PairingGate";

let status: Record<string, unknown>;
let checks: string[];
let calls: Array<{ method: string; url: string; body?: unknown }>;
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  status = { local: false, paired: false, required: true, device: null };
  checks = ["waiting", "paired"];
  calls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/pairing/status") return json(status);
    if (url === "/api/pairing/requests") return json({ id: "r1", code: "482913", name: "My car", expires_at: 0, approved: false });
    if (url === "/api/pairing/requests/r1") return json({ state: checks.shift() ?? "paired" });
    if (url === "/api/pairing/devices") return json({ devices: [{ id: "d1", name: "Tesla", created: 0, last_seen: 0 }], requests: [] });
    if (url === "/api/pairing/approve") return (init.body as string).includes("482913") ? json({ id: "r1", code: "482913", name: "My car", expires_at: 0, approved: true }) : json({ error: { code: "not_found", message: "No device is waiting with that code." } }, 404);
    if (url === "/api/pairing/devices/d1") return json({ ok: true });
    return json({}, 404);
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PairingGate", () => {
  it("shows the app on this computer, or when nothing needs pairing", async () => {
    status = { local: true, paired: false, required: true, device: null };
    render(<PairingGate><p>the app</p></PairingGate>);
    expect(await screen.findByText("the app")).toBeInTheDocument();
    await act(async () => undefined);
    expect(screen.queryByRole("heading", { name: "Pair this device" })).toBeNull();
  });

  it("replaces the app on an unpaired device, shows a code, and reloads once approved", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<PairingGate><p>the app</p></PairingGate>);
    expect(await screen.findByRole("heading", { name: "Pair this device" })).toBeInTheDocument();
    expect(screen.queryByText("the app")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name this device (optional)"), { target: { value: "My car" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pair this device" })));
    expect(calls.find((c) => c.url === "/api/pairing/requests")?.body).toEqual({ name: "My car" });
    expect(screen.getByTestId("pairing-code")).toHaveTextContent("482913");
    await act(async () => void (await vi.advanceTimersByTimeAsync(4500)));
    expect(reload).toHaveBeenCalled();
  });
});

describe("DevicesView", () => {
  it("approves a code and revokes a device", async () => {
    render(<DevicesView />);
    expect(await screen.findByText("Tesla")).toBeInTheDocument();
    const input = screen.getByLabelText("Code shown on the device");
    fireEvent.change(input, { target: { value: "48-29 13x" } });
    expect(input).toHaveValue("482913");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Approve" })));
    expect(screen.getByText(/Approved My car/)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Revoke Tesla" })));
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/pairing/devices/d1")).toBe(true);
  });
});

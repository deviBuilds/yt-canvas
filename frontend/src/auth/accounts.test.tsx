import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { request, setSessionToken } from "@/api/http";
import type { VideoSummary } from "@/api/types";
import { FAVORITES_KEY, HISTORY_KEY, LibraryProvider, useLibrary } from "@/library/LibraryContext";
import { HISTORY_FLUSH_MS, IMPORTED_KEY } from "@/library/remote";
import { AccessView } from "@/views/AccessView";

import { AccountContext, type AccountValue } from "./AccountContext";
import type { AccountUser } from "./api";
import { AuthGate } from "./AuthGate";

const video = (id: string): VideoSummary => ({
  source: "youtube",
  id,
  title: `Video ${id}`,
  channel: null,
  duration_seconds: 100,
  thumbnail_url: null,
  view_count: null,
  live_status: null,
  available: true,
  unavailable_reason: null,
});

const bea: AccountUser = { email: "bea@example.com", name: "Bea", image_url: null, admin: false, via: "clerk", device: null };
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });

let calls: Array<{ method: string; url: string; body?: unknown; headers: Record<string, string>; keepalive?: boolean }>;
let library: Record<string, unknown[]>;

beforeEach(() => {
  window.localStorage.clear();
  calls = [];
  library = { favorites: [{ video: video("server"), addedAt: 1 }], history: [], searches: [] };
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({
        method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init.headers ?? {}) as Record<string, string>,
        keepalive: init.keepalive,
      });
      if (url === "/api/library" && method === "GET") return json(library);
      if (url.startsWith("/api/library")) return json({ ok: true });
      if (url === "/api/auth/config") return json({ accounts: false });
      if (url === "/api/pairing/status") return json({ local: true, paired: false, required: false, device: null });
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  setSessionToken(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const signedIn = (user: AccountUser): AccountValue => ({ accounts: true, user, signOut: () => undefined });
const as = (value: AccountValue) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AccountContext.Provider value={value}>
        <LibraryProvider>{children}</LibraryProvider>
      </AccountContext.Provider>
    );
  };

describe("the library with accounts on", () => {
  it("comes from the account and saves changes there, not in this browser", async () => {
    const { result } = renderHook(() => useLibrary(), { wrapper: as(signedIn(bea)) });
    await vi.waitFor(() => expect(result.current.favorites.map((f) => f.video.id)).toEqual(["server"]));
    act(() => result.current.toggleFavorite(video("new")));
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PUT", url: "/api/library/favorites" }));
    expect((calls.at(-1)?.body as { entries: Array<{ key: string }> }).entries[0]?.key).toBe("youtube:new");
    act(() => result.current.toggleFavorite(video("server")));
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "/api/library/favorites/youtube%3Aserver" }));
    act(() => result.current.addSearch("Cats"));
    await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ method: "PUT", url: "/api/library/searches" }));
    expect(window.localStorage.getItem(FAVORITES_KEY)).toBeNull();
  });

  it("batches playback progress, and sends what's left when the page is hidden", async () => {
    const { result } = renderHook(() => useLibrary(), { wrapper: as(signedIn(bea)) });
    await vi.waitFor(() => expect(result.current.favorites).toHaveLength(1));
    act(() => {
      result.current.recordProgress(video("a"), 10, 100);
      result.current.recordProgress(video("a"), 15, 100);
      result.current.recordProgress(video("b"), 3, 50);
    });
    expect(result.current.continueWatching.map((h) => h.video.id)).toEqual(["a"]);
    expect(calls.filter((c) => c.url === "/api/library/history")).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(HISTORY_FLUSH_MS);
    });
    await vi.waitFor(() => expect(calls.filter((c) => c.url === "/api/library/history")).toHaveLength(1));
    const sent = calls.filter((c) => c.url === "/api/library/history");
    const entries = (sent[0]?.body as { entries: Array<{ key: string; data: { position: number } }> }).entries;
    expect(entries.map((e) => [e.key, e.data.position])).toEqual([["youtube:a", 15], ["youtube:b", 3]]);

    act(() => result.current.recordProgress(video("a"), 40, 100));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const last = calls.filter((c) => c.url === "/api/library/history").at(-1);
    expect(last?.keepalive).toBe(true);
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it("merges this browser's own library into the first account once", async () => {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([{ video: video("local"), addedAt: 7 }]));
    const first = renderHook(() => useLibrary(), { wrapper: as(signedIn(bea)) });
    await vi.waitFor(() => expect(first.result.current.favorites).toHaveLength(1));
    await vi.waitFor(() => expect(window.localStorage.getItem(IMPORTED_KEY)).not.toBeNull());
    const imported = calls.filter((c) => c.method === "PUT" && c.url === "/api/library/favorites");
    expect(imported).toHaveLength(1);
    expect(window.localStorage.getItem(IMPORTED_KEY)).toBe(JSON.stringify("bea@example.com"));
    first.unmount();
    calls = [];
    const again = renderHook(() => useLibrary(), { wrapper: as(signedIn({ ...bea, email: "cal@example.com" })) });
    await vi.waitFor(() => expect(again.result.current.favorites).toHaveLength(1));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("stays in this browser in no-login mode", () => {
    const { result } = renderHook(() => useLibrary(), { wrapper: ({ children }) => <LibraryProvider>{children}</LibraryProvider> });
    act(() => result.current.toggleFavorite(video("x")));
    expect(JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? "[]")).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith("/api/library"))).toHaveLength(0);
  });
});

describe("API calls with accounts on", () => {
  it("carry the session token", async () => {
    setSessionToken(async () => "tok");
    await request("/api/library");
    expect(calls.at(-1)?.headers.Authorization).toBe("Bearer tok");
    setSessionToken(null);
    await request("/api/library");
    expect(calls.at(-1)?.headers.Authorization).toBeUndefined();
  });
});

describe("AuthGate", () => {
  it("goes straight to the app in no-login mode", async () => {
    render(
      <AuthGate>
        <p>the app</p>
      </AuthGate>,
    );
    expect(await screen.findByText("the app")).toBeInTheDocument();
  });
});

describe("AccessView", () => {
  it("is for admins only", () => {
    render(
      <AccountContext.Provider value={signedIn(bea)}>
        <AccessView />
      </AccountContext.Provider>,
    );
    expect(screen.getByText("Only admins can see who may sign in.")).toBeInTheDocument();
  });

  it("lists and changes the allowlist for admins", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init = {}) => {
      calls.push({ method: init.method ?? "GET", url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined, headers: {} });
      return json({ entries: [{ email: "admin@example.com", addedBy: null, addedAt: 0, admin: true }, { email: "bea@example.com", addedBy: "admin@example.com", addedAt: 0, admin: false }], added: 1, ok: true });
    });
    render(
      <AccountContext.Provider value={signedIn({ ...bea, email: "admin@example.com", admin: true })}>
        <AccessView />
      </AccountContext.Provider>,
    );
    expect(await screen.findByText("bea@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Remove admin@example.com")).toBeNull();
    act(() => screen.getByLabelText("Remove bea@example.com").click());
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/admin/allowlist/bea%40example.com")).toBe(true));
  });
});

describe("Your YouTube", () => {
  it("takes pasted cookies in any format and doesn't keep them in the page", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { SignInView } = await import("@/views/SignInView");
    vi.mocked(fetch).mockImplementation(async (url, init = {}) => {
      calls.push({ method: init.method ?? "GET", url: String(url), body: init.body, headers: (init.headers ?? {}) as Record<string, string> });
      if (url === "/api/me/cookies") return json({ ok: true, count: 21, uploaded_at: 1, format: "json" });
      return json({ configured: false, signed_in: false, source: null, avatar_url: null, chips: [], detail: null, uploads: true });
    });
    render(
      <AccountContext.Provider value={signedIn(bea)}>
        <SignInView />
      </AccountContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Paste instead/ }));
    const box = screen.getByLabelText(/Paste a cookies.txt, a JSON export or a Cookie header/);
    const exported = '[{"domain": ".youtube.com", "name": "SID", "value": "x"}]';
    fireEvent.change(box, { target: { value: exported } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved 21 youtube.com cookies from a JSON export/)).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/me/cookies")).toMatchObject({ method: "PUT", body: exported });
    expect(screen.queryByLabelText(/Paste a cookies.txt/)).toBeNull();
  });
});

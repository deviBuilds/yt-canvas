import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoSummary } from "../api/types";
import { FAVORITES_KEY, HISTORY_KEY, isInProgress, LibraryProvider, useLibrary } from "./LibraryContext";
import { asVideo, readJson, writeJson } from "./storage";

const video = (id: string, extra: Partial<VideoSummary> = {}): VideoSummary => ({
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
  ...extra,
});

const wrapper = ({ children }: { children: ReactNode }) => <LibraryProvider>{children}</LibraryProvider>;

beforeEach(() => window.localStorage.clear());

describe("storage helpers", () => {
  it("falls back on corrupt or unexpected data", () => {
    window.localStorage.setItem("k", "{not json");
    expect(readJson("k", () => "ok", "fallback")).toBe("fallback");
    window.localStorage.setItem("k", JSON.stringify({ wrong: true }));
    expect(readJson("k", (v) => (Array.isArray(v) ? v : null), [])).toEqual([]);
  });

  it("survives storage that throws (private mode, quota)", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    expect(readJson("k", () => 1, 0, broken)).toBe(0);
    expect(writeJson("k", 1, broken)).toBe(false);
  });

  it("validates stored videos", () => {
    expect(asVideo({ id: "x", title: "t", source: "vimeo" })).toBeNull();
    expect(asVideo({ id: "", title: "t", source: "youtube" })).toBeNull();
    expect(asVideo({ id: "abc", title: "t", source: "demo", duration_seconds: "long" })?.duration_seconds).toBeNull();
  });
});

describe("library", () => {
  it("toggles favorites and persists them", () => {
    const { result } = renderHook(() => useLibrary(), { wrapper });
    act(() => result.current.toggleFavorite(video("a")));
    expect(result.current.isFavorite(video("a"))).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(FAVORITES_KEY)!)).toHaveLength(1);
    act(() => result.current.toggleFavorite(video("a")));
    expect(result.current.isFavorite(video("a"))).toBe(false);
  });

  it("tracks continue watching and resume positions", () => {
    const { result } = renderHook(() => useLibrary(), { wrapper });
    act(() => {
      result.current.recordProgress(video("start"), 2, 100);
      result.current.recordProgress(video("middle"), 40, 100);
      result.current.recordProgress(video("done"), 99, 100);
    });
    expect(result.current.continueWatching.map((h) => h.video.id)).toEqual(["middle"]);
    expect(result.current.resumePosition(video("middle"))).toBe(40);
    expect(result.current.resumePosition(video("done"))).toBeNull();
    expect(result.current.history[0]?.video.id).toBe("done"); // most recent first
  });

  it("loads saved history and ignores invalid entries", () => {
    window.localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([{ video: video("ok"), position: 30, duration: 100, updatedAt: 1 }, { video: { id: 3 }, position: 1 }, "junk"]),
    );
    const { result } = renderHook(() => useLibrary(), { wrapper });
    expect(result.current.history.map((h) => h.video.id)).toEqual(["ok"]);
  });

  it("treats unknown durations as in progress once started", () => {
    expect(isInProgress({ video: video("a"), position: 30, duration: null, updatedAt: 0 })).toBe(true);
    expect(isInProgress({ video: video("a"), position: 1, duration: null, updatedAt: 0 })).toBe(false);
  });

  it("keeps tabs in sync through storage events", () => {
    const { result } = renderHook(() => useLibrary(), { wrapper });
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([{ video: video("other-tab"), addedAt: 1 }]));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: FAVORITES_KEY }));
    });
    expect(result.current.isFavorite(video("other-tab"))).toBe(true);
    vi.restoreAllMocks();
  });
});

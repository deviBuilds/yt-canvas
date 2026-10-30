import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { forgetLoaded, useLoad } from "./useLoad";

beforeEach(forgetLoaded);

describe("useLoad", () => {
  it("shows what was loaded last time at once, then refreshes it in the background", async () => {
    const first = renderHook(() => useLoad(async () => "rows v1", [], "home"));
    expect(first.result.current.data).toBeNull();
    await vi.waitFor(() => expect(first.result.current.data).toBe("rows v1"));
    first.unmount();

    let finish: (value: string) => void = () => undefined;
    const again = renderHook(() => useLoad(() => new Promise<string>((resolve) => (finish = resolve)), [], "home"));
    expect(again.result.current.data).toBe("rows v1"); // the very first render, before any fetch
    expect(again.result.current.refreshing).toBe(true);
    await act(async () => finish("rows v2"));
    expect(again.result.current).toMatchObject({ data: "rows v2", refreshing: false, error: null });
  });

  it("keeps what it had when a refresh fails, and only shows errors with nothing to show", async () => {
    const ok = renderHook(() => useLoad(async () => "item", [], "item:1"));
    await vi.waitFor(() => expect(ok.result.current.data).toBe("item"));
    ok.unmount();
    const failing = renderHook(() => useLoad(async () => Promise.reject(new Error("offline")), [], "item:1"));
    await vi.waitFor(() => expect(failing.result.current.refreshing).toBe(false));
    expect(failing.result.current).toMatchObject({ data: "item", error: null });
    const fresh = renderHook(() => useLoad(async () => Promise.reject(new Error("offline")), [], "item:2"));
    await vi.waitFor(() => expect(fresh.result.current.error).toBe("offline"));
  });

  it("caches nothing without a key, and forgets everything when Plex changes", async () => {
    const plain = renderHook(() => useLoad(async () => "watch", []));
    await vi.waitFor(() => expect(plain.result.current.data).toBe("watch"));
    plain.unmount();
    expect(renderHook(() => useLoad(() => new Promise(() => undefined), [])).result.current.data).toBeNull();
    const keyed = renderHook(() => useLoad(async () => "home", [], "home"));
    await vi.waitFor(() => expect(keyed.result.current.data).toBe("home"));
    keyed.unmount();
    forgetLoaded();
    expect(renderHook(() => useLoad(() => new Promise(() => undefined), [], "home")).result.current.data).toBeNull();
  });
});

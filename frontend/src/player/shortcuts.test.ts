import { describe, expect, it } from "vitest";

import { actionForKey } from "./shortcuts";

function keydown(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

const el = (tag: string, props: Record<string, unknown> = {}): HTMLElement =>
  Object.assign(document.createElement(tag), props);

describe("actionForKey", () => {
  it("maps the documented shortcuts", () => {
    expect(actionForKey(keydown(" "))).toEqual({ type: "toggle" });
    expect(actionForKey(keydown("k"))).toEqual({ type: "toggle" });
    expect(actionForKey(keydown("ArrowLeft"))).toEqual({ type: "seekBy", seconds: -5 });
    expect(actionForKey(keydown("l"))).toEqual({ type: "seekBy", seconds: 10 });
    expect(actionForKey(keydown("ArrowUp"))).toEqual({ type: "volumeBy", delta: 0.05 });
    expect(actionForKey(keydown("M"))).toEqual({ type: "toggleMute" });
    expect(actionForKey(keydown("f"))).toEqual({ type: "toggleFullscreen" });
    expect(actionForKey(keydown("g"))).toEqual({ type: "toggleEffect" });
    expect(actionForKey(keydown(">", document.body, { shiftKey: true }))).toEqual({ type: "rateStep", direction: 1 });
    expect(actionForKey(keydown("4"))).toEqual({ type: "seekToFraction", fraction: 0.4 });
    expect(actionForKey(keydown("End"))).toEqual({ type: "seekTo", seconds: "end" });
    expect(actionForKey(keydown("N", document.body, { shiftKey: true }))).toEqual({ type: "next" });
    expect(actionForKey(keydown("P", document.body, { shiftKey: true }))).toEqual({ type: "previous" });
  });

  it("never steals typing in text fields", () => {
    for (const target of [el("input", { type: "search" }), el("textarea"), el("select")]) {
      expect(actionForKey(keydown("k", target))).toBeNull();
      expect(actionForKey(keydown(" ", target))).toBeNull();
    }
  });

  it("leaves Space on buttons and arrows on sliders to the native control", () => {
    expect(actionForKey(keydown(" ", el("button")))).toBeNull();
    const slider = el("input", { type: "range" });
    expect(actionForKey(keydown("ArrowRight", slider))).toBeNull();
    expect(actionForKey(keydown("Home", slider))).toBeNull();
    // ...but keys without native meaning still work there.
    expect(actionForKey(keydown("7", slider))).toEqual({ type: "seekToFraction", fraction: 0.7 });
    expect(actionForKey(keydown("k", slider))).toEqual({ type: "toggle" });
  });

  it("ignores modified keys and already-handled events", () => {
    expect(actionForKey(keydown("k", document.body, { ctrlKey: true }))).toBeNull();
    expect(actionForKey(keydown("f", document.body, { metaKey: true }))).toBeNull();
    const handled = keydown("k");
    handled.preventDefault();
    expect(actionForKey(handled)).toBeNull();
    expect(actionForKey(keydown("x"))).toBeNull();
  });
});

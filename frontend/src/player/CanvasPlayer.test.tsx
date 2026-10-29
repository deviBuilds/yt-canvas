import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  failMedia,
  fakeContext,
  installFakeCanvas,
  installFakeMedia,
  loadMetadata,
  mediaSpies,
  mediaState,
  pendingFrameCallbacks,
  presentFrame,
} from "../test/fakeMedia";
import { CanvasPlayer, type CanvasPlayerProps, type PlayerCanvas } from "./CanvasPlayer";

function renderPlayer(props: Partial<CanvasPlayerProps> = {}) {
  const result = render(<CanvasPlayer src={null} {...props} />);
  const video = result.container.querySelector("video") as HTMLVideoElement;
  const canvas = screen.getByTestId("video-canvas") as HTMLCanvasElement;
  return { ...result, video, canvas, rerenderPlayer: (next: Partial<CanvasPlayerProps>) => result.rerender(<CanvasPlayer src={null} {...props} {...next} />) };
}

const stats = (canvas: HTMLCanvasElement) => (canvas as PlayerCanvas).ytcRenderer!.stats;

/** Let promise callbacks (play() resolution) settle inside act(). */
const flush = () => act(async () => undefined);

beforeEach(() => {
  installFakeMedia();
  installFakeCanvas();
  window.localStorage.clear();
  mediaSpies.play.mockClear();
  mediaSpies.pause.mockClear();
  mediaSpies.load.mockClear();
});

afterEach(cleanup);

describe("CanvasPlayer", () => {
  it("renders into a canvas and keeps the decoder element hidden from users", () => {
    const { video, canvas } = renderPlayer();
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute("role", "img");
    expect(video).toHaveAttribute("aria-hidden", "true");
    expect(video).toHaveClass("decoder", "decoder-layered");
    expect(video.hasAttribute("controls")).toBe(false);
    expect(video.playsInline).toBe(true);
    expect(stats(canvas).mode).toBe("video-frame-callback");
    expect(canvas.hasAttribute("data-render-mode")).toBe(false);
    // Nothing to play yet: transport controls are disabled.
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeDisabled();
  });

  it("shows the overlay (e.g. preparation progress) while there is no source", () => {
    renderPlayer({ overlay: <p>Preparing…</p> });
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
  });

  it("loads a source, applies the start time, then autoplays", async () => {
    const { video } = renderPlayer({ src: "/api/media/a", startTime: 42 });
    expect(video.getAttribute("src")).toBe("/api/media/a");
    expect(mediaSpies.load).toHaveBeenCalledTimes(1);
    expect(mediaSpies.play).not.toHaveBeenCalled(); // waits for metadata

    act(() => loadMetadata(video, { duration: 120 }));
    await flush();
    expect(video.currentTime).toBe(42);
    expect(mediaSpies.play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
  });

  it("ignores a start time beyond the end of the video", async () => {
    const { video } = renderPlayer({ src: "/api/media/a", startTime: 500 });
    act(() => loadMetadata(video, { duration: 120 }));
    await flush();
    expect(video.currentTime).toBe(0);
  });

  it("switches sources cleanly: reload, reset frames, single frame loop", async () => {
    const onTimeUpdate = vi.fn();
    const { video, canvas, rerenderPlayer } = renderPlayer({ src: "/api/media/a", onTimeUpdate });
    act(() => loadMetadata(video, { duration: 60, width: 1280, height: 720 }));
    await flush();
    act(() => {
      presentFrame(video, 1);
      presentFrame(video, 2);
    });
    expect(stats(canvas).framesDrawn).toBeGreaterThan(1);

    rerenderPlayer({ src: "/api/media/b", onTimeUpdate, startTime: null });
    expect(video.getAttribute("src")).toBe("/api/media/b");
    expect(mediaSpies.load).toHaveBeenCalledTimes(2);
    expect(stats(canvas).framesDrawn).toBe(0);
    expect(pendingFrameCallbacks(video)).toBe(1);
    expect(screen.getByRole("slider", { name: "Seek" })).toHaveValue("0");

    act(() => loadMetadata(video, { duration: 30, width: 360, height: 640 }));
    await flush();
    expect(mediaSpies.play).toHaveBeenCalledTimes(2);
    expect(pendingFrameCallbacks(video)).toBe(1);

    // Dropping the source releases the decoder.
    rerenderPlayer({ src: null });
    expect(video.hasAttribute("src")).toBe(false);
    expect(mediaSpies.load).toHaveBeenCalledTimes(3);
  });

  it("play/pause button drives the media element", async () => {
    const { video } = renderPlayer({ src: "/api/media/a", autoPlay: false });
    act(() => loadMetadata(video));
    await flush();
    expect(mediaSpies.play).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await flush();
    expect(video.paused).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(video.paused).toBe(true);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("seeks with the slider and redraws the paused frame", async () => {
    const { video, canvas } = renderPlayer({ src: "/api/media/a", autoPlay: false });
    act(() => loadMetadata(video, { duration: 100 }));
    const draws = fakeContext(canvas).draws.length;
    fireEvent.change(screen.getByRole("slider", { name: "Seek" }), { target: { value: "37.5" } });
    expect(video.currentTime).toBe(37.5);
    expect(fakeContext(canvas).draws.length).toBeGreaterThan(draws);
    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute("aria-valuetext", "0:37 of 1:40");
    expect(screen.getByText("0:37")).toBeInTheDocument();
  });

  it("controls volume, mute, speed and the effect toggle, and remembers them", async () => {
    const { video, unmount } = renderPlayer({ src: "/api/media/a", autoPlay: false });
    act(() => loadMetadata(video));

    fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.3" } });
    expect(video.volume).toBeCloseTo(0.3);
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(video.muted).toBe(true);
    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "1.5" } });
    expect(video.playbackRate).toBe(1.5);
    expect(video.defaultPlaybackRate).toBe(1.5); // survives the next load()

    const toggle = screen.getByRole("button", { name: /Grayscale/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Visual effect")).toHaveValue("grayscale");

    unmount();
    const saved = JSON.parse(window.localStorage.getItem("ytc.player.v1")!);
    expect(saved).toMatchObject({ volume: 0.3, muted: true, rate: 1.5, effect: "grayscale" });
  });

  it("handles keyboard shortcuts on the whole page when asked to", async () => {
    const { video } = renderPlayer({ src: "/api/media/a", autoPlay: false, globalShortcuts: true });
    act(() => loadMetadata(video, { duration: 100 }));
    const key = (k: string, init: KeyboardEventInit = {}) =>
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
      });

    key("k");
    await flush();
    expect(video.paused).toBe(false);
    key("ArrowRight");
    expect(video.currentTime).toBe(5);
    key("j");
    expect(video.currentTime).toBe(0);
    key("5");
    expect(video.currentTime).toBe(50);
    key("m");
    expect(video.muted).toBe(true);
    key(">", { shiftKey: true });
    expect(video.playbackRate).toBe(1.25);
    key("g");
    expect(screen.getByRole("button", { name: /Grayscale/ })).toHaveAttribute("aria-pressed", "true");
    key(" ");
    expect(video.paused).toBe(true);
  });

  it("asks for a click when autoplay is blocked", async () => {
    const { video } = renderPlayer({ src: "/api/media/a" });
    mediaState(video).playResult = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    act(() => loadMetadata(video));
    await flush();
    const button = await screen.findByRole("button", { name: "Play video" });
    mediaState(video).playResult = null;
    fireEvent.click(button);
    await flush();
    expect(video.paused).toBe(false);
    expect(screen.queryByRole("button", { name: "Play video" })).not.toBeInTheDocument();
  });

  it("surfaces playback failures with a retry action", async () => {
    const onRetry = vi.fn();
    const { video } = renderPlayer({ src: "/api/media/a", onRetry });
    act(() => failMedia(video, 4));
    expect(screen.getByRole("alert")).toHaveTextContent("Playback error");
    fireEvent.click(screen.getByRole("button", { name: "Prepare again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows a buffering indicator while waiting for data", async () => {
    const { video } = renderPlayer({ src: "/api/media/a" });
    act(() => loadMetadata(video));
    await flush();
    expect(screen.queryByText("Buffering…")).not.toBeInTheDocument();
    act(() => {
      video.dispatchEvent(new Event("waiting"));
    });
    expect(screen.getByText("Buffering…")).toBeInTheDocument();
    act(() => {
      video.dispatchEvent(new Event("playing"));
    });
    expect(screen.queryByText("Buffering…")).not.toBeInTheDocument();
  });

  it("previous/next buttons follow availability", () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    renderPlayer({ src: "/api/media/a", hasNext: true, hasPrevious: false, onNext, onPrevious });
    expect(screen.getByRole("button", { name: "Previous video" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next video" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("reports the end of playback", async () => {
    const onEnded = vi.fn();
    const { video } = renderPlayer({ src: "/api/media/a", onEnded });
    act(() => {
      video.dispatchEvent(new Event("ended"));
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("releases everything on unmount", async () => {
    const { video, unmount } = renderPlayer({ src: "/api/media/a" });
    act(() => loadMetadata(video));
    await flush();
    expect(pendingFrameCallbacks(video)).toBe(1);
    unmount();
    expect(pendingFrameCallbacks(video)).toBe(0);
    expect(video.paused).toBe(true);
    expect(video.hasAttribute("src")).toBe(false);
  });
});

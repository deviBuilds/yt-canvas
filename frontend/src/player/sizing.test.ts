import { describe, expect, it } from "vitest";

import { backingSize, fitContain, MAX_BACKING_PIXELS } from "./sizing";

describe("fitContain", () => {
  it("letterboxes wide content and pillarboxes tall content", () => {
    expect(fitContain({ width: 1000, height: 1000 }, 16 / 9)).toEqual({ width: 1000, height: 562 });
    expect(fitContain({ width: 1600, height: 900 }, 9 / 16)).toEqual({ width: 506, height: 900 });
    expect(fitContain({ width: 1600, height: 900 }, 16 / 9)).toEqual({ width: 1600, height: 900 });
  });

  it("handles empty containers and invalid aspect ratios", () => {
    expect(fitContain({ width: 0, height: 100 }, 1)).toEqual({ width: 0, height: 0 });
    expect(fitContain({ width: 100, height: 100 }, NaN)).toEqual({ width: 0, height: 0 });
  });
});

describe("backingSize", () => {
  const video720 = { width: 1280, height: 720 };

  it("matches device pixels when the display is smaller than the video", () => {
    expect(backingSize({ width: 640, height: 360 }, 1, video720)).toEqual({ width: 640, height: 360 });
    expect(backingSize({ width: 320, height: 180 }, 3, video720)).toEqual({ width: 960, height: 540 });
  });

  it("never exceeds the intrinsic resolution", () => {
    expect(backingSize({ width: 1920, height: 1080 }, 2, video720)).toEqual(video720);
  });

  it("uses the device pixel ratio before metadata is known", () => {
    expect(backingSize({ width: 400, height: 225 }, 2, { width: 0, height: 0 })).toEqual({ width: 800, height: 450 });
  });

  it("caps the total pixel count", () => {
    const size = backingSize({ width: 4000, height: 4000 }, 2, { width: 0, height: 0 });
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_BACKING_PIXELS + 4000);
    expect(size.width).toBe(size.height);
  });

  it("treats bad ratios as 1", () => {
    expect(backingSize({ width: 100, height: 50 }, 0, { width: 0, height: 0 })).toEqual({ width: 100, height: 50 });
  });
});

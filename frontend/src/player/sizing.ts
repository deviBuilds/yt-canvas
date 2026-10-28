export interface Size {
  width: number;
  height: number;
}

/** Largest box with ``aspect`` (w / h) that fits inside the container. */
export function fitContain(container: Size, aspect: number): Size {
  if (container.width <= 0 || container.height <= 0 || !(aspect > 0)) return { width: 0, height: 0 };
  let width = container.width;
  let height = width / aspect;
  if (height > container.height) {
    height = container.height;
    width = height * aspect;
  }
  return { width: Math.floor(width), height: Math.floor(height) };
}

export const MAX_BACKING_PIXELS = 3840 * 2160;

/**
 * Size of the canvas backing buffer for a displayed CSS size.
 *
 * The buffer matches the device pixels it covers (CSS size × devicePixelRatio)
 * so downscaled video stays sharp, but never exceeds the video's intrinsic
 * resolution: upscaling is left to the compositor instead of costing a larger
 * drawImage and getImageData per frame. The aspect ratio of the display box is
 * preserved, and the total is capped at ``maxPixels``.
 */
export function backingSize(
  display: Size,
  devicePixelRatio: number,
  intrinsic: Size,
  maxPixels = MAX_BACKING_PIXELS,
): Size {
  if (display.width <= 0 || display.height <= 0) return { width: 0, height: 0 };
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  let scale = dpr;
  if (intrinsic.width > 0 && intrinsic.height > 0) {
    scale = Math.min(scale, intrinsic.width / display.width, intrinsic.height / display.height);
  }
  let width = display.width * scale;
  let height = display.height * scale;
  if (width * height > maxPixels) {
    const shrink = Math.sqrt(maxPixels / (width * height));
    width *= shrink;
    height *= shrink;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

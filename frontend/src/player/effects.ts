/**
 * Visual effects applied while drawing video frames into the canvas.
 *
 * Filter effects use CanvasRenderingContext2D.filter where supported (GPU,
 * cheap). Browsers without ``ctx.filter`` fall back to a per-pixel transform
 * on getImageData(), which is why the media must be same-origin.
 */

export type EffectId = "none" | "grayscale" | "sepia" | "invert" | "pixelate";

export interface Effect {
  id: EffectId;
  label: string;
  /** CSS filter string for ctx.filter. */
  filter?: string;
  /** Per-pixel fallback when ctx.filter is unavailable. */
  transform?: (data: Uint8ClampedArray) => void;
  /** Block size for the pixelate effect, in backing-buffer pixels. */
  pixelate?: number;
}

function grayscale(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 709 luma, the same weights as CSS grayscale().
    const y = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    data[i] = data[i + 1] = data[i + 2] = y;
  }
}

function sepia(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    data[i] = 0.393 * r + 0.769 * g + 0.189 * b;
    data[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
    data[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
  }
}

function invert(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i]!;
    data[i + 1] = 255 - data[i + 1]!;
    data[i + 2] = 255 - data[i + 2]!;
  }
}

export const EFFECTS: readonly Effect[] = [
  { id: "none", label: "Original" },
  { id: "grayscale", label: "Grayscale", filter: "grayscale(1)", transform: grayscale },
  { id: "sepia", label: "Sepia", filter: "sepia(1)", transform: sepia },
  { id: "invert", label: "Invert", filter: "invert(1)", transform: invert },
  { id: "pixelate", label: "Pixelate", pixelate: 12 },
];

export function getEffect(id: EffectId): Effect {
  return EFFECTS.find((effect) => effect.id === id) ?? EFFECTS[0]!;
}

export function isEffectId(value: unknown): value is EffectId {
  return typeof value === "string" && EFFECTS.some((effect) => effect.id === value);
}

export function supportsCanvasFilter(ctx: CanvasRenderingContext2D): boolean {
  return typeof ctx.filter === "string";
}

export const pixelTransforms = { grayscale, sepia, invert };

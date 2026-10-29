import { useEffect, useState } from "react";

export interface Tint {
  /** Card backdrop on hover. */
  background: string;
  /** Channel and stats text on hover. */
  accent: string;
}

type Hsl = [number, number, number];
const cache = new Map<string, Promise<Hsl | null>>();

/**
 * The thumbnail's dominant colour as HSL, weighted towards saturated pixels so a
 * grey background doesn't win. YouTube's image hosts send CORS headers, so the
 * canvas stays readable.
 */
function dominantHue(url: string): Promise<Hsl | null> {
  let pending = cache.get(url);
  if (!pending) {
    pending = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      img.onerror = () => resolve(null);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 24;
          canvas.height = 14;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let r = 0, g = 0, b = 0, weight = 0;
          for (let i = 0; i < data.length; i += 4) {
            const [pr, pg, pb] = [data[i]!, data[i + 1]!, data[i + 2]!];
            const max = Math.max(pr, pg, pb);
            const min = Math.min(pr, pg, pb);
            const w = 0.05 + (max - min) / 255; // saturation, with a floor for grey images
            r += pr * w;
            g += pg * w;
            b += pb * w;
            weight += w;
          }
          resolve(toHsl(r / weight, g / weight, b / weight));
        } catch {
          resolve(null); // a tainted canvas or a decoding failure: no tint
        }
      };
      img.src = url;
    });
    cache.set(url, pending);
  }
  return pending;
}

function toHsl(r: number, g: number, b: number): Hsl {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

/** YouTube's hover tint for a video card, computed once ``enabled`` (first hover) and cached per URL. */
export function useThumbnailTint(url: string | null | undefined, enabled: boolean, dark: boolean): Tint | null {
  const [hsl, setHsl] = useState<Hsl | null>(null);
  useEffect(() => {
    if (!url || !enabled) return;
    let live = true;
    void dominantHue(url).then((value) => {
      if (live) setHsl(value);
    });
    return () => {
      live = false;
    };
  }, [url, enabled]);
  if (!hsl) return null;
  const [h, s] = hsl;
  const sat = Math.round(Math.min(Math.max(s, 0.2), 0.6) * 100);
  return dark
    ? { background: `hsl(${h} ${sat}% 15%)`, accent: `hsl(${h} 80% 72%)` }
    : { background: `hsl(${h} ${sat}% 93%)`, accent: `hsl(${h} 70% 32%)` };
}

import { useEffect, useRef, type RefObject } from "react";

const WIDTH = 32;
const HEIGHT = 18;
const INTERVAL_MS = 150;

/**
 * YouTube's "ambient mode": a blurred, low-resolution copy of the picture glowing
 * behind the player. It samples the player's own canvas a few times a second, so
 * it costs one tiny drawImage and never touches the video element.
 */
export function AmbientGlow({ container }: { container: RefObject<HTMLElement | null> }) {
  const glow = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const target = glow.current?.getContext("2d");
    if (!target) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const source = container.current?.querySelector<HTMLCanvasElement>('canvas[data-testid="video-canvas"]');
      if (!source || source.width === 0 || source.height === 0) return;
      try {
        target.drawImage(source, 0, 0, WIDTH, HEIGHT);
      } catch {
        // Nothing drawn yet: try again on the next tick.
      }
    }, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [container]);

  return (
    <canvas
      ref={glow}
      width={WIDTH}
      height={HEIGHT}
      aria-hidden="true"
      // Desktop dark theme only, like YouTube; blur, not transform, so it can't widen the page.
      className="pointer-events-none absolute inset-0 -z-10 hidden size-full opacity-55 blur-[72px] saturate-150 lg:dark:block"
    />
  );
}

import type { SVGProps } from "react";

const PATHS = {
  play: "M8 5.14v13.72a1 1 0 0 0 1.52.85l10.9-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  next: "M6 6.5v11a.8.8 0 0 0 1.24.67L15 13v4.5h2v-11h-2V11L7.24 5.83A.8.8 0 0 0 6 6.5z",
  previous: "M18 6.5v11a.8.8 0 0 1-1.24.67L9 13v4.5H7v-11h2V11l7.76-5.17A.8.8 0 0 1 18 6.5z",
  volume:
    "M4 9.5v5h3.5L12 19V5L7.5 9.5H4zm11.5 2.5a4 4 0 0 0-2-3.46v6.92a4 4 0 0 0 2-3.46zM13.5 4.3v2.06a6 6 0 0 1 0 11.28v2.06a8 8 0 0 0 0-15.4z",
  muted:
    "M4 9.5v5h3.5L12 19V5L7.5 9.5H4zm16.7-.8-1.4-1.4L17 9.59 14.7 7.3l-1.4 1.4L15.59 11l-2.3 2.3 1.42 1.4L17 12.41l2.3 2.3 1.4-1.42L18.41 11l2.3-2.3z",
  fullscreen: "M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z",
  exitFullscreen: "M8 5h2v5H5V8h3zm6 0h2v3h3v2h-5zM5 14h5v5H8v-3H5zm9 0h5v2h-3v3h-2z",
  heart:
    "M12 20.3 10.6 19C5.6 14.5 2.5 11.7 2.5 8.3A4.3 4.3 0 0 1 6.9 4c1.9 0 3.6.9 5.1 2.5C13.5 4.9 15.2 4 17.1 4a4.3 4.3 0 0 1 4.4 4.3c0 3.4-3.1 6.2-8.1 10.7z",
  heartOutline:
    "M16.6 4C14.9 4 13.3 4.8 12 6.1 10.7 4.8 9.1 4 7.4 4A4.9 4.9 0 0 0 2.5 8.9c0 3.4 3 6.2 7.6 10.3L12 21l1.9-1.8c4.6-4.1 7.6-6.9 7.6-10.3A4.9 4.9 0 0 0 16.6 4zm-4.5 13.7-.1.1-.1-.1C7.6 14 4.5 11.3 4.5 8.9A2.9 2.9 0 0 1 7.4 6c1.3 0 2.5.8 3 1.9h3.2c.5-1.1 1.7-1.9 3-1.9a2.9 2.9 0 0 1 2.9 2.9c0 2.4-3.1 5.1-7.4 8.8z",
  queueAdd: "M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm14-1v-3h-2v3h-3v2h3v3h2v-3h3v-2z",
  search:
    "M10.5 4a6.5 6.5 0 0 1 5.17 10.44l4.45 4.44-1.42 1.42-4.44-4.45A6.5 6.5 0 1 1 10.5 4zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z",
  close: "M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z",
  effect: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2v14a7 7 0 0 1 0-14z",
  external: "M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14zM5 6h6v2H6v10h10v-5h2v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  trash: "M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z",
  replay: "M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z",
  library: "M4 5h2v14H4zm4 0h2v14H8zm4.2.6 1.9-.6 4.7 13.3-1.9.7z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}

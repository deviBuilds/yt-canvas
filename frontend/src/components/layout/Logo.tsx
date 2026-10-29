import { Link } from "../../router/router";

/** yt-canvas's own mark (a play button inside a frame), not YouTube's logo. */
export function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <Link to="/" className="flex h-14 shrink-0 items-center gap-1 pl-4 pr-3.5" aria-label="yt-canvas home" onClick={onClick}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
        <rect x="2" y="5" width="28" height="22" rx="6" fill="none" stroke="#ff5a4e" strokeWidth="3" />
        <path d="M13 11v10l9-5z" fill="#ff5a4e" />
      </svg>
      <span className="hidden text-[19px] font-bold tracking-[-0.04em] sm:inline">yt-canvas</span>
    </Link>
  );
}

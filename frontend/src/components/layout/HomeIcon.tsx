/**
 * The Home glyph, outlined normally and filled when active, as YouTube draws
 * its selected sidebar entry. Same props as the lucide icons it sits beside.
 */
export function HomeIcon({ className, strokeWidth = 1.75, filled = false }: { className?: string; strokeWidth?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        d="M3.5 10.4 12 3.6l8.5 6.8V20.5h-6v-6h-5v6h-6z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 1 : strokeWidth}
        strokeLinejoin="round"
      />
    </svg>
  );
}

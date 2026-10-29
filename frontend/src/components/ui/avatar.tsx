import { Avatar as AvatarPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

const PALETTE = ["#e91e63", "#9c27b0", "#3f51b5", "#03a9f4", "#009688", "#8bc34a", "#ff9800", "#795548", "#607d8b", "#f44336"];

function colorFor(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** A round channel avatar: the channel's picture when known, otherwise its initial. */
export function ChannelAvatar({ name, src, className }: { name: string | null | undefined; src?: string | null; className?: string }) {
  const label = (name ?? "").replace(/^@/, "").trim();
  return (
    <AvatarPrimitive.Root className={cn("relative flex size-9 shrink-0 overflow-hidden rounded-full", className)} aria-hidden="true">
      {src ? <AvatarPrimitive.Image src={src} alt="" referrerPolicy="no-referrer" className="size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback
        className="flex size-full items-center justify-center text-[0.9em] font-medium text-white uppercase"
        style={{ backgroundColor: colorFor(label || "?") }}
        delayMs={src ? 400 : 0}
      >
        {label[0] ?? "?"}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

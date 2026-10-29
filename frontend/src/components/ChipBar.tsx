import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { Link } from "../router/router";

export interface Chip {
  key: string;
  label: string;
  to: string;
  active?: boolean;
}

/** YouTube's row of filter chips: sticky under the top bar, scrolls sideways with arrow buttons. */
export function ChipBar({ chips, label, className }: { chips: Chip[]; label: string; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, chips.length]);

  const scrollBy = (direction: number) => scroller.current?.scrollBy({ left: direction * 300, behavior: "smooth" });

  return (
    <nav aria-label={label} className={cn("sticky top-14 z-20 bg-background/95 py-3 backdrop-blur", className)}>
      <div className="relative">
        {!edges.start ? (
          <div className="absolute inset-y-0 left-0 z-10 flex items-center bg-gradient-to-r from-background from-60% to-transparent pr-8">
            <Button variant="ghost" size="icon" aria-label="Previous chips" onClick={() => scrollBy(-1)}>
              <ChevronLeft />
            </Button>
          </div>
        ) : null}
        <div ref={scroller} onScroll={measure} className="flex gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {chips.map((chip) => (
            <Link
              key={chip.key}
              to={chip.to}
              aria-current={chip.active ? "page" : undefined}
              className={cn(
                "flex h-8 shrink-0 items-center rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors",
                chip.active ? "bg-chip-active text-chip-active-foreground" : "bg-secondary hover:bg-secondary-hover",
              )}
            >
              {chip.label}
            </Link>
          ))}
        </div>
        {!edges.end ? (
          <div className="absolute inset-y-0 right-0 z-10 flex items-center bg-gradient-to-l from-background from-60% to-transparent pl-8">
            <Button variant="ghost" size="icon" aria-label="More chips" onClick={() => scrollBy(1)}>
              <ChevronRight />
            </Button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}

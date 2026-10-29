import { CircleAlert, SearchX } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type { ApiError } from "../api/http";
import type { CardVariant } from "./VideoCard";

// Keep these numbers in sync with GRID_CLASS (Tailwind needs the literal class).
export const GRID_MIN_CARD = 300;
export const GRID_GAP = 16;
export const GRID_CLASS = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-x-4 gap-y-10";

function CardSkeleton({ variant }: { variant: CardVariant }) {
  if (variant === "list") {
    return (
      <div className="flex flex-col gap-4 sm:flex-row" aria-hidden="true">
        <Skeleton className="aspect-video w-full rounded-xl sm:w-90" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-5 w-11/12" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-4 h-4 w-1/4" />
        </div>
      </div>
    );
  }
  if (variant === "compact") {
    return (
      <div className="flex gap-2" aria-hidden="true">
        <Skeleton className="aspect-video w-[168px] shrink-0 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Skeleton className="aspect-video w-full rounded-xl" />
      <div className="flex gap-3">
        <Skeleton className="size-9 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

export function LoadingGrid({
  count = 8,
  label = "Loading videos…",
  variant = "grid",
  className,
}: {
  count?: number;
  label?: string;
  variant?: CardVariant;
  className?: string;
}) {
  return (
    <div
      className={cn(variant === "grid" ? GRID_CLASS : "flex flex-col gap-4", className)}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} variant={variant} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center" role="status">
      <SearchX className="size-12 text-muted-foreground" strokeWidth={1.25} aria-hidden="true" />
      <h2 className="text-xl font-medium">{title}</h2>
      {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-12 text-center" role="alert" data-code={error.info.code}>
      <CircleAlert className="size-12 text-muted-foreground" strokeWidth={1.25} aria-hidden="true" />
      <h2 className="text-xl font-medium">{error.isNetwork ? "Can't reach the server" : "Something went wrong"}</h2>
      <p className="text-sm">{error.message}</p>
      {error.info.hint ? <p className="text-xs text-muted-foreground">{error.info.hint}</p> : null}
      {onRetry ? (
        <Button variant="outline" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

import { Play } from "lucide-react";
import { useCallback } from "react";

import { Button } from "@/components/ui/button";
import { VideoShelf } from "@/components/Shelf";
import { ErrorState, LoadingGrid } from "@/components/StateViews";
import { useCachedRequest } from "@/lib/useCachedRequest";

import { discoveryApi } from "../discovery/api";
import { useQueue } from "../queue/QueueContext";
import { useRouter, watchPath } from "../router/router";

const LABEL = "Demo & test media";

/**
 * Locally generated clips for checking the canvas pipeline without YouTube.
 * Deliberately not linked from the UI: open /demo directly (the e2e tests do).
 */
export function DemoView() {
  const queue = useQueue();
  const { navigate } = useRouter();
  const fetcher = useCallback((signal: AbortSignal) => discoveryApi.demo(signal), []);
  const { data, error, loading, retry } = useCachedRequest("demo", fetcher);
  const items = data?.items ?? [];

  return (
    <div className="px-4 pb-12 sm:px-6">
      {loading ? <LoadingGrid count={3} className="pt-6" /> : null}
      {error ? <ErrorState error={error} onRetry={retry} /> : null}
      {items.length > 0 ? (
        <VideoShelf
          title={LABEL}
          subtitle="Generated locally with FFmpeg, not from YouTube. Use these to check the canvas pipeline without network access."
          items={items}
          onPlay={(video) => queue.playList(items, video, { label: LABEL })}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                const first = items[0]!;
                queue.playList(items, first, { label: LABEL });
                navigate(watchPath(first));
              }}
            >
              <Play className="fill-current" /> Play all
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

import { useCallback } from "react";

import { CanvasPlayer } from "@/player/CanvasPlayer";
import { CanvasEngine } from "@/player/engine/CanvasEngine";
import { mkvSource } from "@/player/engine/mkvReader";
import { useEngineChoice } from "@/player/engine/useEngine";
import type { PlaybackMedia } from "@/player/media";
import { Link, useRouter } from "@/router/router";

/**
 * /play?demo=<id>: plays a demo sample's original file (Matroska or WebM) straight from
 * byte ranges, with nothing prepared first: the path the Plex app uses for files the
 * browser can decode. Not linked from the app; for checking and tests.
 */
export function DirectPlayView() {
  const { params } = useRouter();
  const demo = params.get("demo");
  const engine = useEngineChoice(null);
  const url = demo ? `/api/demo/${encodeURIComponent(demo)}/source` : null;

  const attachSource = useCallback(
    (media: PlaybackMedia) => {
      if (!url || !(media instanceof CanvasEngine)) return () => undefined;
      media.open(mkvSource(url));
      return () => media.close();
    },
    [url],
  );

  return (
    <div className="mx-auto max-w-[960px] px-4 py-6 sm:px-6">
      <h1 className="text-2xl font-bold">Direct play</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Plays a demo sample's original file by reading byte ranges as playback needs them, without preparing it first.
        Try <Link to="/play?demo=bars" className="text-link">bars</Link> (H.264 and AAC in Matroska) or{" "}
        <Link to="/play?demo=sweep" className="text-link">sweep</Link> (VP9 and Opus in WebM).
      </p>
      <div className="mt-4">
        {!url ? (
          <p className="text-sm">Pick a sample above.</p>
        ) : engine.kind !== "webcodecs" ? (
          <p className="text-sm text-danger">Direct play needs WebCodecs, which this browser doesn't have.</p>
        ) : (
          <CanvasPlayer key={url} src={url} engine="webcodecs" attachSource={attachSource} title={`Demo: ${demo}`} />
        )}
      </div>
    </div>
  );
}

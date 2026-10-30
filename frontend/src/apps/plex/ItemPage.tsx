import { Play, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Link } from "@/router/router";

import { formatDuration, itemLabel, plexApi, plexPath, type PlexDetails, type PlexMedia } from "./api";
import { Failure, Grid, Loading } from "./components";
import { useLoad } from "./useLoad";

const CODECS: Record<string, string> = { h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", aac: "AAC", ac3: "AC-3", eac3: "E-AC-3", dca: "DTS", truehd: "TrueHD", mp3: "MP3", opus: "Opus", flac: "FLAC" };
const codec = (name: string | null) => (name ? (CODECS[name] ?? name.toUpperCase()) : null);

function mediaLine(media: PlexMedia): string {
  return [
    media.container?.toUpperCase(),
    [codec(media.video_codec), media.video_resolution && `${media.video_resolution}${/^\d+$/.test(media.video_resolution) ? "p" : ""}`].filter(Boolean).join(" "),
    [codec(media.audio_codec), media.audio_channels && (media.audio_channels === 6 ? "5.1" : media.audio_channels === 8 ? "7.1" : `${media.audio_channels} ch`)].filter(Boolean).join(" "),
    media.bitrate_kbps && `${(media.bitrate_kbps / 1000).toFixed(1)} Mbit/s`,
  ].filter(Boolean).join(" · ");
}

function PlayButtons({ item }: { item: PlexDetails }) {
  const watch = plexPath("watch", item.key);
  const offset = item.view_offset_seconds;
  return (
    <div className="mt-5 flex flex-wrap gap-3">
      <Button asChild variant="primary">
        <Link to={offset ? `${watch}?t=${offset}` : watch}>
          <Play /> {offset ? `Resume from ${formatDuration(offset) || `${offset} s`}` : "Play"}
        </Link>
      </Button>
      {offset ? (
        <Button asChild>
          <Link to={`${watch}?t=0`}>
            <RotateCcw /> From the start
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

export function PlexItemPage({ itemKey }: { itemKey: string }) {
  const { data: item, error, retry } = useLoad((signal) => plexApi.item(itemKey, signal), [itemKey], `item:${itemKey}`);
  if (error) return <Failure message={error} onRetry={retry} />;
  if (!item) return <Loading />;
  const playable = item.type === "movie" || item.type === "episode";
  const media = item.media[0];
  const audio = media?.streams.filter((s) => s.kind === "audio") ?? [];
  const subtitles = media?.streams.filter((s) => s.kind === "subtitle") ?? [];
  return (
    <article className="mt-6">
      {item.art && (
        <div className="relative -mx-4 mb-6 h-48 overflow-hidden sm:-mx-6 sm:h-72">
          <img src={item.art} alt="" className="size-full object-cover opacity-50" />
          <div className="absolute inset-0 bg-gradient-to-t from-background to-transparent" />
        </div>
      )}
      <div className="flex flex-col gap-6 sm:flex-row">
        {(item.poster || item.still) && (
          <img
            src={(item.type === "episode" ? item.still : item.poster) ?? item.poster ?? ""}
            alt=""
            className={`shrink-0 rounded-lg ${item.type === "episode" ? "w-full sm:w-80" : "w-40 sm:w-52"}`}
          />
        )}
        <div className="min-w-0">
          {item.show_title && <p className="text-sm text-muted-foreground">{item.show_title}</p>}
          <h1 className="text-3xl font-bold">{item.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[itemLabel(item), formatDuration(item.duration_seconds), item.content_rating, item.audience_rating && `★ ${item.audience_rating.toFixed(1)}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {item.tagline && <p className="mt-3 italic">{item.tagline}</p>}
          {item.summary && <p className="mt-3 max-w-3xl leading-relaxed">{item.summary}</p>}
          {item.genres.length > 0 && <p className="mt-3 text-sm text-muted-foreground">{item.genres.join(", ")}</p>}
          {playable && <PlayButtons item={item} />}
          {media && (
            <dl className="mt-5 grid max-w-3xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">File</dt>
              <dd>{mediaLine(media)}</dd>
              {audio.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Audio</dt>
                  <dd>{audio.map((s) => s.title ?? codec(s.codec)).join(", ")}</dd>
                </>
              )}
              {subtitles.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Subtitles</dt>
                  <dd>{subtitles.map((s) => s.language ?? s.title ?? codec(s.codec)).join(", ")}</dd>
                </>
              )}
            </dl>
          )}
          {item.cast.length > 0 && <p className="mt-4 max-w-3xl text-sm text-muted-foreground">With {item.cast.join(", ")}</p>}
        </div>
      </div>
      {item.children.length > 0 && (
        <section className="mt-10" aria-label={item.type === "show" ? "Seasons" : "Episodes"}>
          <h2 className="mb-3 text-xl font-semibold">{item.type === "show" ? "Seasons" : "Episodes"}</h2>
          <Grid items={item.children} />
        </section>
      )}
    </article>
  );
}

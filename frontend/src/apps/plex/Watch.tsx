import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { CanvasPlayer } from "@/player/CanvasPlayer";
import { CanvasEngine } from "@/player/engine/CanvasEngine";
import { useEngineChoice } from "@/player/engine/useEngine";
import type { PlaybackMedia } from "@/player/media";
import { selectClass } from "@/player/PlayerControls";
import { Link, useRouter } from "@/router/router";

import { plexApi, plexPath, type PlayResponse } from "./api";
import { Failure, Loading } from "./components";
import { detectCapabilities, QUALITIES, savedQuality, saveQuality, sourceFor } from "./playback";
import { useLoad } from "./useLoad";

const REPORT_EVERY_MS = 10_000;
const PING_EVERY_MS = 30_000;

/**
 * Plays a Plex movie or episode in the canvas player. The backend decides between the
 * original file (direct play) and Plex's transcoder; either way frames are decoded with
 * WebCodecs and drawn on the canvas. Progress goes back to Plex.
 */
export function PlexWatch({ itemKey }: { itemKey: string }) {
  const { params } = useRouter();
  const ids = useId();
  const engine = useEngineChoice(null);
  const item = useLoad((signal) => plexApi.item(itemKey, signal), [itemKey]);
  const [quality, setQuality] = useState<number | null>(savedQuality);
  const [audioStream, setAudioStream] = useState<number | null>(null);
  const [play, setPlay] = useState<PlayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(() => {
    const t = params.get("t");
    return t !== null && /^\d+$/.test(t) ? Number(t) : null;
  });
  const position = useRef({ time: 0, duration: null as number | null, paused: true, reported: 0 });

  // Ask the backend how to play it whenever the item, quality or audio track changes.
  useEffect(() => {
    let live = true;
    setPlay(null);
    setError(null);
    void detectCapabilities()
      .then((capabilities) => plexApi.play({ key: itemKey, audio_stream: audioStream, max_bitrate_kbps: quality, capabilities }))
      .then(
        (response) => {
          if (!live) return void plexApi.stop(response.session).catch(() => undefined);
          setPlay(response);
          setStartTime((current) => current ?? response.view_offset_seconds);
        },
        (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      live = false;
    };
  }, [itemKey, quality, audioStream, attempt]);

  // Keep a transcode alive while it's open; stop it and report where we got to when leaving.
  useEffect(() => {
    if (!play) return;
    const ping = play.mode === "transcode" ? window.setInterval(() => void plexApi.ping(play.session).catch(() => undefined), PING_EVERY_MS) : 0;
    return () => {
      window.clearInterval(ping);
      const { time, duration } = position.current;
      if (time > 0) void plexApi.timeline({ key: itemKey, state: "stopped", time, duration, session: play.session }).catch(() => undefined);
      void plexApi.stop(play.session).catch(() => undefined);
    };
  }, [play, itemKey]);

  const onTimeUpdate = useCallback(
    (time: number, duration: number | null, paused: boolean) => {
      const state = position.current;
      const justPaused = paused && !state.paused;
      state.time = time;
      state.duration = duration;
      state.paused = paused;
      const now = Date.now();
      if (!justPaused && (paused || now - state.reported < REPORT_EVERY_MS)) return;
      state.reported = now;
      void plexApi.timeline({ key: itemKey, state: paused ? "paused" : "playing", time, duration, session: play?.session ?? null }).catch(() => undefined);
    },
    [itemKey, play],
  );

  const attachSource = useCallback(
    (media: PlaybackMedia) => {
      if (!play || !(media instanceof CanvasEngine)) return () => undefined;
      media.open(
        sourceFor(play, (err) => {
          setError(err instanceof Error ? err.message : "Playback stopped unexpectedly.");
          return true;
        }),
      );
      return () => media.close();
    },
    [play],
  );

  // Switching quality or audio restarts playback; carry on from here.
  const keepPosition = () => {
    if (position.current.time > 1) setStartTime(Math.floor(position.current.time));
  };
  const details = item.data;
  const audio = details?.media[0]?.streams.filter((s) => s.kind === "audio") ?? [];
  const settings = (
    <>
      <div className="flex items-center justify-between gap-3 py-1.5">
        <label htmlFor={`${ids}-quality`}>Quality</label>
        <select
          id={`${ids}-quality`}
          className={selectClass}
          value={quality === null ? "original" : String(quality)}
          onChange={(event) => {
            const value = event.currentTarget.value === "original" ? null : Number(event.currentTarget.value);
            keepPosition();
            saveQuality(value);
            setQuality(value);
          }}
        >
          {QUALITIES.map((option) => (
            <option key={option.label} value={option.value === null ? "original" : String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {audio.length > 1 && (
        <div className="flex items-center justify-between gap-3 py-1.5">
          <label htmlFor={`${ids}-audio`}>Audio</label>
          <select
            id={`${ids}-audio`}
            className={selectClass}
            value={String(audioStream ?? audio.find((s) => s.selected)?.id ?? audio[0]!.id)}
            onChange={(event) => {
              keepPosition();
              setAudioStream(Number(event.currentTarget.value));
            }}
          >
            {audio.map((stream) => (
              <option key={stream.id} value={String(stream.id)}>
                {stream.title ?? stream.language ?? stream.codec}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );

  if (engine.kind !== "webcodecs") return <Failure message="Plex playback needs WebCodecs, which this browser doesn't have." />;
  const back = plexPath("item", itemKey);
  return (
    <div className="mt-4">
      <Link to={back} className="mb-3 inline-flex items-center gap-1 text-sm text-link">
        <ArrowLeft className="size-4" aria-hidden="true" /> {details?.title ?? "Back"}
      </Link>
      {error ? (
        <Failure message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !play ? (
        <Loading>Starting playback…</Loading>
      ) : (
        <>
          <CanvasPlayer
            key={play.session}
            engine="webcodecs"
            src={play.url}
            attachSource={attachSource}
            settings={settings}
            title={details?.title ?? "Plex"}
            artist={details?.show_title ?? undefined}
            startTime={startTime}
            autoPlay
            globalShortcuts
            onTimeUpdate={onTimeUpdate}
          />
          <p className="mt-3 text-sm text-muted-foreground" data-testid="plex-playback">
            {play.mode === "direct" ? "Direct play: " : "Through Plex: "}
            {play.reason} Decoded with WebCodecs and drawn on the canvas.
          </p>
        </>
      )}
    </div>
  );
}

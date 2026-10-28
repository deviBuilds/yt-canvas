import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Icon } from "../components/Icon";
import { CanvasRenderer } from "./CanvasRenderer";
import type { EffectId } from "./effects";
import { PlayerControls } from "./PlayerControls";
import { loadPrefs, PLAYBACK_RATES, savePrefs, type PlayerPrefs } from "./prefs";
import { actionForKey, type PlayerAction } from "./shortcuts";
import { fitContain, type Size } from "./sizing";
import { useMediaState } from "./useMediaState";

/**
 * How the decoding <video> element is kept out of sight.
 *
 * - "layered" (default): same box as the canvas, underneath it, opacity 0. It
 *   stays laid out and on-screen, so browsers keep decoding and presenting
 *   frames (and firing rVFC), but it is never visible.
 * - "covered": opaque but under the opaque canvas (diagnostics only).
 * - "offscreen": a 2×2 px element far off-screen (diagnostics only).
 * - "hidden": display:none — browsers differ here, so it is not the default.
 */
export type DecoderStrategy = "layered" | "covered" | "offscreen" | "hidden";

export interface CanvasPlayerProps {
  /** Same-origin URL of a prepared MP4, or null while there is nothing to play. */
  src: string | null;
  title?: string;
  artist?: string;
  autoPlay?: boolean;
  /** Seek here once the new source's metadata is known. */
  startTime?: number | null;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onTimeUpdate?: (time: number, duration: number | null, paused: boolean) => void;
  onEnded?: () => void;
  onRetry?: () => void;
  /** Shown over the stage while there is no source (e.g. preparation progress). */
  overlay?: ReactNode;
  badge?: ReactNode;
  /** Listen for shortcuts on the whole document instead of only when the player has focus. */
  globalShortcuts?: boolean;
  decoderStrategy?: DecoderStrategy;
  forceFallback?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function CanvasPlayer(props: CanvasPlayerProps) {
  const {
    src,
    title,
    hasPrevious = false,
    hasNext = false,
    overlay,
    badge,
    globalShortcuts = false,
    decoderStrategy = "layered",
    forceFallback = false,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const boxRef = useRef<Size>({ width: 0, height: 0 });
  const pendingStart = useRef<number | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  // A state-backed ref so hooks re-run once the element exists.
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [media, syncMedia] = useMediaState(video);
  const [prefs, setPrefs] = useState<PlayerPrefs>(loadPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [needsGesture, setNeedsGesture] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);
  const [canvasBox, setCanvasBox] = useState<Size>({ width: 0, height: 0 });

  // -- renderer lifecycle: exactly one renderer per (video, canvas) ------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    video.disablePictureInPicture = true;
    (video as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    let lastSync = 0;
    const renderer = new CanvasRenderer(video, canvas, {
      effect: prefsRef.current.effect,
      forceFallback,
      onFrame: () => {
        const now = performance.now();
        if (now - lastSync > 100) {
          lastSync = now;
          syncMedia();
        }
      },
      onDrawError: (error) => {
        const name = error instanceof DOMException ? error.name : "";
        setDrawError(
          name === "SecurityError"
            ? "The browser blocked reading this media into the canvas (cross-origin)."
            : "Drawing the video into the canvas failed.",
        );
      },
    });
    rendererRef.current = renderer;
    if (boxRef.current.width > 0) renderer.setDisplaySize(boxRef.current, window.devicePixelRatio || 1);
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [video, forceFallback, syncMedia]);

  // -- preferences ----------------------------------------------------------------
  useEffect(() => {
    if (!video) return;
    video.volume = prefs.volume;
    video.muted = prefs.muted;
    video.defaultPlaybackRate = prefs.rate;
    video.playbackRate = prefs.rate;
    savePrefs(prefs);
  }, [video, prefs]);

  useEffect(() => {
    rendererRef.current?.setEffect(prefs.effect);
  }, [prefs.effect]);

  // -- playback -----------------------------------------------------------------
  const tryPlay = useCallback(() => {
    if (!video || !video.getAttribute("src")) return;
    const attempt = video.play();
    if (!attempt) return;
    attempt.then(
      () => setNeedsGesture(false),
      (error: unknown) => {
        // NotAllowedError: autoplay policy wants a user gesture. AbortError: superseded.
        if (error instanceof DOMException && error.name === "NotAllowedError") setNeedsGesture(true);
      },
    );
  }, [video]);

  // -- source changes -------------------------------------------------------------
  useEffect(() => {
    if (!video) return;
    setNeedsGesture(false);
    setDrawError(null);
    if (!src) {
      if (video.getAttribute("src")) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      return;
    }
    pendingStart.current = latest.current.startTime ?? null;
    const onMetadata = () => {
      const start = pendingStart.current;
      pendingStart.current = null;
      if (start && start > 0 && Number.isFinite(video.duration) && start < video.duration - 1) {
        video.currentTime = start;
      }
      if (latest.current.autoPlay ?? true) tryPlay();
    };
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    video.src = src;
    video.load();
    return () => video.removeEventListener("loadedmetadata", onMetadata);
  }, [video, src, tryPlay]);

  // Release the decoder when the player unmounts.
  useEffect(() => {
    if (!video) return;
    return () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [video]);

  useEffect(() => {
    if (!video) return;
    const onEnded = () => latest.current.onEnded?.();
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [video]);

  useEffect(() => {
    if (src && media.phase === "ready") {
      latest.current.onTimeUpdate?.(media.currentTime, media.duration || null, media.paused);
    }
  }, [src, media.phase, media.currentTime, media.duration, media.paused]);

  // -- sizing: keep the canvas box at the video's aspect ratio inside the stage ----
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const aspect = video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const box = fitContain({ width: rect.width, height: rect.height }, aspect);
    boxRef.current = box;
    setCanvasBox((prev) => (prev.width === box.width && prev.height === box.height ? prev : box));
    rendererRef.current?.setDisplaySize(box, window.devicePixelRatio || 1);
  }, [video]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(stage);
    window.addEventListener("resize", measure);
    video?.addEventListener("loadedmetadata", measure);
    video?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      video?.removeEventListener("loadedmetadata", measure);
      video?.removeEventListener("resize", measure);
    };
  }, [video, measure]);

  // -- fullscreen ---------------------------------------------------------------------
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (pseudoFullscreen) {
      setPseudoFullscreen(false);
    } else if (document.fullscreenEnabled && typeof root.requestFullscreen === "function") {
      root.requestFullscreen().catch(() => setPseudoFullscreen(true));
    } else {
      // e.g. iPhone Safari: element fullscreen is unavailable, so fill the viewport instead.
      setPseudoFullscreen(true);
    }
  }, [pseudoFullscreen]);

  useEffect(() => {
    // The layout changes size in and out of fullscreen.
    requestAnimationFrame(measure);
  }, [fullscreen, pseudoFullscreen, measure]);

  // -- actions --------------------------------------------------------------------------
  const seek = useCallback(
    (seconds: number) => {
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      video.currentTime = clamp(seconds, 0, video.duration);
      syncMedia();
    },
    [video, syncMedia],
  );

  const togglePlay = useCallback(() => {
    if (!video || !src) return;
    if (video.paused || video.ended) tryPlay();
    else video.pause();
  }, [video, src, tryPlay]);

  const setVolume = useCallback((volume: number) => {
    setPrefs((p) => ({ ...p, volume: clamp(volume, 0, 1), muted: volume > 0 ? false : p.muted }));
  }, []);
  const toggleMute = useCallback(() => setPrefs((p) => ({ ...p, muted: !p.muted })), []);
  const setRate = useCallback((rate: number) => setPrefs((p) => ({ ...p, rate })), []);
  const setEffect = useCallback(
    (effect: EffectId) => setPrefs((p) => ({ ...p, effect, toggleEffect: effect === "none" ? p.toggleEffect : effect })),
    [],
  );
  const toggleEffect = useCallback(
    () => setPrefs((p) => ({ ...p, effect: p.effect === "none" ? p.toggleEffect : "none" })),
    [],
  );

  const runAction = useCallback(
    (action: PlayerAction) => {
      switch (action.type) {
        case "toggle":
          return togglePlay();
        case "seekBy":
          return video ? seek(video.currentTime + action.seconds) : undefined;
        case "seekTo":
          return seek(action.seconds === "end" ? (video?.duration ?? 0) : action.seconds);
        case "seekToFraction":
          return video ? seek(video.duration * action.fraction) : undefined;
        case "volumeBy":
          return setVolume((prefsRef.current.muted ? 0 : prefsRef.current.volume) + action.delta);
        case "toggleMute":
          return toggleMute();
        case "toggleFullscreen":
          return toggleFullscreen();
        case "toggleEffect":
          return toggleEffect();
        case "rateStep": {
          const index = PLAYBACK_RATES.indexOf(prefsRef.current.rate as (typeof PLAYBACK_RATES)[number]);
          const next = PLAYBACK_RATES[clamp((index < 0 ? 3 : index) + action.direction, 0, PLAYBACK_RATES.length - 1)];
          return next ? setRate(next) : undefined;
        }
        case "next":
          return latest.current.hasNext ? latest.current.onNext?.() : undefined;
        case "previous":
          return latest.current.hasPrevious ? latest.current.onPrevious?.() : undefined;
      }
    },
    [video, seek, togglePlay, setVolume, toggleMute, toggleFullscreen, toggleEffect, setRate],
  );

  const poke = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2500);
  }, []);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape" && pseudoFullscreen) {
        setPseudoFullscreen(false);
        return;
      }
      const action = actionForKey(event);
      if (!action) return;
      event.preventDefault();
      runAction(action);
      poke();
    },
    [runAction, poke, pseudoFullscreen],
  );

  useEffect(() => {
    if (!globalShortcuts) return;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [globalShortcuts, onKey]);

  // -- media session (hardware keys, lock screen) ------------------------------------------
  useEffect(() => {
    if (!src || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if (typeof MediaMetadata !== "undefined") {
      session.metadata = new MediaMetadata({ title: title ?? "yt-canvas", artist: latest.current.artist ?? "" });
    }
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => tryPlay()],
      ["pause", () => video?.pause()],
      ["seekbackward", () => runAction({ type: "seekBy", seconds: -10 })],
      ["seekforward", () => runAction({ type: "seekBy", seconds: 10 })],
      ["previoustrack", () => runAction({ type: "previous" })],
      ["nexttrack", () => runAction({ type: "next" })],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Unsupported action in this browser.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [src, title, video, tryPlay, runAction]);

  // -- render ----------------------------------------------------------------------------
  const playing = !media.paused && !media.ended;
  const showSpinner = Boolean(src) && !needsGesture && media.phase !== "error" && (media.phase === "loading" || media.waiting);
  const onStageClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget || event.target === canvasRef.current) togglePlay();
  };

  return (
    <div
      ref={rootRef}
      className={`player${pseudoFullscreen ? " pseudo-fullscreen" : ""}${fullscreen ? " is-fullscreen" : ""}`}
      data-idle={idle && playing ? "true" : "false"}
      data-state={media.phase}
      onPointerMove={poke}
      onPointerDown={poke}
      onKeyDown={globalShortcuts ? undefined : (event) => onKey(event.nativeEvent)}
    >
      <div ref={stageRef} className="stage" onClick={onStageClick} onDoubleClick={toggleFullscreen}>
        <video ref={setVideo} className={`decoder decoder-${decoderStrategy}`} playsInline preload="auto" aria-hidden="true" tabIndex={-1} />
        <canvas
          ref={canvasRef}
          className="screen"
          role="img"
          aria-label={title ? `Video: ${title}` : "Video"}
          data-testid="video-canvas"
          style={canvasBox.width > 0 ? { width: canvasBox.width, height: canvasBox.height } : undefined}
        />

        {badge ? <div className="stage-badge">{badge}</div> : null}

        {!src && overlay ? <div className="stage-overlay">{overlay}</div> : null}

        {showSpinner ? (
          <div className="stage-overlay passive" role="status" aria-live="polite">
            <span className="spinner" />
            <span className="sr-only">{media.waiting ? "Buffering…" : "Loading video…"}</span>
          </div>
        ) : null}

        {src && media.phase === "error" ? (
          <div className="stage-overlay" role="alert">
            <div className="overlay-card">
              <h3>Playback error</h3>
              <p>{media.error}</p>
              {props.onRetry ? (
                <button type="button" className="button" onClick={props.onRetry}>
                  Prepare again
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {drawError ? (
          <div className="stage-overlay" role="alert">
            <div className="overlay-card">
              <h3>Canvas rendering failed</h3>
              <p>{drawError}</p>
            </div>
          </div>
        ) : null}

        {needsGesture ? (
          <div className="stage-overlay">
            <button type="button" className="big-play" onClick={tryPlay} aria-label="Play video">
              <Icon name="play" size={40} />
              <span>Click to play</span>
            </button>
          </div>
        ) : null}
      </div>

      <PlayerControls
        media={media}
        disabled={!src || media.phase === "empty"}
        effect={prefs.effect}
        toggleEffect={prefs.toggleEffect}
        fullscreen={fullscreen || pseudoFullscreen}
        hasPrevious={hasPrevious}
        hasNext={hasNext}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onVolume={setVolume}
        onToggleMute={toggleMute}
        onRate={setRate}
        onEffect={setEffect}
        onToggleEffect={toggleEffect}
        onToggleFullscreen={toggleFullscreen}
        onPrevious={props.onPrevious}
        onNext={props.onNext}
      />
    </div>
  );
}

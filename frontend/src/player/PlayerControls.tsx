import { Maximize, Minimize, Pause, Play, Settings, SkipBack, SkipForward, Sparkles, Volume1, Volume2, VolumeX } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { formatTime } from "../lib/format";
import { EFFECTS, getEffect, type EffectId } from "./effects";
import { PLAYBACK_RATES } from "./prefs";
import type { MediaState } from "./useMediaState";

export interface PlayerControlsProps {
  media: MediaState;
  disabled: boolean;
  effect: EffectId;
  toggleEffect: Exclude<EffectId, "none">;
  fullscreen: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onRate: (rate: number) => void;
  onEffect: (effect: EffectId) => void;
  onToggleEffect: () => void;
  onToggleFullscreen: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}

function ControlButton({
  label,
  title,
  children,
  className,
  ...rest
}: {
  label: string;
  title?: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      className={cn(
        "flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-white opacity-90 transition hover:opacity-100 disabled:cursor-default disabled:opacity-40 [&_svg]:size-6",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const selectClass =
  "h-8 cursor-pointer rounded-md border border-white/20 bg-[#1f1f1f] px-2 text-sm text-white outline-none focus-visible:border-white";

export function PlayerControls(props: PlayerControlsProps) {
  const { media, disabled } = props;
  const ids = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const duration = media.duration;
  const playing = !media.paused && !media.ended;
  const progress = duration > 0 ? (media.currentTime / duration) * 100 : 0;
  const buffered = duration > 0 ? (media.bufferedEnd / duration) * 100 : 0;
  const volume = media.muted ? 0 : media.volume;
  const effectOn = props.effect !== "none";
  const effectLabel = effectOn ? getEffect(props.effect).label : getEffect(props.toggleEffect).label;
  const VolumeIcon = media.muted || media.volume === 0 ? VolumeX : media.volume < 0.5 ? Volume1 : Volume2;

  // Close the settings panel on outside clicks and Escape, like YouTube's gear menu.
  useEffect(() => {
    if (!settingsOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setSettingsOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [settingsOpen]);

  return (
    <div className="controls" role="group" aria-label="Player controls">
      <input
        type="range"
        className="range seek-input"
        aria-label="Seek"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(media.currentTime, duration || 0)}
        aria-valuetext={`${formatTime(media.currentTime)} of ${formatTime(duration)}`}
        disabled={disabled || duration <= 0}
        style={{ "--progress": `${progress}%`, "--buffered": `${buffered}%` } as CSSProperties}
        onChange={(event) => props.onSeek(Number(event.currentTarget.value))}
      />

      <div className="flex items-center justify-between gap-1">
        <div className="flex min-w-0 items-center">
          <ControlButton label="Previous video" title="Previous (Shift+P)" disabled={!props.hasPrevious} onClick={props.onPrevious}>
            <SkipBack className="fill-current" />
          </ControlButton>
          <ControlButton
            label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (K)" : "Play (K)"}
            disabled={disabled}
            onClick={props.onTogglePlay}
            className="size-12 [&_svg]:size-7"
          >
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </ControlButton>
          <ControlButton label="Next video" title="Next (Shift+N)" disabled={!props.hasNext} onClick={props.onNext}>
            <SkipForward className="fill-current" />
          </ControlButton>

          <div className="group/volume flex items-center">
            <ControlButton label={media.muted ? "Unmute" : "Mute"} title={media.muted ? "Unmute (M)" : "Mute (M)"} onClick={props.onToggleMute}>
              <VolumeIcon />
            </ControlButton>
            <input
              type="range"
              className="range volume-input max-sm:hidden"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              aria-valuetext={`${Math.round(volume * 100)}%`}
              style={{ "--progress": `${volume * 100}%` } as CSSProperties}
              onChange={(event) => props.onVolume(Number(event.currentTarget.value))}
            />
          </div>

          <span className="ml-3 whitespace-nowrap text-[13px] tabular-nums text-white/90" aria-live="off">
            <span>{formatTime(media.currentTime)}</span>
            <span className="text-white/70"> / </span>
            <span className="text-white/70">{formatTime(duration)}</span>
          </span>
        </div>

        <div className="flex shrink-0 items-center">
          <ControlButton
            label={`Effect: ${effectLabel}`}
            title={`${effectLabel} effect (G)`}
            aria-pressed={effectOn}
            onClick={props.onToggleEffect}
            className={cn(effectOn && "text-[#ffd54f]")}
          >
            <Sparkles className={cn(effectOn && "fill-current")} />
          </ControlButton>

          <div ref={settingsRef} className="relative" data-open={settingsOpen ? "true" : "false"}>
            <ControlButton
              label="Settings"
              title="Settings"
              aria-expanded={settingsOpen}
              aria-controls={`${ids}-settings`}
              onClick={() => setSettingsOpen((open) => !open)}
              className={cn("[&_svg]:transition-transform", settingsOpen && "[&_svg]:rotate-45")}
            >
              <Settings />
            </ControlButton>
            <div
              id={`${ids}-settings`}
              hidden={!settingsOpen}
              className="absolute bottom-12 right-0 z-10 w-64 rounded-xl bg-[#1c1c1c]/95 p-3 text-sm text-white shadow-2xl"
            >
              <div className="flex items-center justify-between gap-3 py-1.5">
                <label htmlFor={`${ids}-rate`}>Playback speed</label>
                <select
                  id={`${ids}-rate`}
                  className={selectClass}
                  value={String(media.rate)}
                  onChange={(event) => props.onRate(Number(event.currentTarget.value))}
                >
                  {PLAYBACK_RATES.map((rate) => (
                    <option key={rate} value={String(rate)}>
                      {rate === 1 ? "Normal" : `${rate}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-3 py-1.5">
                <label htmlFor={`${ids}-effect`}>Visual effect</label>
                <select
                  id={`${ids}-effect`}
                  className={selectClass}
                  value={props.effect}
                  onChange={(event) => props.onEffect(event.currentTarget.value as EffectId)}
                >
                  {EFFECTS.map((effect) => (
                    <option key={effect.id} value={effect.id}>
                      {effect.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <ControlButton
            label={props.fullscreen ? "Exit full screen" : "Full screen"}
            title="Full screen (F)"
            onClick={props.onToggleFullscreen}
          >
            {props.fullscreen ? <Minimize /> : <Maximize />}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

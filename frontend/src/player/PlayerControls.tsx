import { useId, type CSSProperties } from "react";

import { Icon } from "../components/Icon";
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

export function PlayerControls(props: PlayerControlsProps) {
  const { media, disabled } = props;
  const ids = useId();
  const duration = media.duration;
  const playing = !media.paused && !media.ended;
  const progress = duration > 0 ? (media.currentTime / duration) * 100 : 0;
  const buffered = duration > 0 ? (media.bufferedEnd / duration) * 100 : 0;
  const volume = media.muted ? 0 : media.volume;
  const effectOn = props.effect !== "none";

  return (
    <div className="controls" role="group" aria-label="Player controls">
      <div className="seek" style={{ "--progress": `${progress}%`, "--buffered": `${buffered}%` } as CSSProperties}>
        <input
          type="range"
          className="seek-input"
          aria-label="Seek"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(media.currentTime, duration || 0)}
          aria-valuetext={`${formatTime(media.currentTime)} of ${formatTime(duration)}`}
          disabled={disabled || duration <= 0}
          onChange={(event) => props.onSeek(Number(event.currentTarget.value))}
        />
      </div>

      <div className="controls-row">
        <div className="controls-group">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous video"
            title="Previous (Shift+P)"
            disabled={!props.hasPrevious}
            onClick={props.onPrevious}
          >
            <Icon name="previous" />
          </button>
          <button
            type="button"
            className="icon-button primary"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (K)" : "Play (K)"}
            disabled={disabled}
            onClick={props.onTogglePlay}
          >
            <Icon name={playing ? "pause" : "play"} size={24} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next video"
            title="Next (Shift+N)"
            disabled={!props.hasNext}
            onClick={props.onNext}
          >
            <Icon name="next" />
          </button>

          <div className="volume">
            <button
              type="button"
              className="icon-button"
              aria-label={media.muted ? "Unmute" : "Mute"}
              title={media.muted ? "Unmute (M)" : "Mute (M)"}
              onClick={props.onToggleMute}
            >
              <Icon name={media.muted || media.volume === 0 ? "muted" : "volume"} />
            </button>
            <input
              type="range"
              className="volume-input"
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

          <span className="time" aria-live="off">
            <span>{formatTime(media.currentTime)}</span>
            <span className="time-sep"> / </span>
            <span>{formatTime(duration)}</span>
          </span>
        </div>

        <div className="controls-group">
          <button
            type="button"
            className={`chip-button${effectOn ? " active" : ""}`}
            aria-pressed={effectOn}
            title="Toggle visual effect (G)"
            onClick={props.onToggleEffect}
          >
            <Icon name="effect" size={18} />
            <span>{effectOn ? getEffect(props.effect).label : getEffect(props.toggleEffect).label}</span>
          </button>

          <label className="sr-only" htmlFor={`${ids}-effect`}>
            Visual effect
          </label>
          <select
            id={`${ids}-effect`}
            className="control-select"
            value={props.effect}
            onChange={(event) => props.onEffect(event.currentTarget.value as EffectId)}
          >
            {EFFECTS.map((effect) => (
              <option key={effect.id} value={effect.id}>
                {effect.label}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor={`${ids}-rate`}>
            Playback speed
          </label>
          <select
            id={`${ids}-rate`}
            className="control-select"
            value={String(media.rate)}
            onChange={(event) => props.onRate(Number(event.currentTarget.value))}
          >
            {PLAYBACK_RATES.map((rate) => (
              <option key={rate} value={String(rate)}>
                {rate === 1 ? "1× speed" : `${rate}×`}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="icon-button"
            aria-label={props.fullscreen ? "Exit full screen" : "Full screen"}
            title="Full screen (F)"
            onClick={props.onToggleFullscreen}
          >
            <Icon name={props.fullscreen ? "exitFullscreen" : "fullscreen"} />
          </button>
        </div>
      </div>
    </div>
  );
}

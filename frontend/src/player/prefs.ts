import { readJson, writeJson } from "../library/storage";
import { isEffectId, type EffectId } from "./effects";

export const PLAYER_PREFS_KEY = "ytc.player.v1";
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export interface PlayerPrefs {
  volume: number;
  muted: boolean;
  rate: number;
  effect: EffectId;
  /** The effect the toggle button switches on (remembers the last non-"none" choice). */
  toggleEffect: Exclude<EffectId, "none">;
}

export const DEFAULT_PREFS: PlayerPrefs = { volume: 1, muted: false, rate: 1, effect: "none", toggleEffect: "grayscale" };

export function loadPrefs(): PlayerPrefs {
  return readJson(
    PLAYER_PREFS_KEY,
    (value) => {
      const v = value as Partial<PlayerPrefs> | null;
      if (!v || typeof v !== "object") return null;
      return {
        volume: typeof v.volume === "number" && v.volume >= 0 && v.volume <= 1 ? v.volume : 1,
        muted: v.muted === true,
        rate: PLAYBACK_RATES.includes(v.rate as (typeof PLAYBACK_RATES)[number]) ? (v.rate as number) : 1,
        effect: isEffectId(v.effect) ? v.effect : "none",
        toggleEffect: isEffectId(v.toggleEffect) && (v.toggleEffect as EffectId) !== "none" ? v.toggleEffect : "grayscale",
      };
    },
    DEFAULT_PREFS,
  );
}

export function savePrefs(prefs: PlayerPrefs): void {
  writeJson(PLAYER_PREFS_KEY, prefs);
}

export type PlayerAction =
  | { type: "toggle" }
  | { type: "seekBy"; seconds: number }
  | { type: "seekToFraction"; fraction: number }
  | { type: "seekTo"; seconds: number | "end" }
  | { type: "volumeBy"; delta: number }
  | { type: "toggleMute" }
  | { type: "toggleFullscreen" }
  | { type: "toggleEffect" }
  | { type: "rateStep"; direction: 1 | -1 }
  | { type: "next" }
  | { type: "previous" };

export const SHORTCUT_HELP: ReadonlyArray<[string, string]> = [
  ["Space / K", "Play or pause"],
  ["← / →", "Back / forward 5 s"],
  ["J / L", "Back / forward 10 s"],
  ["↑ / ↓", "Volume"],
  ["M", "Mute"],
  ["F", "Full screen"],
  ["G", "Toggle visual effect"],
  ["< / >", "Slower / faster"],
  ["0–9", "Jump to 0–90 %"],
  ["Shift+N / Shift+P", "Next / previous video"],
];

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !["range", "checkbox", "radio", "button"].includes(target.type);
  return false;
}

/**
 * Map a keydown to a player action, or ``null`` to leave the event alone.
 *
 * Native controls keep their own keys: Space/Enter on a focused button, and
 * arrow keys on a focused slider, are not intercepted.
 */
export function actionForKey(event: KeyboardEvent): PlayerAction | null {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (isTextEntry(target)) return null;
  const onButton = target instanceof HTMLButtonElement || (target instanceof HTMLElement && target.getAttribute("role") === "button");
  const onSlider = target instanceof HTMLInputElement && target.type === "range";

  switch (event.key) {
    case " ":
    case "Spacebar":
      return onButton || onSlider ? null : { type: "toggle" };
    case "k":
    case "K":
      return { type: "toggle" };
    case "ArrowLeft":
      return onSlider ? null : { type: "seekBy", seconds: -5 };
    case "ArrowRight":
      return onSlider ? null : { type: "seekBy", seconds: 5 };
    case "j":
    case "J":
      return { type: "seekBy", seconds: -10 };
    case "l":
    case "L":
      return { type: "seekBy", seconds: 10 };
    case "ArrowUp":
      return onSlider ? null : { type: "volumeBy", delta: 0.05 };
    case "ArrowDown":
      return onSlider ? null : { type: "volumeBy", delta: -0.05 };
    case "m":
    case "M":
      return { type: "toggleMute" };
    case "f":
    case "F":
      return { type: "toggleFullscreen" };
    case "g":
    case "G":
      return { type: "toggleEffect" };
    case ">":
      return { type: "rateStep", direction: 1 };
    case "<":
      return { type: "rateStep", direction: -1 };
    case "Home":
      return onSlider ? null : { type: "seekTo", seconds: 0 };
    case "End":
      return onSlider ? null : { type: "seekTo", seconds: "end" };
    case "N":
      return event.shiftKey ? { type: "next" } : null;
    case "P":
      return event.shiftKey ? { type: "previous" } : null;
    default:
      // Digits have no native meaning on a slider, so they work everywhere.
      if (/^[0-9]$/.test(event.key)) return { type: "seekToFraction", fraction: Number(event.key) / 10 };
      return null;
  }
}

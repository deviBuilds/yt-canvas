/**
 * Signals a car's browser could give about whether the car is moving, for the planned drive
 * lock (video only when stopped, audio always). Neither probe sends where the car is.
 */

export interface LocationResult {
  available: boolean;
  permission: string | null;
  granted: boolean;
  /** Whether the position came with a speed, and that speed in m/s (rounded). */
  speedAvailable: boolean;
  speedMps: number | null;
  accuracyM: number | null;
  error: string | null;
}

const GEO_ERRORS: Record<number, string> = { 1: "permission denied", 2: "position unavailable", 3: "timed out" };

export async function checkLocation(): Promise<LocationResult> {
  const base: LocationResult = {
    available: "geolocation" in navigator,
    permission: null,
    granted: false,
    speedAvailable: false,
    speedMps: null,
    accuracyM: null,
    error: null,
  };
  if (!base.available) return base;
  try {
    base.permission = (await navigator.permissions.query({ name: "geolocation" })).state;
  } catch {
    // the Permissions API is optional
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        resolve({
          ...base,
          granted: true,
          speedAvailable: coords.speed !== null,
          speedMps: coords.speed === null ? null : Math.round(coords.speed * 10) / 10,
          accuracyM: Math.round(coords.accuracy),
        }),
      (err) => resolve({ ...base, error: GEO_ERRORS[err.code] ?? err.message }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

export interface DriveLockEvent {
  /** Seconds since the probe started. */
  t: number;
  event: string;
  paused: boolean;
}

export interface DriveLockResult {
  seconds: number;
  events: DriveLockEvent[];
  /** Pauses the page didn't ask for: the browser stopped the video. */
  browserPauses: number;
  /** Times the video stopped advancing while it claimed to play. */
  freezes: number;
}

const MAX_EVENTS = 200;
const VIDEO_EVENTS = ["play", "playing", "pause", "waiting", "stalled", "error", "emptied"] as const;

/**
 * Plays a tiny muted clip in a loop and records what the browser does to it. Tesla stops
 * video outside Park, so shifting into Drive (brake held) should show up as a pause here.
 */
export class DriveLockProbe {
  readonly events: DriveLockEvent[] = [];
  private started = 0;
  private stopping = false;
  private timer: number | null = null;
  private lastTime = -1;
  private frozen = false;
  private freezes = 0;
  private browserPauses = 0;
  private readonly cleanup: Array<() => void> = [];

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onChange: () => void,
  ) {}

  /** Call from a tap: starting the clip may need the gesture. */
  start(): Promise<void> {
    this.started = performance.now();
    const video = this.video;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.src = "/api/diagnostics/probe.mp4";
    for (const type of VIDEO_EVENTS) {
      const handler = () => {
        if (type === "pause" && !this.stopping) this.browserPauses++;
        this.log(type);
      };
      video.addEventListener(type, handler);
      this.cleanup.push(() => video.removeEventListener(type, handler));
    }
    const onVisibility = () => this.log(`page ${document.visibilityState}`);
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", onVisibility));
    this.timer = window.setInterval(() => this.watch(), 1000);
    return video.play();
  }

  stop(): DriveLockResult {
    this.stopping = true;
    for (const undo of this.cleanup.splice(0)) undo();
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    return {
      seconds: Math.round((performance.now() - this.started) / 100) / 10,
      events: [...this.events],
      browserPauses: this.browserPauses,
      freezes: this.freezes,
    };
  }

  private watch(): void {
    const { currentTime, paused } = this.video;
    if (!paused && currentTime === this.lastTime && !this.frozen) {
      this.frozen = true;
      this.freezes++;
      this.log("frozen");
    } else if (currentTime !== this.lastTime && this.frozen) {
      this.frozen = false;
      this.log("moving again");
    }
    this.lastTime = currentTime;
  }

  private log(event: string): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({ t: Math.round((performance.now() - this.started) / 100) / 10, event, paused: this.video.paused });
    this.onChange();
  }
}

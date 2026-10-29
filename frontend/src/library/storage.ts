import type { VideoSummary } from "../api/types";

// localStorage can throw (private mode, quota, disabled storage) and can hold
// stale or hand-edited data, so every read is validated and every write guarded.

export function readJson<T>(key: string, validate: (value: unknown) => T | null, fallback: T, store?: Storage): T {
  try {
    const raw = (store ?? window.localStorage).getItem(key);
    if (raw === null) return fallback;
    return validate(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown, store?: Storage): boolean {
  try {
    (store ?? window.localStorage).setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const SOURCES = new Set(["youtube", "demo"]);

export function asVideo(value: unknown): VideoSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id || typeof v.title !== "string" || !SOURCES.has(v.source as string)) {
    return null;
  }
  const channel = v.channel && typeof v.channel === "object" ? (v.channel as Record<string, unknown>) : null;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    source: v.source as VideoSummary["source"],
    id: v.id,
    title: v.title,
    channel: channel
      ? {
          ref: str(channel.ref),
          id: str(channel.id),
          handle: str(channel.handle),
          name: str(channel.name),
          avatar_url: str(channel.avatar_url),
        }
      : null,
    duration_seconds: num(v.duration_seconds),
    thumbnail_url: str(v.thumbnail_url),
    view_count: num(v.view_count),
    live_status: (str(v.live_status) as VideoSummary["live_status"]) ?? null,
    available: v.available !== false,
    unavailable_reason: str(v.unavailable_reason),
    published_text: str(v.published_text),
  };
}

export function asArray<T>(value: unknown, item: (x: unknown) => T | null, max: number): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = item(entry);
    if (parsed) out.push(parsed);
    if (out.length >= max) break;
  }
  return out;
}

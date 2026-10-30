import { query, request } from "@/api/http";

/** The Plex app's backend (/api/apps/plex/...). Tokens and server addresses never come here. */

export interface PlexStatus {
  connected: boolean;
  signed_in: boolean;
  account: string | null;
  avatar: string | null;
  server: string | null;
  connection: "local" | "remote" | "relay" | null;
}

export interface SignIn {
  pin_id: number;
  code: string;
  auth_url: string;
  expires_at: string | null;
}

export interface SignInState {
  state: "waiting" | "connected" | "no_server" | "expired";
  status: PlexStatus | null;
}

export interface PlexServer {
  id: string;
  name: string;
  online: boolean;
  owned: boolean;
  selected: boolean;
}

export interface PlexLibrary {
  key: string;
  title: string;
  type: "movie" | "show";
}

export interface PlexItem {
  key: string;
  type: "movie" | "show" | "season" | "episode";
  title: string;
  year: number | null;
  summary: string | null;
  duration_seconds: number | null;
  poster: string | null;
  still: string | null;
  art: string | null;
  view_offset_seconds: number | null;
  watched: boolean;
  show_title: string | null;
  season: number | null;
  episode: number | null;
  child_count: number | null;
  library: string | null;
}

export interface PlexStream {
  id: number;
  index: number | null;
  kind: "video" | "audio" | "subtitle";
  codec: string | null;
  language: string | null;
  title: string | null;
  channels: number | null;
  default: boolean;
  selected: boolean;
}

export interface PlexMedia {
  container: string | null;
  video_codec: string | null;
  video_resolution: string | null;
  width: number | null;
  height: number | null;
  frame_rate: string | null;
  audio_codec: string | null;
  audio_channels: number | null;
  bitrate_kbps: number | null;
  size_bytes: number | null;
  part_id: number | null;
  streams: PlexStream[];
}

export interface PlexDetails extends PlexItem {
  tagline: string | null;
  content_rating: string | null;
  audience_rating: number | null;
  studio: string | null;
  genres: string[];
  directors: string[];
  cast: string[];
  media: PlexMedia[];
  children: PlexItem[];
}

export interface PlexHome {
  continue_watching: PlexItem[];
  rows: Array<{ library: PlexLibrary; items: PlexItem[] }>;
}

export interface PlexPage {
  items: PlexItem[];
  offset: number;
  total: number;
}

export interface PlayResponse {
  session: string;
  mode: "direct" | "transcode";
  url: string;
  container: "matroska" | "mp4" | null;
  audio_track: number | null;
  duration_seconds: number | null;
  view_offset_seconds: number | null;
  reason: string;
}

export interface Capabilities {
  video: string[];
  audio: string[];
}

const BASE = "/api/apps/plex";
const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const plexApi = {
  status: (signal?: AbortSignal) => request<PlexStatus>(`${BASE}/status`, { signal }),
  startSignIn: () => request<SignIn>(`${BASE}/signin`, { method: "POST" }),
  checkSignIn: (pinId: number, signal?: AbortSignal) => request<SignInState>(`${BASE}/signin/${pinId}`, { signal }),
  disconnect: () => request<PlexStatus>(`${BASE}/signin`, { method: "DELETE" }),
  servers: (signal?: AbortSignal) => request<PlexServer[]>(`${BASE}/servers`, { signal }),
  chooseServer: (id: string) => request<PlexStatus>(`${BASE}/server`, { method: "PUT", ...json({ id }) }),
  home: (signal?: AbortSignal) => request<PlexHome>(`${BASE}/home`, { signal }),
  libraries: (signal?: AbortSignal) => request<PlexLibrary[]>(`${BASE}/libraries`, { signal }),
  libraryItems: (key: string, offset: number, sort: string, signal?: AbortSignal) =>
    request<PlexPage>(`${BASE}/libraries/${encodeURIComponent(key)}/items${query({ offset, sort, limit: 60 })}`, { signal }),
  item: (key: string, signal?: AbortSignal) => request<PlexDetails>(`${BASE}/items/${encodeURIComponent(key)}`, { signal }),
  search: (q: string, signal?: AbortSignal) => request<PlexItem[]>(`${BASE}/search${query({ q })}`, { signal }),
  play: (body: { key: string; audio_stream?: number | null; max_bitrate_kbps?: number | null; capabilities: Capabilities }) =>
    request<PlayResponse>(`${BASE}/play`, { method: "POST", ...json(body) }),
  ping: (session: string) => request<{ ok: boolean }>(`${BASE}/sessions/${encodeURIComponent(session)}/ping`, { method: "POST" }),
  stop: (session: string) => request<{ ok: boolean }>(`${BASE}/sessions/${encodeURIComponent(session)}`, { method: "DELETE" }),
  timeline: (body: { key: string; state: "playing" | "paused" | "stopped"; time: number; duration: number | null; session: string | null }) =>
    request<{ ok: boolean }>(`${BASE}/timeline`, { method: "POST", ...json(body) }),
};

export const plexPath = (...parts: Array<string | number>) => ["/apps/plex", ...parts.map((p) => encodeURIComponent(String(p)))].join("/");

export function itemLabel(item: PlexItem): string {
  if (item.type === "episode") return `${item.show_title ?? ""} · S${item.season ?? "?"} E${item.episode ?? "?"}`;
  if (item.type === "season") return item.child_count ? `${item.child_count} episodes` : "";
  if (item.type === "show") return [item.year, item.child_count ? `${item.child_count} seasons` : null].filter(Boolean).join(" · ");
  return item.year ? String(item.year) : "";
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

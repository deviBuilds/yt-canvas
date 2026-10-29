// Mirrors backend/app/models.py and backend/app/media/models.py.

export type Source = "youtube" | "demo";
export type LiveStatus = "not_live" | "is_live" | "is_upcoming" | "was_live" | "post_live";

export interface ChannelInfo {
  ref: string | null;
  id: string | null;
  handle: string | null;
  name: string | null;
  /** Set for channels found on YouTube's pages (feeds, related videos). */
  avatar_url?: string | null;
}

export interface VideoSummary {
  source: Source;
  id: string;
  title: string;
  channel: ChannelInfo | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  view_count: number | null;
  live_status: LiveStatus | null;
  available: boolean;
  unavailable_reason: string | null;
  /** e.g. "2 hours ago"; only YouTube's pages provide it, not yt-dlp. */
  published_text?: string | null;
}

export type PageKind = "search" | "channel" | "playlist" | "demo" | "feed";

export interface Page {
  kind: PageKind;
  title: string | null;
  subtitle: string | null;
  channel: ChannelInfo | null;
  playlist_id: string | null;
  total_count: number | null;
  items: VideoSummary[];
  offset: number;
  next_offset: number | null;
  provider: string;
  cached: boolean;
}

export interface FeedInfo {
  id: string;
  title: string;
}

export interface Shelf {
  /** Some shelves on YouTube's pages have no heading. */
  title: string | null;
  items: VideoSummary[];
}

/** A public YouTube topic page (music, news, ...) as shelves of videos. */
export interface Feed {
  id: string;
  title: string;
  shelves: Shelf[];
  provider: string;
  cached: boolean;
}

export interface StreamTrack {
  /** yt-dlp format id ("137", "140"), or "video" / "audio" for demo clips. */
  id: string;
  mime_type: string;
  codecs: string;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  bitrate: number | null;
  size_bytes: number | null;
  /** Audio only: 2 for stereo, 6 for 5.1. The backend lists stereo first. */
  channels?: number | null;
}

/** A streaming session: the tracks the backend will proxy in byte ranges (POST /api/streams). */
export interface StreamSession {
  session_id: string;
  source: Source;
  video_id: string;
  video: VideoSummary | null;
  duration_seconds: number | null;
  video_tracks: StreamTrack[];
  audio_tracks: StreamTrack[];
  expires_at: number;
}

/** YouTube sign-in through the browser's cookies (opt-in; see /signin). */
export interface Me {
  configured: boolean;
  signed_in: boolean;
  /** e.g. "chrome" or "cookies file". */
  source: string | null;
  avatar_url: string | null;
  /** The topic chips on the account's YouTube home page. */
  chips: string[];
  /** Why sign-in isn't working, when configured. */
  detail: string | null;
}

export interface ParsedInput {
  kind: "video" | "playlist" | "channel" | "search";
  video_id: string | null;
  playlist_id: string | null;
  channel_ref: string | null;
  query: string | null;
  start_seconds: number | null;
}

export type JobState = "queued" | "resolving" | "downloading" | "processing" | "ready" | "failed";

export interface JobProgress {
  fraction: number | null;
  downloaded_bytes: number | null;
  total_bytes: number | null;
  speed_bps: number | null;
  eta_seconds: number | null;
  detail: string | null;
}

export interface ErrorInfo {
  code: string;
  message: string;
  hint: string | null;
  retryable: boolean;
}

export interface MediaInfo {
  media_id: string;
  url: string;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  processing: "remux" | "transcode" | "transcode_audio" | "transcode_video";
  delivery: "file";
}

export interface Job {
  id: string;
  source: Source;
  video_id: string;
  state: JobState;
  progress: JobProgress;
  error: ErrorInfo | null;
  media: MediaInfo | null;
  video: VideoSummary | null;
  demo: boolean;
  queue_position: number | null;
  created_at: number;
  updated_at: number;
  notice: string;
}

export interface ToolInfo {
  name: string;
  available: boolean;
  version: string | null;
  path: string | null;
  note: string | null;
}

export interface Health {
  ok: boolean;
  demo_enabled: boolean;
  max_height: number;
  dependencies: {
    ytdlp: ToolInfo;
    ytdlp_ejs: ToolInfo;
    ffmpeg: ToolInfo;
    ffprobe: ToolInfo;
    js_runtimes: ToolInfo[];
    js_runtime_enabled: string | null;
    warnings: string[];
    can_extract: boolean;
    can_process: boolean;
  };
}

export interface MediaRef {
  source: Source;
  id: string;
}

export function videoKey(ref: MediaRef): string {
  return `${ref.source}:${ref.id}`;
}

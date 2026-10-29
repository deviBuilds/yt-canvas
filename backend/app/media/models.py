"""Preparation-job and prepared-media schemas."""

from __future__ import annotations

import enum
from typing import Literal

from pydantic import BaseModel

from ..models import Source, VideoSummary


class JobState(str, enum.Enum):
    QUEUED = "queued"
    RESOLVING = "resolving"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"

    @property
    def terminal(self) -> bool:
        return self in (JobState.READY, JobState.FAILED)


class JobProgress(BaseModel):
    # ``fraction`` is None when progress is indeterminate.
    fraction: float | None = None
    downloaded_bytes: int | None = None
    total_bytes: int | None = None
    speed_bps: float | None = None
    eta_seconds: float | None = None
    detail: str | None = None


class JobErrorInfo(BaseModel):
    code: str
    message: str
    hint: str | None = None
    retryable: bool = False


ProcessingMode = Literal["remux", "transcode", "transcode_audio", "transcode_video"]


class MediaInfo(BaseModel):
    media_id: str
    url: str
    content_type: str = "video/mp4"
    size_bytes: int
    width: int | None = None
    height: int | None = None
    duration_seconds: float | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    processing: ProcessingMode
    # Always "file"; streaming sessions (app.media.streams) have their own API.
    delivery: Literal["file"] = "file"


class JobView(BaseModel):
    id: str
    source: Source
    video_id: str
    state: JobState
    progress: JobProgress
    error: JobErrorInfo | None = None
    media: MediaInfo | None = None
    video: VideoSummary | None = None
    demo: bool = False
    queue_position: int | None = None
    created_at: float
    updated_at: float
    notice: str = (
        "This version downloads and prepares the whole video before playback starts, "
        "so longer videos take longer to become playable."
    )


class StreamVideoTrack(BaseModel):
    """A video-only fragmented-MP4 track, fetched in byte ranges for Media Source Extensions."""

    id: str
    mime_type: str = "video/mp4"
    codecs: str
    width: int | None = None
    height: int | None = None
    fps: int | float | None = None
    bitrate: int | None = None  # bits per second
    size_bytes: int | None = None


class StreamAudioTrack(BaseModel):
    id: str
    mime_type: str = "audio/mp4"
    codecs: str
    bitrate: int | None = None
    size_bytes: int | None = None
    # 2 for stereo, 6 for 5.1; None when yt-dlp doesn't say.
    channels: int | None = None


class StreamView(BaseModel):
    """``POST /api/streams``: a session whose tracks are read from
    ``/api/streams/{session_id}/tracks/{track_id}?start=&end=``."""

    session_id: str
    source: Source
    video_id: str
    video: VideoSummary
    duration_seconds: float | None = None
    # Highest first (height, then bitrate); audio by bitrate.
    video_tracks: list[StreamVideoTrack]
    audio_tracks: list[StreamAudioTrack]
    expires_at: float

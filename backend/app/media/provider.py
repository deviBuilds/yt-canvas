"""The media-provider boundary.

A *source provider* knows how to turn a reference (a YouTube video ID, a demo
sample ID) into local input files. Everything after that — probing, remuxing
or transcoding, faststart, storage and byte-range delivery — is shared.

The contract here is "prepare a complete file, then serve it" (the "Download
first" mode). Streaming playback, which proxies YouTube's DASH tracks into Media
Source Extensions without storing anything, lives in :mod:`app.media.streams`
and doesn't go through providers or jobs. ``supports_progressive`` and
:class:`MediaInfo`'s ``delivery`` remain reserved for a provider that would
yield a growing fragmented-MP4 file.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

from ..models import VideoSummary
from .models import JobProgress, JobState

InputRole = Literal["video", "audio", "muxed"]


@dataclass
class MediaInput:
    path: Path
    role: InputRole


@dataclass
class ResolvedMedia:
    video: VideoSummary
    estimated_bytes: int | None
    # Provider-private details (selected formats, info JSON path, ...).
    details: dict = field(default_factory=dict)


@dataclass
class AcquiredMedia:
    inputs: list[MediaInput]
    duration_hint: float | None = None


class JobContext(Protocol):
    """What a provider may do with the job it is working on."""

    workdir: Path

    def set_state(self, state: JobState, detail: str | None = None) -> None: ...

    def set_progress(self, progress: JobProgress) -> None: ...

    def set_video(self, video: VideoSummary) -> None: ...


ProgressCallback = Callable[[JobProgress], None]


class MediaSourceProvider(Protocol):
    source: str
    supports_progressive: bool

    def validate_ref(self, ref: str) -> str:
        """Return the canonical reference or raise ``AppError('invalid_input')``."""
        ...

    async def resolve(self, ref: str, ctx: JobContext) -> ResolvedMedia:
        """Look up metadata and choose what to acquire. Must reject live/oversized media."""
        ...

    async def acquire(self, resolved: ResolvedMedia, ctx: JobContext) -> AcquiredMedia:
        """Fetch or generate the input files into ``ctx.workdir``."""
        ...

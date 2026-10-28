"""Normalized API schemas shared by the discovery and media modules."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

Source = Literal["youtube", "demo"]
LiveStatus = Literal["not_live", "is_live", "is_upcoming", "was_live", "post_live"]


class ChannelInfo(BaseModel):
    # ``ref`` is what the frontend passes back to /api/channel (UC… ID or @handle).
    ref: str | None = None
    id: str | None = None
    handle: str | None = None
    name: str | None = None


class VideoSummary(BaseModel):
    source: Source = "youtube"
    id: str
    title: str
    channel: ChannelInfo | None = None
    duration_seconds: int | None = None
    thumbnail_url: str | None = None
    view_count: int | None = None
    live_status: LiveStatus | None = None
    available: bool = True
    unavailable_reason: str | None = None


PageKind = Literal["search", "channel", "playlist", "demo"]


class Page(BaseModel):
    kind: PageKind
    title: str | None = None
    subtitle: str | None = None
    channel: ChannelInfo | None = None
    playlist_id: str | None = None
    total_count: int | None = None
    items: list[VideoSummary]
    offset: int = 0
    # Only set when the provider actually has another page.
    next_offset: int | None = None
    provider: str
    cached: bool = False

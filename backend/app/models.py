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
    avatar_url: str | None = None


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
    # Relative upload time as YouTube words it ("2 hours ago", "Streamed 3 days ago").
    published_text: str | None = None


PageKind = Literal["search", "channel", "playlist", "demo", "feed"]


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


class FeedInfo(BaseModel):
    id: str
    title: str


class FeedList(BaseModel):
    feeds: list[FeedInfo]


class Shelf(BaseModel):
    title: str | None = None
    items: list[VideoSummary]


class Feed(BaseModel):
    id: str
    title: str
    shelves: list[Shelf]
    provider: str
    cached: bool = False


class RelatedVideos(BaseModel):
    video_id: str
    items: list[VideoSummary]
    provider: str
    cached: bool = False


class Me(BaseModel):
    """The signed-in YouTube session (``GET /api/me``)."""

    configured: bool
    signed_in: bool
    # "chrome", "safari", ... or "cookies file".
    source: str | None = None
    avatar_url: str | None = None
    # Labels of the account's home-feed filter chips ("Music", "Podcasts", ...), without "All".
    chips: list[str] = []
    # Why signed_in is false (or null when it isn't, or when sign-in isn't configured).
    detail: str | None = None

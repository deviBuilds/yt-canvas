"""Normalize yt-dlp metadata into :mod:`app.models` schemas.

yt-dlp's flat extraction returns sparse, inconsistent dictionaries: durations
may be floats or missing, thumbnails may be absent or point at odd hosts, and
channel fields vary between search, playlist and channel listings. Everything
here is defensive and never raises on unexpected shapes.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from ..models import ChannelInfo, LiveStatus, VideoSummary
from ..validation import CHANNEL_ID_RE, HANDLE_RE, VIDEO_ID_RE

_THUMBNAIL_HOST_SUFFIXES = ("ytimg.com", "ggpht.com", "googleusercontent.com")
_TARGET_THUMB_WIDTH = 480
_LIVE_STATUSES: set[str] = {"not_live", "is_live", "is_upcoming", "was_live", "post_live"}
_UNAVAILABLE_TITLES = {
    "[private video]": "Private video",
    "[deleted video]": "Deleted video",
    "[unavailable video]": "Unavailable video",
}
_UNAVAILABLE_AVAILABILITY = {
    "private": "Private video",
    "premium_only": "Requires YouTube Premium",
    "subscriber_only": "Members only",
    "needs_auth": "Requires sign-in",
}


def _text(value: Any, max_length: int = 300) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value[:max_length] if value else None


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(round(value))
    if isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            return None
        return int(round(number)) if number > 0 else None
    return None


def _non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return int(value)
    return None


def _safe_thumbnail_url(url: Any) -> str | None:
    if not isinstance(url, str):
        return None
    if url.startswith("//"):
        url = "https:" + url
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not any(host == s or host.endswith("." + s) for s in _THUMBNAIL_HOST_SUFFIXES):
        return None
    return url


def pick_thumbnail(entry: dict[str, Any], video_id: str | None = None) -> str | None:
    """Choose a thumbnail close to card size; fall back to the canonical ytimg URL."""
    candidates: list[tuple[float, str]] = []
    thumbnails = entry.get("thumbnails")
    if isinstance(thumbnails, list):
        for thumb in thumbnails:
            if not isinstance(thumb, dict):
                continue
            url = _safe_thumbnail_url(thumb.get("url"))
            if not url:
                continue
            width = _positive_int(thumb.get("width"))
            # Unknown widths rank behind known ones but ahead of nothing.
            score = abs(width - _TARGET_THUMB_WIDTH) if width else 10_000
            candidates.append((score, url))
    if candidates:
        candidates.sort(key=lambda item: item[0])
        return candidates[0][1]
    single = _safe_thumbnail_url(entry.get("thumbnail"))
    if single:
        return single
    if video_id:
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    return None


def channel_from(entry: dict[str, Any], fallback: ChannelInfo | None = None) -> ChannelInfo | None:
    channel_id = entry.get("channel_id")
    channel_id = channel_id if isinstance(channel_id, str) and CHANNEL_ID_RE.match(channel_id) else None
    handle = None
    for key in ("uploader_id", "channel_handle"):
        value = entry.get(key)
        if isinstance(value, str) and HANDLE_RE.match(value):
            handle = value
            break
    if handle is None:
        url = entry.get("uploader_url") or entry.get("channel_url")
        if isinstance(url, str) and "/@" in url:
            candidate = "@" + url.split("/@", 1)[1].split("/", 1)[0]
            handle = candidate if HANDLE_RE.match(candidate) else None
    name = _text(entry.get("channel")) or _text(entry.get("uploader"))

    if not (channel_id or handle or name):
        return fallback
    info = ChannelInfo(ref=channel_id or handle, id=channel_id, handle=handle, name=name)
    if fallback:
        info = ChannelInfo(
            ref=info.ref or fallback.ref,
            id=info.id or fallback.id,
            handle=info.handle or fallback.handle,
            name=info.name or fallback.name,
        )
    return info


def _live_status(entry: dict[str, Any]) -> LiveStatus | None:
    status = entry.get("live_status")
    if isinstance(status, str) and status in _LIVE_STATUSES:
        return status  # type: ignore[return-value]
    if entry.get("is_live") is True:
        return "is_live"
    if entry.get("was_live") is True:
        return "was_live"
    return None


# With sign-in set up these may well be playable, so they aren't marked unavailable.
_SIGNIN_AVAILABILITY = {"premium_only", "subscriber_only", "needs_auth"}


def normalize_entry(entry: Any, *, channel_fallback: ChannelInfo | None = None,
                    signed_in: bool = False) -> VideoSummary | None:
    """Normalize one flat entry. Returns ``None`` for non-video entries."""
    if not isinstance(entry, dict):
        return None
    if entry.get("_type") == "playlist":
        return None
    ie_key = entry.get("ie_key")
    if ie_key not in (None, "Youtube"):
        return None  # channels/playlists mixed into results
    video_id = entry.get("id")
    if not isinstance(video_id, str) or not VIDEO_ID_RE.match(video_id):
        return None

    raw_title = _text(entry.get("title"))
    reason = None
    if raw_title and raw_title.lower() in _UNAVAILABLE_TITLES:
        reason = _UNAVAILABLE_TITLES[raw_title.lower()]
    availability = entry.get("availability")
    if reason is None and isinstance(availability, str) and availability in _UNAVAILABLE_AVAILABILITY:
        if not (signed_in and availability in _SIGNIN_AVAILABILITY):
            reason = _UNAVAILABLE_AVAILABILITY[availability]

    return VideoSummary(
        source="youtube",
        id=video_id,
        title=(reason if reason and raw_title and raw_title.startswith("[") else raw_title) or "Untitled video",
        channel=channel_from(entry, channel_fallback),
        duration_seconds=_positive_int(entry.get("duration")),
        thumbnail_url=pick_thumbnail(entry, video_id),
        view_count=_non_negative_int(entry.get("view_count")),
        live_status=_live_status(entry),
        available=reason is None,
        unavailable_reason=reason,
    )


def normalize_entries(entries: Any, *, channel_fallback: ChannelInfo | None = None,
                      signed_in: bool = False) -> list[VideoSummary]:
    if not isinstance(entries, list):
        return []
    seen: set[str] = set()
    items: list[VideoSummary] = []
    for entry in entries:
        item = normalize_entry(entry, channel_fallback=channel_fallback, signed_in=signed_in)
        if item and item.id not in seen:
            seen.add(item.id)
            items.append(item)
    return items


def clean_channel_title(title: Any) -> str | None:
    """yt-dlp titles channel tabs like ``"Blender - Videos"``; drop the tab suffix."""
    text = _text(title)
    if not text:
        return None
    for suffix in (" - Videos", " - Shorts", " - Live", " - Home"):
        if text.endswith(suffix):
            return text[: -len(suffix)]
    return text

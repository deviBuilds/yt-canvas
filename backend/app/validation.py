"""Validation of YouTube identifiers and classification of user input.

The backend never fetches a user-supplied URL. Input is parsed into validated
identifiers (video ID, playlist ID, channel reference) and canonical YouTube
URLs are rebuilt from those identifiers before anything reaches yt-dlp.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass
from typing import Literal
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .errors import AppError

MAX_INPUT_LENGTH = 500
MAX_QUERY_LENGTH = 200

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{12,64}$")
CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
# Handles: 3-30 characters; letters (any script), digits, underscore, hyphen, period.
HANDLE_RE = re.compile(r"^@[\w.\-]{3,30}$", re.UNICODE)
LEGACY_NAME_RE = re.compile(r"^[\w.\-]{1,100}$", re.UNICODE)

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
SHORT_HOSTS = {"youtu.be", "www.youtu.be"}

# Path prefixes whose next segment is a video ID.
_VIDEO_PATH_PREFIXES = {"shorts", "embed", "live", "v", "e"}
# Channel sub-pages we accept (and ignore) after the channel reference.
_CHANNEL_TABS = {"", "videos", "featured", "streams", "shorts", "playlists", "community", "about", "live"}
# Personal or generated lists that cannot be browsed anonymously / are endless.
_UNSUPPORTED_PLAYLIST_PREFIXES = ("RD", "UL", "WL", "LL")

InputKind = Literal["video", "playlist", "channel", "search"]


@dataclass(frozen=True)
class ParsedInput:
    kind: InputKind
    video_id: str | None = None
    playlist_id: str | None = None
    channel_ref: str | None = None
    query: str | None = None
    start_seconds: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _invalid(message: str, hint: str | None = None) -> AppError:
    return AppError("invalid_input", message, status=400, hint=hint)


def is_video_id(value: str) -> bool:
    return bool(VIDEO_ID_RE.match(value))


def validate_video_id(value: str) -> str:
    if not isinstance(value, str) or not VIDEO_ID_RE.match(value):
        raise _invalid("That is not a valid YouTube video ID.", "Video IDs are 11 characters, e.g. dQw4w9WgXcQ.")
    return value


def is_supported_playlist_id(value: str) -> bool:
    return bool(PLAYLIST_ID_RE.match(value)) and not value.startswith(_UNSUPPORTED_PLAYLIST_PREFIXES)


def validate_playlist_id(value: str) -> str:
    if not isinstance(value, str) or not PLAYLIST_ID_RE.match(value):
        raise _invalid("That is not a valid YouTube playlist ID.")
    if value.startswith(_UNSUPPORTED_PLAYLIST_PREFIXES):
        raise _invalid(
            "Mixes, Watch Later and Liked lists are personal or generated and cannot be browsed here.",
            "Open a regular public playlist instead.",
        )
    return value


def validate_channel_ref(value: str) -> str:
    """Accepts ``UC…`` channel IDs, ``@handle``, ``c/Name`` and ``user/Name``."""
    if not isinstance(value, str):
        raise _invalid("That is not a valid YouTube channel.")
    value = unicodedata.normalize("NFC", value.strip())
    if CHANNEL_ID_RE.match(value) or HANDLE_RE.match(value):
        return value
    for prefix in ("c/", "user/"):
        if value.startswith(prefix) and LEGACY_NAME_RE.match(value[len(prefix):]):
            return value
    raise _invalid(
        "That is not a valid YouTube channel reference.",
        "Use a channel URL, an @handle, or a channel ID starting with UC.",
    )


def channel_url(ref: str, tab: str = "videos") -> str:
    ref = validate_channel_ref(ref)
    if ref.startswith("UC"):
        base = f"https://www.youtube.com/channel/{ref}"
    elif ref.startswith("@"):
        base = f"https://www.youtube.com/{quote(ref, safe='@')}"
    else:
        prefix, name = ref.split("/", 1)
        base = f"https://www.youtube.com/{prefix}/{quote(name, safe='')}"
    return f"{base}/{tab}" if tab else base


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={validate_video_id(video_id)}"


def playlist_url(playlist_id: str) -> str:
    return f"https://www.youtube.com/playlist?list={validate_playlist_id(playlist_id)}"


def clean_query(query: str) -> str:
    """Normalize a keyword query: strip control characters and collapse whitespace."""
    if not isinstance(query, str):
        raise _invalid("Enter something to search for.")
    cleaned = "".join(ch for ch in query if unicodedata.category(ch)[0] != "C" or ch in " \t")
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        raise _invalid("Enter something to search for.")
    if len(cleaned) > MAX_QUERY_LENGTH:
        raise _invalid(f"Search queries are limited to {MAX_QUERY_LENGTH} characters.")
    return cleaned


_T_PART_RE = re.compile(r"(\d+)([hms])")


def parse_timestamp(value: str | None) -> int | None:
    """Parse YouTube ``t=`` values such as ``90``, ``90s`` or ``1h2m3s``."""
    if not value:
        return None
    value = value.strip().lower()
    if value.isdigit():
        return int(value)
    if not re.fullmatch(r"(\d+[hms])+", value):
        return None
    seconds = 0
    for amount, unit in _T_PART_RE.findall(value):
        seconds += int(amount) * {"h": 3600, "m": 60, "s": 1}[unit]
    return seconds


def _looks_like_url(text: str) -> bool:
    lowered = text.lower()
    if re.match(r"^[a-z][a-z0-9+.-]*://", lowered):
        return True
    host = lowered.split("/", 1)[0]
    return host in YOUTUBE_HOSTS or host in SHORT_HOSTS


def parse_input(text: str) -> ParsedInput:
    """Classify search-bar input as a video, playlist, channel or keyword search."""
    if not isinstance(text, str):
        raise _invalid("Enter keywords or a YouTube URL.")
    text = text.strip()
    if not text:
        raise _invalid("Enter keywords or a YouTube URL.")
    if len(text) > MAX_INPUT_LENGTH:
        raise _invalid(f"Input is limited to {MAX_INPUT_LENGTH} characters.")

    if text.startswith("@") and " " not in text:
        return ParsedInput(kind="channel", channel_ref=validate_channel_ref(text))

    if not _looks_like_url(text):
        return ParsedInput(kind="search", query=clean_query(text))

    return _parse_url(text)


def _parse_url(text: str) -> ParsedInput:
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urlsplit(text)
    except ValueError as exc:
        raise _invalid("That URL could not be parsed.") from exc

    if parts.scheme.lower() not in {"http", "https"}:
        raise _invalid("Only http(s) YouTube URLs are supported.")
    if parts.username or parts.password or parts.port not in (None, 80, 443):
        raise _invalid("That URL is not a supported YouTube URL.")

    host = (parts.hostname or "").lower()
    query = parse_qs(parts.query, keep_blank_values=False)
    segments = [seg for seg in parts.path.split("/") if seg]

    def first(name: str) -> str | None:
        values = query.get(name)
        return values[0].strip() if values else None

    start = parse_timestamp(first("t") or first("start"))
    list_id = first("list")
    playlist_id = list_id if list_id and is_supported_playlist_id(list_id) else None

    if host in SHORT_HOSTS:
        if len(segments) >= 1 and is_video_id(segments[0]):
            return ParsedInput(kind="video", video_id=segments[0], playlist_id=playlist_id, start_seconds=start)
        raise _invalid("That youtu.be link does not contain a valid video ID.")

    if host not in YOUTUBE_HOSTS:
        raise _invalid(
            "Only YouTube URLs are supported.",
            "Paste a youtube.com or youtu.be link, or type keywords to search.",
        )

    if not segments:
        raise _invalid("That YouTube URL does not point to a video, playlist or channel.")

    head = segments[0]
    if head == "watch":
        video_id = first("v")
        if video_id and is_video_id(video_id):
            return ParsedInput(kind="video", video_id=video_id, playlist_id=playlist_id, start_seconds=start)
        if playlist_id:
            return ParsedInput(kind="playlist", playlist_id=playlist_id)
        raise _invalid("That watch URL does not contain a valid video ID.")

    if head in _VIDEO_PATH_PREFIXES and len(segments) >= 2:
        if is_video_id(segments[1]):
            return ParsedInput(kind="video", video_id=segments[1], playlist_id=playlist_id, start_seconds=start)
        raise _invalid("That URL does not contain a valid video ID.")

    if head == "playlist":
        if list_id:
            return ParsedInput(kind="playlist", playlist_id=validate_playlist_id(list_id))
        raise _invalid("That playlist URL is missing its list ID.")

    if head == "results":
        search = first("search_query") or first("q")
        if search:
            return ParsedInput(kind="search", query=clean_query(search))
        raise _invalid("That search URL has no query.")

    ref: str | None = None
    rest: list[str] = []
    if head == "channel" and len(segments) >= 2:
        ref, rest = segments[1], segments[2:]
    elif head.startswith("@"):
        ref, rest = unquote(head), segments[1:]
    elif head in {"c", "user"} and len(segments) >= 2:
        ref, rest = f"{head}/{unquote(segments[1])}", segments[2:]

    if ref is not None:
        if rest and rest[0] not in _CHANNEL_TABS:
            raise _invalid("That channel page is not supported.", "Use the channel's main URL.")
        return ParsedInput(kind="channel", channel_ref=validate_channel_ref(ref))

    raise _invalid("That YouTube URL is not supported.", "Paste a video, playlist or channel URL.")


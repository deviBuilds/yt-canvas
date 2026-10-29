"""Curated feeds and related videos read from public YouTube pages.

Trending is gone and yt-dlp lists nothing for YouTube's topic channels, but the
HTML of those public pages embeds ``var ytInitialData = {...}`` with curated
shelves ("New This Week", "Recent Live Streams", ...), and a logged-out watch
page carries its "Up next" list the same way. This module fetches a fixed set
of such pages (never a user-supplied URL) without cookies or sign-in, extracts
``ytInitialData`` and normalizes the shelves into :class:`VideoSummary` items.
When YouTube sign-in is configured, only related videos (and ``/api/me``, see
``account.py``) are fetched with the session's youtube.com cookies; the public
feeds never are.

YouTube reshapes these renderers often, so everything here is defensive:
unknown shapes are skipped, never raised. Items this app cannot play (live and
upcoming streams, Shorts, playlists, albums, mixes, members-only videos) are
dropped, and so are shelves that end up empty.
"""

from __future__ import annotations

import asyncio
import http.client
import http.cookiejar
import json
import logging
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from typing import Any, TypeVar
from urllib.parse import unquote, urlsplit

from ..config import Settings
from ..cookies import CookieLoader, copy_jar
from ..errors import AppError
from ..models import ChannelInfo, Feed, FeedInfo, FeedList, LiveStatus, RelatedVideos, Shelf, VideoSummary
from ..validation import CHANNEL_ID_RE, HANDLE_RE, VIDEO_ID_RE, validate_video_id, watch_url
from .normalize import _safe_thumbnail_url, _text, pick_thumbnail
from .service import TTLCache

log = logging.getLogger(__name__)

PROVIDER = "youtube-pages"


@dataclass(frozen=True)
class FeedSource:
    id: str
    title: str
    url: str


FEEDS: dict[str, FeedSource] = {
    source.id: source
    for source in (
        FeedSource("music", "Music", "https://www.youtube.com/channel/UC-9-kyTW8ZkZNDHQJ6FgpwQ"),
        FeedSource("news", "News", "https://www.youtube.com/channel/UCYfdidRxbB8Qhf0Nx7ioOYw"),
        # Live-now and upcoming streams are dropped, so this is mostly "Recent Live Streams".
        FeedSource("live", "Live", "https://www.youtube.com/channel/UC4R8DWoMoI7CAwX8_LjQHig"),
        FeedSource("gaming", "Gaming", "https://www.youtube.com/gaming"),
    )
}

_MAX_SHELVES = 40
_MAX_SHELF_ITEMS = 50
_MAX_RELATED = 50
# Bounds every walk over ytInitialData (real pages nest about 30 levels deep).
_MAX_DEPTH = 80

# --- Fetching ---------------------------------------------------------------

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}
_PAGE_HOSTS = {"www.youtube.com", "youtube.com", "m.youtube.com"}
_MAX_PAGE_BYTES = 16 * 1024 * 1024


def build_request(url: str) -> urllib.request.Request:
    return urllib.request.Request(url, headers=_HEADERS)


def _download(url: str, timeout: float,
              cookies: http.cookiejar.CookieJar | None = None) -> tuple[str, str]:
    """Blocking GET; returns ``(final_url, html)``. Runs in a worker thread."""
    if cookies is None:
        # A fresh opener has no cookie processor, so no cookies are stored or sent.
        opener = urllib.request.build_opener()
    else:
        # The jar holds only youtube.com cookies, so nothing is sent to any other host; a
        # per-request copy keeps Set-Cookie responses out of the cached jar.
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(copy_jar(cookies)))
    with opener.open(build_request(url), timeout=timeout) as response:
        body = response.read(_MAX_PAGE_BYTES + 1)
        final_url = response.geturl()
    if len(body) > _MAX_PAGE_BYTES:
        raise AppError("extraction_failed", "YouTube returned an unexpectedly large page.", status=502)
    return final_url, body.decode("utf-8", "replace")


def _network_error(exc: BaseException) -> AppError:
    if isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError):
        return AppError("timeout", "YouTube took too long to respond.", status=504, retryable=True)
    return AppError("network_error", "Could not reach YouTube.", status=502,
                    hint="Check the server's internet connection and try again.", retryable=True)


async def fetch_html(url: str, *, timeout: float, cookies: http.cookiejar.CookieJar | None = None) -> str:
    """Fetch one of the fixed YouTube pages. Failures become :class:`AppError`.

    No cookies are sent unless a (youtube.com-only) ``cookies`` jar is passed.
    """
    args = (url, timeout) if cookies is None else (url, timeout, cookies)
    try:
        final_url, html = await asyncio.wait_for(asyncio.to_thread(_download, *args), timeout)
    except AppError:
        raise
    except urllib.error.HTTPError as exc:
        log.warning("fetching %s failed: HTTP %s", url, exc.code)
        if exc.code == 429:
            raise AppError("rate_limited", "YouTube is rate-limiting requests from this server.", status=503,
                           hint="Wait a few minutes and try again.", retryable=True) from exc
        raise AppError("network_error", f"YouTube answered with HTTP {exc.code}.", status=502,
                       hint="Try again later.", retryable=True) from exc
    except (OSError, http.client.HTTPException) as exc:  # URLError, timeouts, resets
        log.warning("fetching %s failed: %s", url, exc)
        raise _network_error(exc) from exc

    host = (urlsplit(final_url).hostname or "").lower()
    if host not in _PAGE_HOSTS:
        log.warning("fetching %s was redirected to %s", url, host)
        if host.startswith("consent."):
            hint = ("Feeds are fetched without cookies, which YouTube requires in some regions. "
                    "Search and channels still work.") if cookies is None else (
                    "Accept YouTube's cookie notice in the signed-in browser, then try again.")
            raise AppError("youtube_blocked", "YouTube showed a cookie-consent page instead of this page.",
                           status=503, hint=hint)
        raise AppError("youtube_blocked", "YouTube redirected this server to a verification page.", status=503,
                       hint="YouTube may be rate-limiting this network. Try again later.", retryable=True)
    return html


# --- ytInitialData ----------------------------------------------------------

_INITIAL_DATA_RE = re.compile(r"""(?:\bvar\s+ytInitialData|window\[["']ytInitialData["']\])\s*=\s*""")


def extract_initial_data(html: str) -> dict[str, Any] | None:
    """Return the ``ytInitialData`` object embedded in a page, or ``None``."""
    decoder = json.JSONDecoder()
    for match in _INITIAL_DATA_RE.finditer(html):
        try:
            data, _ = decoder.raw_decode(html, match.end())
        except (ValueError, RecursionError):
            continue
        if isinstance(data, dict):
            return data
    return None


def _dig(node: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _find_all(node: Any, keys: Iterable[str], *, skip: frozenset[str] = frozenset(),
              depth: int = 0) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield ``(key, value)`` for dicts stored under any of ``keys``, in document order.

    Matches are not searched further, and neither are subtrees under ``skip``.
    """
    if depth > _MAX_DEPTH:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if key in keys and isinstance(value, dict):
                yield key, value
            elif key not in skip:
                yield from _find_all(value, keys, skip=skip, depth=depth + 1)
    elif isinstance(node, list):
        for value in node:
            yield from _find_all(value, keys, skip=skip, depth=depth + 1)


def _text_of(node: Any, max_length: int = 300) -> str | None:
    """Plain text of a YouTube text node: a string, ``simpleText``, ``runs`` or ``content``."""
    if isinstance(node, dict):
        if "simpleText" in node:
            node = node["simpleText"]
        elif "content" in node:
            node = node["content"]
        elif isinstance(node.get("runs"), list):
            node = "".join(run["text"] for run in node["runs"]
                           if isinstance(run, dict) and isinstance(run.get("text"), str))
    return _text(node, max_length)


# --- Field parsers ----------------------------------------------------------

_DURATION_RE = re.compile(r"\d{1,3}(?::\d{1,2}){1,2}")
_COUNT_RE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|k|m|b)?\b")
_MULTIPLIERS = {"k": 10**3, "thousand": 10**3, "m": 10**6, "million": 10**6, "b": 10**9, "billion": 10**9}


def parse_duration(text: Any) -> int | None:
    """``"0:59"`` → 59, ``"12:34"`` → 754, ``"1:02:03"`` → 3723; anything else → ``None``."""
    if not isinstance(text, str) or not _DURATION_RE.fullmatch(text.strip()):
        return None
    seconds = 0
    for part in text.strip().split(":"):
        seconds = seconds * 60 + int(part)
    return seconds or None


def parse_view_count(text: Any) -> int | None:
    """``"1,234 views"`` → 1234, ``"1.2M views"`` / ``"1.2 million views"`` → 1200000, ``"No views"`` → 0.

    Concurrent-viewer counts ("5K watching", "7 waiting") are not view counts.
    """
    if not isinstance(text, str):
        return None
    lowered = " ".join(text.lower().split())
    if lowered.startswith("no views"):
        return 0
    if "watching" in lowered or "waiting" in lowered:
        return None
    match = _COUNT_RE.match(lowered)
    if not match:
        return None
    number, unit = match.groups()
    value = float(number.replace(",", ""))
    return int(round(value * _MULTIPLIERS[unit])) if unit else int(value)


def _live_status(*, live: bool, upcoming: bool, stats: str | None, published: str | None) -> LiveStatus | None:
    stats = (stats or "").lower()
    published = (published or "").lower()
    if upcoming or "waiting" in stats or published.startswith(("premieres", "scheduled for")):
        return "is_upcoming"
    if live or "watching" in stats:
        return "is_live"
    if published.startswith("streamed"):
        return "was_live"
    return None


def _is_short(endpoint: Any) -> bool:
    """True when a navigation endpoint opens the Shorts player."""
    for key, value in _find_all(endpoint, ("reelWatchEndpoint", "webCommandMetadata")):
        if key == "reelWatchEndpoint":
            return True
        url = value.get("url")
        if isinstance(url, str) and url.startswith("/shorts/"):
            return True
    return False


def _members_only(node: Any) -> bool:
    for key, badge in _find_all(node, ("metadataBadgeRenderer", "badgeViewModel")):
        if badge.get("style") == "BADGE_STYLE_TYPE_MEMBERS_ONLY":
            return True
        label = _text_of(badge.get("label") if key == "metadataBadgeRenderer" else badge.get("badgeText"))
        if label and label.lower() == "members only":
            return True
    return False


def _channel_ref(node: Any) -> tuple[str | None, str | None]:
    """``(channel ID, @handle)`` from the first channel ``browseEndpoint`` under ``node``.

    Collaboration bylines open a dialog; the first collaborator's endpoint is used.
    """
    for _, endpoint in _find_all(node, ("browseEndpoint",)):
        browse_id = endpoint.get("browseId")
        if isinstance(browse_id, str) and CHANNEL_ID_RE.match(browse_id):
            base = endpoint.get("canonicalBaseUrl")
            handle = unquote(base[1:]) if isinstance(base, str) and base.startswith("/@") else None
            return browse_id, handle if handle and HANDLE_RE.match(handle) else None
    return None, None


def _image_url(node: Any, depth: int = 0) -> str | None:
    """First safe image URL in a ``thumbnails``/``sources`` list under ``node``."""
    if depth > 16:
        return None
    if isinstance(node, dict):
        for key in ("thumbnails", "sources"):
            images = node.get(key)
            if isinstance(images, list):
                for image in images:
                    url = _safe_thumbnail_url(image.get("url")) if isinstance(image, dict) else None
                    if url:
                        return url
        children: Iterable[Any] = node.values()
    elif isinstance(node, list):
        children = node
    else:
        return None
    for child in children:
        url = _image_url(child, depth + 1)
        if url:
            return url
    return None


def _channel(name: str | None, ref_sources: Iterable[Any], avatar_sources: Iterable[Any]) -> ChannelInfo | None:
    channel_id = handle = None
    for source in ref_sources:
        channel_id, handle = _channel_ref(source)
        if channel_id:
            break
    if not (name or channel_id):
        return None
    avatar = next((url for url in map(_image_url, avatar_sources) if url), None)
    return ChannelInfo(ref=channel_id or handle, id=channel_id, handle=handle, name=name, avatar_url=avatar)


def _valid_id(value: Any) -> str | None:
    return value if isinstance(value, str) and VIDEO_ID_RE.match(value) else None


# --- Item renderers ---------------------------------------------------------

_CLASSIC_RENDERERS = ("videoRenderer", "gridVideoRenderer", "compactVideoRenderer")
_ITEM_KEYS = frozenset({*_CLASSIC_RENDERERS, "lockupViewModel"})
_SHELF_KEYS = frozenset({"richShelfRenderer", "shelfRenderer"})
# Shorts shelves are never searched for items.
_SKIP_KEYS = frozenset({"reelShelfRenderer"})
_UNPLAYABLE: set[str] = {"is_live", "is_upcoming", "post_live"}


def _from_video_renderer(renderer: dict[str, Any]) -> VideoSummary | None:
    """``videoRenderer`` (search-style), ``gridVideoRenderer`` and ``compactVideoRenderer``."""
    video_id = _valid_id(renderer.get("videoId"))
    if video_id is None or _is_short(renderer.get("navigationEndpoint")) or _members_only(renderer.get("badges")):
        return None

    duration_text = _text_of(renderer.get("lengthText"))
    live = False
    upcoming = renderer.get("upcomingEventData") is not None
    for _, overlay in _find_all(renderer.get("thumbnailOverlays"), ("thumbnailOverlayTimeStatusRenderer",)):
        style = overlay.get("style")
        if style == "SHORTS":
            return None
        if style == "LIVE":
            live = True
        elif style == "UPCOMING":
            upcoming = True
        elif duration_text is None:
            duration_text = _text_of(overlay.get("text"))
    for _, badge in _find_all(renderer.get("badges"), ("metadataBadgeRenderer",)):
        live = live or badge.get("style") == "BADGE_STYLE_TYPE_LIVE_NOW"

    stats = _text_of(renderer.get("viewCountText")) or _text_of(renderer.get("shortViewCountText"))
    published = _text_of(renderer.get("publishedTimeText"))
    byline = renderer.get("ownerText") or renderer.get("longBylineText") or renderer.get("shortBylineText")
    avatars = (renderer.get("channelThumbnailSupportedRenderers"), renderer.get("channelThumbnail"),
               renderer.get("avatar"))
    return VideoSummary(
        source="youtube",
        id=video_id,
        title=_text_of(renderer.get("title")) or "Untitled video",
        channel=_channel(_text_of(byline), (byline, *avatars), avatars),
        duration_seconds=parse_duration(duration_text),
        thumbnail_url=pick_thumbnail({"thumbnails": _dig(renderer, "thumbnail", "thumbnails")}, video_id),
        view_count=parse_view_count(stats),
        live_status=_live_status(live=live, upcoming=upcoming, stats=stats, published=published),
        published_text=published,
    )


_STATS_RE = re.compile(r"\b(views?|watching|waiting)\b|^[\d.,]+\s*[KMB]?$", re.IGNORECASE)
_DATE_RE = re.compile(r"\bago\b|^(streamed|premiered|premieres|scheduled)\b", re.IGNORECASE)


def _from_lockup(lockup: dict[str, Any]) -> VideoSummary | None:
    """``lockupViewModel``: the newer card used on topic channels and watch pages."""
    if lockup.get("contentType") != "LOCKUP_CONTENT_TYPE_VIDEO":
        return None  # playlists, albums, mixes ("stations"), podcasts
    video_id = _valid_id(lockup.get("contentId"))
    if video_id is None or _is_short(_dig(lockup, "rendererContext", "commandContext")):
        return None
    meta = _dig(lockup, "metadata", "lockupMetadataViewModel")
    meta = meta if isinstance(meta, dict) else {}
    if _members_only(meta):
        return None
    image = _dig(lockup, "contentImage", "thumbnailViewModel")

    live = upcoming = False
    duration = None
    for _, badge in _find_all(_dig(image, "overlays"), ("thumbnailBadgeViewModel",)):
        text = (_text_of(badge.get("text")) or "").upper()
        if text == "SHORTS":
            return None
        if text == "LIVE" or "LIVE" in str(badge.get("badgeStyle") or ""):
            live = True
        elif text in {"UPCOMING", "PREMIERE"}:
            upcoming = True
        elif duration is None:
            duration = parse_duration(text)

    # Metadata rows hold the channel, then "1.2M views" and "3 weeks ago" (each with a
    # spelled-out accessibility label, which is preferred for display and parsing).
    stats = published = None
    channel_part: dict[str, Any] | None = None
    rows = _dig(meta, "metadata", "contentMetadataViewModel", "metadataRows")
    for row in rows if isinstance(rows, list) else []:
        parts = row.get("metadataParts") if isinstance(row, dict) else None
        for part in parts if isinstance(parts, list) else []:
            text = _text_of(part.get("text")) if isinstance(part, dict) else None
            if not text:
                continue
            label = _text(part.get("accessibilityLabel")) or text
            icon = str(_dig(part, "leadingIcon", "name") or "")
            if _STATS_RE.search(text) or _STATS_RE.search(label) or icon.startswith("PLAY_ARROW"):
                stats = stats or label
            elif _DATE_RE.search(text) or _DATE_RE.search(label):
                published = published or label
            elif channel_part is None:
                channel_part = part

    avatars = (meta.get("image"),)
    return VideoSummary(
        source="youtube",
        id=video_id,
        title=_text_of(meta.get("title")) or "Untitled video",
        channel=_channel(_text_of(channel_part.get("text")) if channel_part else None,
                         (channel_part, *avatars), avatars),
        duration_seconds=duration,
        thumbnail_url=pick_thumbnail({"thumbnails": _dig(image, "image", "sources")}, video_id),
        view_count=parse_view_count(stats),
        live_status=_live_status(live=live, upcoming=upcoming, stats=stats, published=published),
        published_text=published,
    )


def normalize_item(key: str, renderer: Any) -> VideoSummary | None:
    """Normalize one item renderer. Returns ``None`` for anything that isn't a regular video."""
    if not isinstance(renderer, dict):
        return None
    try:
        if key in _CLASSIC_RENDERERS:
            return _from_video_renderer(renderer)
        if key == "lockupViewModel":
            return _from_lockup(renderer)
    except (TypeError, ValueError, AttributeError):  # an unexpected shape: skip the item
        log.debug("skipping malformed %s", key, exc_info=True)
    return None


def _playable(renderers: Iterable[tuple[str, dict[str, Any]]], *, exclude: str | None = None,
              limit: int) -> list[VideoSummary]:
    """Normalize, drop what can't be played here (live, upcoming, non-videos) and dedupe."""
    seen = {exclude} if exclude else set()
    items: list[VideoSummary] = []
    for key, renderer in renderers:
        item = normalize_item(key, renderer)
        if item is None or item.live_status in _UNPLAYABLE or item.id in seen:
            continue
        seen.add(item.id)
        items.append(item)
        if len(items) >= limit:
            break
    return items


# --- Pages ------------------------------------------------------------------

def _shelf_title(shelf: dict[str, Any]) -> str | None:
    title = _text_of(shelf.get("title"))
    if title:
        return title
    for key in ("header", "headerRenderer"):
        for _, node in _find_all(shelf.get(key), ("title", "headline")):
            title = _text_of(node)
            if title:
                return title
    return None


def iter_raw_shelves(data: Any) -> Iterator[tuple[str | None, list[tuple[str, dict[str, Any]]]]]:
    """Every shelf on a page as ``(title, item renderers)``, before any filtering."""
    for _, shelf in _find_all(data, _SHELF_KEYS, skip=_SKIP_KEYS):
        if shelf.get("isShorts") is True:
            continue
        yield _shelf_title(shelf), list(_find_all(shelf, _ITEM_KEYS, skip=_SKIP_KEYS))


def parse_shelves(data: Any) -> list[Shelf]:
    """Shelves of playable videos on a browse page; empty shelves are dropped."""
    shelves: list[Shelf] = []
    for title, renderers in iter_raw_shelves(data):
        items = _playable(renderers, limit=_MAX_SHELF_ITEMS)
        if items:
            shelves.append(Shelf(title=title, items=items))
            if len(shelves) >= _MAX_SHELVES:
                break
    return shelves


def parse_related(data: Any, video_id: str) -> list[VideoSummary]:
    """Playable "Up next" videos from a watch page, excluding the video itself."""
    results = _dig(data, "contents", "twoColumnWatchNextResults", "secondaryResults", "secondaryResults", "results")
    return _playable(_find_all(results, _ITEM_KEYS, skip=_SKIP_KEYS), exclude=video_id, limit=_MAX_RELATED)


T = TypeVar("T")


def _parse_html(html: str, parse: Callable[[dict[str, Any]], T]) -> T | None:
    data = extract_initial_data(html)
    return None if data is None else parse(data)


class YouTubePagesService:
    """Feeds and related videos from public YouTube pages, cached like other metadata."""

    name = PROVIDER

    def __init__(self, settings: Settings, cookies: CookieLoader | None = None) -> None:
        self.settings = settings
        self.cookies = cookies
        self.feed_cache: TTLCache[Feed] = TTLCache(settings.metadata_cache_ttl, settings.metadata_cache_entries)
        self.related_cache: TTLCache[RelatedVideos] = TTLCache(
            settings.metadata_cache_ttl, settings.metadata_cache_entries
        )

    def _require_enabled(self, what: str) -> None:
        if not self.settings.enable_feeds:
            raise AppError("not_found", f"{what} are disabled (YTC_ENABLE_FEEDS=false).", status=404)

    async def _load(self, url: str, parse: Callable[[dict[str, Any]], T], what: str,
                    cookies: http.cookiejar.CookieJar | None = None) -> T:
        # Looked up at call time so tests can monkeypatch the module-level fetcher.
        if cookies is None:
            html = await fetch_html(url, timeout=self.settings.discovery_timeout)
        else:
            html = await fetch_html(url, timeout=self.settings.discovery_timeout, cookies=cookies)
        # Pages are 1-3 MB of JSON: parse off the event loop.
        result = await asyncio.to_thread(_parse_html, html, parse)
        if result is None:
            log.warning("no ytInitialData in %s", url)
            raise AppError("extraction_failed", f"Could not read {what}.", status=502,
                           hint="YouTube may have changed its page layout. Try again later.", retryable=True)
        return result

    def feeds(self) -> FeedList:
        if not self.settings.enable_feeds:
            return FeedList(feeds=[])
        return FeedList(feeds=[FeedInfo(id=source.id, title=source.title) for source in FEEDS.values()])

    async def feed(self, feed_id: str) -> Feed:
        self._require_enabled("Feeds")
        source = FEEDS.get(feed_id)
        if source is None:
            raise AppError("not_found", "Unknown feed.", status=404, hint=f"Available feeds: {', '.join(FEEDS)}.")

        async def load() -> Feed:
            shelves = await self._load(source.url, parse_shelves, f"YouTube's {source.title} page")
            log.debug("feed %s: %d shelves, %d videos", source.id, len(shelves),
                      sum(len(shelf.items) for shelf in shelves))
            return Feed(id=source.id, title=source.title, shelves=shelves, provider=PROVIDER)

        return await self.feed_cache.get_or_fetch(("feed", source.id), load)

    async def _session_cookies(self) -> http.cookiejar.CookieJar | None:
        """The signed-in session's jar, or ``None`` (not configured, or unreadable right now)."""
        if self.cookies is None or not self.cookies.configured:
            return None
        try:
            return await self.cookies.jar()
        except AppError as exc:
            log.warning("related videos fall back to the logged-out page: %s", exc.message)
            return None

    async def related(self, video_id: str) -> RelatedVideos:
        """"Up next" for a video: personalized when signed in, else from the logged-out page."""
        self._require_enabled("Related videos")
        video_id = validate_video_id(video_id)
        cookies = await self._session_cookies()

        async def load() -> RelatedVideos:
            items = await self._load(watch_url(video_id), lambda data: parse_related(data, video_id),
                                     "this video's watch page", cookies=cookies)
            return RelatedVideos(video_id=video_id, items=items, provider=PROVIDER)

        key = ("related", video_id, cookies is not None)
        return await self.related_cache.get_or_fetch(key, load)

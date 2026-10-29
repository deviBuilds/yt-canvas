"""The opt-in signed-in YouTube session: ``/api/me`` and the account's own feeds.

``/api/me`` fetches YouTube's home page with the session's youtube.com cookies
(see :mod:`app.cookies`), reads the login state from the page's ``ytcfg``
(``"LOGGED_IN":true``), the account avatar from the top bar and the home-feed
filter chips from ``ytInitialData``. Personal feeds (Recommended, Subscriptions,
History, Watch later, Liked videos) are listed by yt-dlp, which reads the same
cookies itself, and paged like channels.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..config import Settings
from ..cookies import CookieLoader
from ..errors import AppError
from ..models import Me, Page, VideoSummary
from . import youtube_pages
from .normalize import _safe_thumbnail_url
from .service import TTLCache, check_offset
from .youtube_pages import _ITEM_KEYS, _SKIP_KEYS, _dig, _find_all, _playable, _text_of, extract_initial_data
from .ytdlp_provider import YtDlpDiscoveryProvider

log = logging.getLogger(__name__)

HOME_URL = "https://www.youtube.com/"
ME_TTL = 5 * 60
ME_FAILURE_TTL = 30
FEED_TTL = 2 * 60
_MAX_CHIPS = 30


@dataclass(frozen=True)
class PersonalFeed:
    id: str
    title: str
    # A fixed yt-dlp keyword or URL; never built from user input.
    target: str


FEEDS: dict[str, PersonalFeed] = {
    feed.id: feed
    for feed in (
        PersonalFeed("recommended", "Recommended", ":ytrec"),
        PersonalFeed("subscriptions", "Subscriptions", ":ytsubs"),
        PersonalFeed("history", "History", ":ythis"),
        PersonalFeed("watch_later", "Watch later", ":ytwatchlater"),
        PersonalFeed("liked", "Liked videos", "https://www.youtube.com/playlist?list=LL"),
    )
}

NOT_CONFIGURED_HINT = "Set YTC_YTDLP_COOKIES_FROM_BROWSER (see Signing in in the README)."


# --- Home page parsing --------------------------------------------------------

_LOGGED_IN_RE = re.compile(r'"LOGGED_IN"\s*:\s*(true|false)')
_CHIP_BARS = ("feedFilterChipBarRenderer", "chipBarViewModel", "chipCloudRenderer")
# Classic chips carry a text node ({"simpleText"} / {"runs"}); view-model chips a plain string.
_CHIP_KEYS = ("chipCloudChipRenderer", "chipViewModel")


# Chips that are YouTube controls rather than topics.
_NOT_TOPICS = {"all", "custom feed"}
_MAX_HOME_VIDEOS = 60


@dataclass(frozen=True)
class HomeState:
    logged_in: bool | None  # None: the page carried no login state
    avatar_url: str | None = None
    chips: tuple[str, ...] = ()
    # The home grid's first videos, with the views, ages and channel avatars that
    # yt-dlp's flat "recommended" listing leaves out.
    videos: tuple[VideoSummary, ...] = ()


def _size(image: dict[str, Any]) -> int:
    for key in ("width", "height"):
        value = image.get(key)
        if isinstance(value, int) and value > 0:
            return value
    return 0


def _largest_image(images: Any) -> str | None:
    """The largest safe (YouTube/Google-hosted) image in a ``thumbnails``/``sources`` list."""
    best, best_size = None, -1
    for image in images if isinstance(images, list) else []:
        if not isinstance(image, dict):
            continue
        url = _safe_thumbnail_url(image.get("url"))
        if url and _size(image) >= best_size:
            best, best_size = url, _size(image)
    return best


def parse_avatar(data: Any) -> str | None:
    """The account avatar from the top bar (logged-out pages have a "Sign in" button instead)."""
    topbar = _dig(data, "topbar")
    for _, button in _find_all(topbar, ("topbarMenuButtonRenderer",)):
        url = _largest_image(_dig(button, "avatar", "thumbnails"))
        if url:
            return url
    for _, avatar in _find_all(topbar, ("avatarViewModel",)):
        url = _largest_image(_dig(avatar, "image", "sources"))
        if url:
            return url
    return None


def _chip_labels(bar: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    seen: set[str] = set()
    for _, chip in _find_all(bar, _CHIP_KEYS):
        label = _text_of(chip.get("text"), 60)
        if not label or label.casefold() in _NOT_TOPICS or label.casefold() in seen:
            continue
        seen.add(label.casefold())
        labels.append(label)
        if len(labels) >= _MAX_CHIPS:
            break
    return labels


def parse_chips(data: Any) -> list[str]:
    """Labels of the home feed's filter chip bar, without "All".

    The bar sits in the rich grid's header; any other chip bar on the page is only a
    fallback.
    """
    grid_headers = [grid.get("header") for _, grid in _find_all(data, ("richGridRenderer",))]
    for scope in (grid_headers, data):
        for _, bar in _find_all(scope, _CHIP_BARS, skip=frozenset({"topbar"})):
            labels = _chip_labels(bar)
            if labels:
                return labels
    return []


def parse_home_videos(data: Any) -> list[VideoSummary]:
    """Playable videos in the home page's rich grid (Shorts and other shelves are skipped)."""
    grids = [grid.get("contents") for _, grid in _find_all(data, ("richGridRenderer",))]
    return _playable(_find_all(grids, _ITEM_KEYS, skip=_SKIP_KEYS | {"richSectionRenderer"}), limit=_MAX_HOME_VIDEOS)


def enrich(page: Page, videos: tuple[VideoSummary, ...]) -> Page:
    """Fill in what yt-dlp's flat listing lacks (views, age, channel avatar) from the home page."""
    known = {video.id: video for video in videos}
    items = []
    for item in page.items:
        extra = known.get(item.id)
        if extra is None:
            items.append(item)
            continue
        channel = item.channel
        if channel is not None and extra.channel is not None and not channel.avatar_url:
            channel = channel.model_copy(update={"avatar_url": extra.channel.avatar_url})
        items.append(item.model_copy(update={
            "view_count": item.view_count if item.view_count is not None else extra.view_count,
            "published_text": item.published_text or extra.published_text,
            "channel": channel or extra.channel,
        }))
    return page.model_copy(update={"items": items})


def parse_home(html: str) -> HomeState:
    match = _LOGGED_IN_RE.search(html)
    if match is None:
        return HomeState(logged_in=None)
    if match.group(1) != "true":
        return HomeState(logged_in=False)
    data = extract_initial_data(html) or {}
    return HomeState(logged_in=True, avatar_url=parse_avatar(data), chips=tuple(parse_chips(data)),
                     videos=tuple(parse_home_videos(data)))


# --- Service ------------------------------------------------------------------

def _detail(error: AppError) -> str:
    return f"{error.message} {error.hint}" if error.hint else error.message


@dataclass(frozen=True)
class _Status:
    me: Me
    error: AppError | None  # why the session isn't usable; None when signed in
    home_videos: tuple[VideoSummary, ...] = ()


class AccountService:
    def __init__(self, settings: Settings, cookies: CookieLoader, provider: YtDlpDiscoveryProvider | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.settings = settings
        self.cookies = cookies
        self.provider = provider or YtDlpDiscoveryProvider(settings)
        self._clock = clock
        self.feed_cache: TTLCache[Page] = TTLCache(FEED_TTL if settings.metadata_cache_ttl > 0 else 0,
                                                   settings.metadata_cache_entries)
        self._status: tuple[float, _Status] | None = None
        self._lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return self.settings.signed_in_configured

    async def me(self) -> Me:
        if not self.configured:
            return Me(configured=False, signed_in=False)
        return (await self.status()).me

    async def status(self) -> _Status:
        """The session's state; successes are cached 5 minutes, anything else 30 seconds."""
        cached = self._status
        if cached is not None and self._clock() < cached[0]:
            return cached[1]
        async with self._lock:
            cached = self._status
            if cached is not None and self._clock() < cached[0]:
                return cached[1]
            status = await self._check()
            ttl = ME_TTL if status.error is None else ME_FAILURE_TTL
            self._status = (self._clock() + ttl, status)
            return status

    def _failed(self, error: AppError) -> _Status:
        me = Me(configured=True, signed_in=False, source=self.settings.signin_source, detail=_detail(error))
        return _Status(me, error)

    async def _check(self) -> _Status:
        try:
            jar = await self.cookies.jar()
            # Looked up at call time so tests can monkeypatch the module-level fetcher.
            html = await youtube_pages.fetch_html(HOME_URL, timeout=self.settings.discovery_timeout, cookies=jar)
        except AppError as exc:
            return self._failed(exc)
        state = await asyncio.to_thread(parse_home, html)  # the page is ~1-2 MB
        if state.logged_in is None:
            log.warning("YouTube's home page carried no login state")
            return self._failed(AppError(
                "extraction_failed", "Couldn't tell whether YouTube accepted the cookies.", status=502,
                hint="YouTube may have changed its page layout. Try again later.", retryable=True))
        if not state.logged_in:
            log.warning("YouTube treated the cookies from %s as signed out", self.cookies.source_label)
            self.cookies.invalidate()  # re-read them next time, e.g. after signing in again
            return self._failed(self._signed_out_error())
        return _Status(Me(configured=True, signed_in=True, source=self.settings.signin_source,
                          avatar_url=state.avatar_url, chips=list(state.chips)), None, state.videos)

    def _signed_out_error(self) -> AppError:
        source = self.cookies.source_label
        if self.settings.browser_spec is not None:
            hint = f"Sign in to YouTube in {source}, then reload."
        else:
            hint = "Export a fresh cookies.txt while signed in to YouTube, then reload."
        return AppError("signed_out", f"YouTube didn't accept the cookies from {source}: they're signed out "
                        "or expired.", status=401, hint=hint)

    async def feed(self, feed_id: str, offset: int = 0) -> Page:
        source = FEEDS.get(feed_id)
        if source is None:
            raise AppError("not_found", "Unknown feed.", status=404, hint=f"Available feeds: {', '.join(FEEDS)}.")
        if not self.configured:
            raise AppError("signed_out", "YouTube sign-in isn't set up.", status=401, hint=NOT_CONFIGURED_HINT)
        offset = check_offset(self.settings, offset, self.settings.max_list_results)
        limit = self.settings.page_size

        async def load() -> Page:
            status = await self.status()
            if status.error is not None:
                raise status.error.clone()
            try:
                page = await self.provider.feed(source.target, title=source.title, offset=offset, limit=limit)
                return enrich(page, status.home_videos) if source.id == "recommended" else page
            except AppError as exc:
                # Signed out since the last check: yt-dlp asks for a login, and the Watch later
                # and Liked playlists "don't exist".
                if exc.code not in {"signed_out", "not_found"}:
                    raise
                self._status = None  # check the session again next time
                raise self._signed_out_error() from None

        return await self.feed_cache.get_or_fetch(("me-feed", source.id, offset, limit), load)

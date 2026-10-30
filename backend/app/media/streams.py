"""Streaming playback: DASH tracks proxied in byte ranges into Media Source Extensions.

The alternative to "Download first" (:mod:`app.media.jobs`): nothing is stored on disk.

``POST /api/streams`` resolves a video once with yt-dlp, the same extraction the download
path uses (base args and sign-in cookies, live/restricted checks, ``--mark-watched``), and
keeps each suitable track's signed googlevideo URL and yt-dlp request headers in memory.
The browser then reads ``GET /api/streams/{session}/tracks/{track}?start=&end=``, which is
forwarded upstream as an HTTP ``Range`` request. Signed URLs never leave this module: they
are not returned to clients and never logged.

Suitable tracks are YouTube's single-file DASH representations: ``https`` (no fragments),
DRM-free, video-only H.264/AV1 in MP4 and audio-only AAC in M4A. Each starts with ``ftyp``
and ``moov``, followed by one ``sidx`` box that indexes its ``moof``/``mdat`` segments.

* A resolve is cached per video until shortly before YouTube's URLs ``expire`` (at most
  :data:`SESSION_TTL_SECONDS`) and shared by new sessions; a session expires with the
  resolve it started from. Both caches are LRU-capped.
* When YouTube answers 403/410 (URL expired or revoked), the video is resolved again once,
  the same format is looked up and the request retried; at most once a minute per video.
* Demo sessions serve locally generated files the same way (:mod:`app.media.demo_streams`).
"""

from __future__ import annotations

import asyncio
import http.client
import logging
import math
import re
import secrets
import time
import traceback
import urllib.error
import urllib.request
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol
from urllib.parse import parse_qs, urlparse

import anyio

from ..config import Settings
from ..discovery.normalize import normalize_entry
from ..errors import AppError, redact
from ..models import VideoSummary
from ..validation import validate_video_id, watch_url
from ..session import session_tag, youtube_settings
from ..ytdlp import base_args, run_json
from .models import StreamAudioTrack, StreamVideoTrack, StreamView
from .youtube import check_playable, mark_watched_args

log = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 5 * 60 * 60
MAX_SESSIONS = 64
MAX_RESOLVES = 64
# Stop handing out signed URLs this long before YouTube's ``expire`` time.
URL_EXPIRY_MARGIN_SECONDS = 10 * 60
# A new session doesn't reuse a cached resolve with less time left than this (or half the TTL).
MIN_REUSE_SECONDS = 30 * 60
REFRESH_COOLDOWN_SECONDS = 60
UPSTREAM_TIMEOUT_SECONDS = 30
# yt-dlp's http_chunk_size for YouTube: larger single requests get throttled.
DEFAULT_UPSTREAM_CHUNK = 10 * 1024 * 1024
_READ_CHUNK = 1024 * 1024
# Never forwarded upstream: cookies stay with yt-dlp; the rest is set per request.
_DROPPED_HEADERS = frozenset({"cookie", "authorization", "proxy-authorization", "range", "host",
                              "content-length", "accept-encoding", "connection", "transfer-encoding"})
_CONTENT_RANGE_RE = re.compile(r"^\s*bytes\s+(\d+)-(\d+)/(\d+|\*)\s*$", re.IGNORECASE)

TrackKind = Literal["video", "audio"]


def stream_unavailable() -> AppError:
    return AppError("stream_unavailable", "This video can't be streamed; download it instead.", status=422,
                    retryable=False)


def stream_expired() -> AppError:
    return AppError("stream_expired", "This stream session has expired.", status=404,
                    hint="Start a new stream session for this video.", retryable=True)


def _forbidden() -> AppError:
    return AppError("download_forbidden", "YouTube refused to send the media data (HTTP 403).", status=502,
                    hint="Streaming isn't working for this video right now; the player will download it "
                         "instead.", retryable=True)


def _bad_upstream(status: int | None = None) -> AppError:
    detail = f" (HTTP {status})" if status else ""
    return AppError("download_failed", f"YouTube sent an unexpected response for this part of the video{detail}.",
                    status=502, retryable=True)


# -- data ----------------------------------------------------------------------------


@dataclass(eq=False)
class Track:
    id: str
    kind: TrackKind
    view: StreamVideoTrack | StreamAudioTrack
    size: int | None
    # Signed googlevideo URL (IP-bound, short-lived): never log it or send it to clients.
    url: str | None = field(default=None, repr=False)
    headers: dict[str, str] = field(default_factory=dict, repr=False)
    path: Path | None = None  # local file (demo tracks)
    chunk_size: int = DEFAULT_UPSTREAM_CHUNK


@dataclass(eq=False)
class ResolvedStream:
    source: str
    video_id: str
    video: VideoSummary
    duration: float | None
    tracks: dict[str, Track]  # video tracks first, each kind in API order
    url_expires_at: float | None = None  # earliest ``expire`` of the signed URLs
    created_at: float = 0.0
    expires_at: float = 0.0

    def of_kind(self, kind: TrackKind) -> list[Track]:
        return [track for track in self.tracks.values() if track.kind == kind]


@dataclass(eq=False)
class StreamSession:
    id: str
    key: str
    resolved: ResolvedStream
    created_at: float
    expires_at: float


class StreamResolver(Protocol):
    source: str

    def validate_ref(self, ref: str) -> str:
        """Return the canonical reference or raise ``AppError``."""
        ...

    async def resolve(self, ref: str, *, refresh: bool = False) -> ResolvedStream:
        """Look up the tracks. ``refresh`` is set when re-resolving after expired URLs."""
        ...


# -- track selection --------------------------------------------------------------------


def _positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and value > 0 else None


def url_params(url: str) -> dict[str, str]:
    try:
        query = parse_qs(urlparse(url).query)
    except ValueError:
        return {}
    return {key: values[0] for key, values in query.items() if values}


def _param_number(params: dict[str, str], name: str) -> float | None:
    try:
        return _positive(float(params[name]))
    except (KeyError, ValueError):
        return None


def _bitrate(fmt: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        kbps = _positive(fmt.get(key))
        if kbps:
            return int(round(kbps * 1000))
    return None


def _exact_size(fmt: dict[str, Any], params: dict[str, str]) -> int | None:
    """Exact byte size (``filesize`` or the URL's ``clen``); estimates are useless for ranges."""
    size = fmt.get("filesize")
    if isinstance(size, int) and not isinstance(size, bool) and size > 0:
        return size
    clen = _param_number(params, "clen")
    return int(clen) if clen else None


def _headers(fmt: dict[str, Any]) -> dict[str, str]:
    raw = fmt.get("http_headers")
    if not isinstance(raw, dict):
        return {}
    return {
        key: value for key, value in raw.items()
        if isinstance(key, str) and isinstance(value, str) and key.lower() not in _DROPPED_HEADERS
        and not any(c in key + value for c in "\r\n")
    }


def _chunk_size(fmt: dict[str, Any]) -> int:
    options = fmt.get("downloader_options")
    value = options.get("http_chunk_size") if isinstance(options, dict) else None
    if isinstance(value, int) and not isinstance(value, bool) and value >= 1024 * 1024:
        return value
    return DEFAULT_UPSTREAM_CHUNK


def _fps(value: Any) -> int | float | None:
    fps = _positive(value)
    if fps is None:
        return None
    return int(fps) if fps.is_integer() else round(fps, 3)


def _is_drc(fmt: dict[str, Any]) -> bool:
    return "drc" in str(fmt.get("format_id", "")).lower() or "drc" in str(fmt.get("format_note", "")).lower()


def select_stream_tracks(formats: Any, *, max_height: int) -> tuple[list[Track], list[Track]]:
    """``(video_tracks, audio_tracks)`` that MSE can play straight from YouTube.

    Video: height desc, then bitrate desc. Audio: bitrate desc, except that when YouTube
    offers several languages the original/default one comes first (yt-dlp's
    ``language_preference``), then stereo before multichannel; on equal bitrates the
    non-DRC track comes first.
    """
    video: list[Track] = []
    audio: list[tuple[tuple, Track]] = []
    for fmt in formats if isinstance(formats, list) else []:
        if not isinstance(fmt, dict):
            continue
        format_id, url = fmt.get("format_id"), fmt.get("url")
        if not isinstance(format_id, str) or not format_id or not isinstance(url, str):
            continue
        if not url.startswith("https://") or fmt.get("protocol") != "https":
            continue
        if fmt.get("fragments") or fmt.get("has_drm"):
            continue
        vcodec = fmt.get("vcodec") if isinstance(fmt.get("vcodec"), str) else ""
        acodec = fmt.get("acodec") if isinstance(fmt.get("acodec"), str) else ""
        params = url_params(url)
        size = _exact_size(fmt, params)
        common = {"size": size, "url": url, "headers": _headers(fmt), "chunk_size": _chunk_size(fmt)}

        if fmt.get("ext") == "mp4" and vcodec.startswith(("avc1", "av01")) and acodec == "none":
            height = _positive(fmt.get("height"))
            if height is None or height > max_height:
                continue
            width = _positive(fmt.get("width"))
            view = StreamVideoTrack(
                id=format_id, mime_type="video/mp4", codecs=vcodec,
                width=int(width) if width else None, height=int(height), fps=_fps(fmt.get("fps")),
                bitrate=_bitrate(fmt, "tbr", "vbr"), size_bytes=size,
            )
            video.append(Track(format_id, "video", view, **common))
        elif fmt.get("ext") == "m4a" and acodec.startswith("mp4a") and vcodec == "none":
            channels = _positive(fmt.get("audio_channels"))
            view = StreamAudioTrack(id=format_id, mime_type="audio/mp4", codecs=acodec,
                                    bitrate=_bitrate(fmt, "tbr", "abr"), size_bytes=size,
                                    channels=int(channels) if channels else None)
            preference = fmt.get("language_preference")
            # Stereo before multichannel: YouTube lists 5.1 AAC (itag 258) first, which costs
            # about 3x the bandwidth of stereo for no gain on most speakers.
            rank = (preference if isinstance(preference, (int, float)) and not isinstance(preference, bool) else 0,
                    (view.channels or 2) <= 2, view.bitrate or 0, not _is_drc(fmt))
            audio.append((rank, Track(format_id, "audio", view, **common)))

    video.sort(key=lambda t: (t.view.height or 0, t.view.bitrate or 0), reverse=True)
    audio.sort(key=lambda pair: pair[0], reverse=True)
    return video, [track for _, track in audio]


# -- YouTube -----------------------------------------------------------------------------


class YouTubeStreamResolver:
    source = "youtube"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def validate_ref(self, ref: str) -> str:
        return validate_video_id(ref)

    async def extract(self, video_id: str, *, mark_watched: bool) -> dict[str, Any]:
        """yt-dlp's ``-J`` info for the video (signed in when configured, like every call)."""
        args = [*base_args(self.settings), "--no-playlist", "--dump-single-json", "--skip-download",
                *(mark_watched_args(self.settings) if mark_watched else []), "--", watch_url(video_id)]
        return await run_json(self.settings, args, timeout=self.settings.resolve_timeout,
                              context=f"stream resolve {video_id}")

    async def resolve(self, ref: str, *, refresh: bool = False) -> ResolvedStream:
        video_id = self.validate_ref(ref)
        # Marking watched once per playback is enough; a refresh only renews the URLs.
        info = await self.extract(video_id, mark_watched=not refresh)
        if info.get("id") != video_id:
            raise AppError("extraction_failed", "yt-dlp returned metadata for a different video.", status=502)
        check_playable(info, self.settings, check_duration=False)
        video = normalize_entry({**info, "ie_key": "Youtube"},
                                signed_in=youtube_settings(self.settings).signed_in_configured)

        video_tracks, audio_tracks = select_stream_tracks(info.get("formats"),
                                                          max_height=self.settings.stream_max_height)
        if not video_tracks or not audio_tracks:
            log.info("stream resolve %s: no streamable track pair (%d video, %d audio)", video_id,
                     len(video_tracks), len(audio_tracks))
            raise stream_unavailable()
        tracks = [*video_tracks, *audio_tracks]
        all_params = [url_params(track.url or "") for track in tracks]
        # The URLs' ``dur`` is exact (info "duration" is whole seconds); MSE needs the longest.
        durations = [d for d in (_param_number(p, "dur") for p in all_params) if d]
        expiries = [e for e in (_param_number(p, "expire") for p in all_params) if e]
        duration = max(durations) if durations else _positive(info.get("duration"))
        best = video_tracks[0].view
        log.info("stream resolve %s: %d video tracks (best %s %sp), %d audio tracks", video_id,
                 len(video_tracks), best.codecs, getattr(best, "height", None), len(audio_tracks))
        return ResolvedStream(
            source="youtube",
            video_id=video_id,
            video=video or VideoSummary(source="youtube", id=video_id, title="YouTube video"),
            duration=duration,
            tracks={track.id: track for track in tracks},
            url_expires_at=min(expiries) if expiries else None,
        )


# -- upstream fetching ---------------------------------------------------------------------


@dataclass
class UpstreamResponse:
    status: int
    body: bytes = b""
    content_range: str | None = None


Fetcher = Callable[[str, dict[str, str], int, int, float], UpstreamResponse]


def _read_upto(response: Any, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = response.read(min(remaining, _READ_CHUNK))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _timeout() -> AppError:
    return AppError("timeout", "YouTube took too long to send the media data.", status=504, retryable=True)


def _network_error() -> AppError:
    return AppError("network_error", "Could not reach YouTube.", status=502,
                    hint="Check the server's internet connection and try again.", retryable=True)


def fetch_range(url: str, headers: dict[str, str], start: int, end: int,
                timeout: float = UPSTREAM_TIMEOUT_SECONDS) -> UpstreamResponse:
    """GET ``bytes=start-end`` of ``url`` (blocking; run it in a worker thread).

    Reads at most ``end - start + 1`` bytes. HTTP errors come back as a status; network
    problems raise ``AppError``. Neither the URL nor anything derived from it is logged.
    """
    request = urllib.request.Request(url, headers={**headers, "Range": f"bytes={start}-{end}"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = _read_upto(response, end - start + 1)
            return UpstreamResponse(response.status, body, response.headers.get("Content-Range"))
    except urllib.error.HTTPError as exc:
        status = exc.code
        exc.close()
        return UpstreamResponse(status)
    except TimeoutError:
        raise _timeout() from None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise _timeout() from None
        log.warning("streaming: could not reach YouTube: %s", redact(str(exc.reason))[:200])
        raise _network_error() from None
    except (OSError, http.client.HTTPException) as exc:
        log.warning("streaming: connection to YouTube failed: %s", type(exc).__name__)
        raise _network_error() from None


def _read_file(path: Path, start: int, end: int) -> bytes:
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            return handle.read(end - start + 1)
    except FileNotFoundError:
        raise stream_expired() from None


class _Forbidden(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


# -- sessions --------------------------------------------------------------------------------


class StreamManager:
    """In-memory stream sessions and resolves; byte-range reads with one re-resolve on 403/410."""

    def __init__(
        self,
        settings: Settings,
        resolvers: dict[str, StreamResolver],
        *,
        fetcher: Fetcher | None = None,
        clock: Callable[[], float] = time.time,
        session_ttl: float = SESSION_TTL_SECONDS,
        max_sessions: int = MAX_SESSIONS,
        max_resolves: int = MAX_RESOLVES,
    ) -> None:
        self.settings = settings
        self.resolvers = resolvers
        self._fetcher = fetcher
        self._clock = clock
        self.session_ttl = session_ttl
        self.max_sessions = max_sessions
        self.max_resolves = max_resolves
        self._sessions: OrderedDict[str, StreamSession] = OrderedDict()
        self._resolves: OrderedDict[str, ResolvedStream] = OrderedDict()
        self._inflight: dict[str, asyncio.Task[ResolvedStream]] = {}
        self._refreshed_at: dict[str, float] = {}

    # -- public API --------------------------------------------------------------------

    async def create(self, source: str, ref: str) -> StreamView:
        resolver = self.resolvers.get(source)
        if resolver is None:
            raise AppError("invalid_input", f"Unknown media source {source!r}.")
        ref = resolver.validate_ref(ref)
        # Resolved with someone's cookies, a session is only reused for them.
        tag = session_tag()
        key = f"{source}:{ref}" + (f":{tag}" if tag else "")
        self.prune()
        resolved = self._resolves.get(key)
        min_left = min(MIN_REUSE_SECONDS, self.session_ttl / 2)
        if resolved is None or resolved.expires_at - self._clock() < min_left:
            resolved = await self._resolve(key, resolver, ref, refresh=False)
        else:
            self._resolves.move_to_end(key)
        now = self._clock()
        session = StreamSession(id=secrets.token_urlsafe(18), key=key, resolved=resolved, created_at=now,
                                expires_at=resolved.expires_at)
        self._sessions[session.id] = session
        while len(self._sessions) > self.max_sessions:
            self._sessions.popitem(last=False)
        log.info("stream session for %s: %d video and %d audio tracks, expires in %d min", key,
                 len(resolved.of_kind("video")), len(resolved.of_kind("audio")),
                 (session.expires_at - now) // 60)
        return self.view(session)

    def view(self, session: StreamSession) -> StreamView:
        resolved = session.resolved
        return StreamView(
            session_id=session.id,
            source=resolved.source,  # type: ignore[arg-type]
            video_id=resolved.video_id,
            video=resolved.video,
            duration_seconds=resolved.duration,
            video_tracks=[t.view for t in resolved.of_kind("video")],  # type: ignore[misc]
            audio_tracks=[t.view for t in resolved.of_kind("audio")],  # type: ignore[misc]
            expires_at=session.expires_at,
        )

    async def read(self, session_id: str, track_id: str, start: int, end: int) -> bytes:
        """Bytes ``start..end`` (inclusive; clamped to the track size) of a session's track."""
        session = self._session(session_id)
        track = session.resolved.tracks.get(track_id)
        if track is None:
            raise AppError("not_found", "This stream has no such track.", status=404)
        start, end = self._check_range(track, start, end)
        try:
            return await self._read(track, start, end)
        except _Forbidden as exc:
            log.info("stream %s: YouTube answered HTTP %d for track %s; resolving the video again",
                     session.key, exc.status, track_id)

        fresh = await self._refresh(session)
        track = fresh.tracks.get(track_id) if fresh is not None else None
        if track is None:
            raise _forbidden()
        start, end = self._check_range(track, start, end)
        try:
            return await self._read(track, start, end)
        except _Forbidden as exc:
            log.warning("stream %s: track %s still refused (HTTP %d) after resolving again",
                        session.key, track_id, exc.status)
            raise _forbidden() from None

    def prune(self) -> None:
        now = self._clock()
        for session_id, session in list(self._sessions.items()):
            if session.expires_at <= now:
                del self._sessions[session_id]
        for key, resolved in list(self._resolves.items()):
            if resolved.expires_at <= now:
                del self._resolves[key]
        for key, at in list(self._refreshed_at.items()):
            if now - at >= REFRESH_COOLDOWN_SECONDS:
                del self._refreshed_at[key]

    async def shutdown(self) -> None:
        tasks = list(self._inflight.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # -- internals ------------------------------------------------------------------------

    def _session(self, session_id: str) -> StreamSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise stream_expired()
        if session.expires_at <= self._clock():
            del self._sessions[session_id]
            raise stream_expired()
        self._sessions.move_to_end(session_id)
        return session

    def _check_range(self, track: Track, start: int, end: int) -> tuple[int, int]:
        limit = self.settings.stream_max_range_bytes
        if start < 0 or end < start:
            raise AppError("invalid_input", "The range must satisfy 0 <= start <= end.", status=400)
        if end - start + 1 > limit:
            raise AppError("invalid_input", f"A range may span at most {limit // (1024 * 1024)} MiB.", status=400,
                           hint="Request smaller ranges, or raise YTC_STREAM_MAX_RANGE_MB.")
        if track.size is not None:
            if start >= track.size:
                raise AppError("invalid_input", "The range starts past the end of the track.", status=416)
            end = min(end, track.size - 1)
        return start, end

    async def _resolve(self, key: str, resolver: StreamResolver, ref: str, *, refresh: bool) -> ResolvedStream:
        """Resolve ``key``, sharing one in-flight resolve between concurrent callers."""
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._run_resolve(key, resolver, ref, refresh), name=f"stream-resolve-{key}")
            self._inflight[key] = task
            task.add_done_callback(lambda done, key=key: self._resolve_done(key, done))
        try:
            # A disconnecting client must not cancel a resolve other requests are waiting for.
            return await asyncio.shield(task)
        except AppError as exc:
            raise exc.clone() from None

    def _resolve_done(self, key: str, task: asyncio.Task[ResolvedStream]) -> None:
        if self._inflight.get(key) is task:
            del self._inflight[key]
        if not task.cancelled():
            task.exception()  # retrieved here, so an error nobody awaited isn't reported as lost

    async def _run_resolve(self, key: str, resolver: StreamResolver, ref: str, refresh: bool) -> ResolvedStream:
        try:
            resolved = await resolver.resolve(ref, refresh=refresh)
        except (AppError, asyncio.CancelledError):
            raise
        except Exception:
            log.error("stream resolve for %s crashed:\n%s", key, redact(traceback.format_exc()))
            raise AppError("internal_error", "Something went wrong while looking up this video.", status=500,
                           retryable=True) from None
        now = self._clock()
        expires_at = now + self.session_ttl
        if resolved.url_expires_at is not None:
            expires_at = min(expires_at, max(now + 60, resolved.url_expires_at - URL_EXPIRY_MARGIN_SECONDS))
        resolved.created_at, resolved.expires_at = now, expires_at
        self._resolves[key] = resolved
        self._resolves.move_to_end(key)
        while len(self._resolves) > self.max_resolves:
            self._resolves.popitem(last=False)
        return resolved

    async def _refresh(self, session: StreamSession) -> ResolvedStream | None:
        """A newer resolve for the session's video, or ``None`` if one was made too recently."""
        stale, key = session.resolved, session.key
        resolver = self.resolvers.get(stale.source)
        if resolver is None:
            return None
        current = self._resolves.get(key)
        if current is not None and current is not stale and current.created_at >= stale.created_at:
            session.resolved = current  # another request already renewed the URLs
            return current
        if key not in self._inflight:
            now = self._clock()
            last = self._refreshed_at.get(key)
            if last is not None and now - last < REFRESH_COOLDOWN_SECONDS:
                log.info("stream %s: resolved again %d s ago; not retrying yet", key, now - last)
                return None
            self._refreshed_at[key] = now
            if current is stale:
                del self._resolves[key]
        fresh = await self._resolve(key, resolver, stale.video_id, refresh=True)
        session.resolved = fresh
        return fresh

    async def _read(self, track: Track, start: int, end: int) -> bytes:
        if track.path is not None:
            return await anyio.to_thread.run_sync(_read_file, track.path, start, end)
        parts: list[bytes] = []
        position = start
        while position <= end:
            stop = min(end, position + track.chunk_size - 1)
            body, at_eof = await self._fetch_part(track, position, stop)
            parts.append(body)
            position += len(body)
            if at_eof or not body:
                break
        return b"".join(parts)

    async def _fetch_part(self, track: Track, start: int, end: int) -> tuple[bytes, bool]:
        """One upstream request: ``(body, reached_end_of_track)``."""
        assert track.url is not None
        fetcher = self._fetcher or fetch_range
        response = await anyio.to_thread.run_sync(fetcher, track.url, track.headers, start, end,
                                                  UPSTREAM_TIMEOUT_SECONDS)
        status, length = response.status, end - start + 1
        if status in (403, 410):
            raise _Forbidden(status)
        if status == 416:
            raise AppError("invalid_input", "The range starts past the end of the track.", status=416)
        if status == 429:
            raise AppError("rate_limited", "YouTube is rate-limiting requests from this server.", status=503,
                           hint="Wait a few minutes and try again.", retryable=True)
        if status == 206:
            match = _CONTENT_RANGE_RE.match(response.content_range or "")
            if match is None or int(match.group(1)) != start:
                raise _bad_upstream()
            last = int(match.group(2))
            if match.group(3) != "*" and track.size is None:
                track.size = track.view.size_bytes = int(match.group(3))
            expected = min(last, end) - start + 1
            if len(response.body) < expected:
                raise _bad_upstream()
            return response.body[:expected], last < end
        if status == 200 and start == 0:
            # The whole file instead of a range: its first ``length`` bytes are the range.
            body = response.body[:length]
            return body, len(body) < length
        raise _bad_upstream(status)

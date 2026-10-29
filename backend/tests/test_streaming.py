"""Streaming playback: track selection, sessions, range proxying and demo tracks."""

from __future__ import annotations

import asyncio
import email.message
import io
import logging
import re
import shutil
import struct
import subprocess
import urllib.error
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.errors import AppError
from app.main import create_app
from app.media import streams
from app.media.demo import SAMPLES, generator_args
from app.media.demo_streams import DemoStreamResolver, stream_generator_args
from app.media.streams import (
    SESSION_TTL_SECONDS,
    URL_EXPIRY_MARGIN_SECONDS,
    StreamManager,
    UpstreamResponse,
    YouTubeStreamResolver,
    fetch_range,
    select_stream_tracks,
)
from app.ytdlp import classify_error

from .conftest import with_settings

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
                                  reason="ffmpeg/ffprobe not installed")

NOW = 1_800_000_000.0
EXPIRE = int(NOW) + 6 * 3600
VIDEO_ID = "aqz-KE-bpKQ"
HEADERS = {"User-Agent": "Mozilla/5.0 (test)", "Accept": "*/*", "Accept-Language": "en-us,en;q=0.5",
           "Sec-Fetch-Mode": "navigate", "Cookie": "SID=must-not-be-forwarded"}


def gv_url(itag: str, clen: int | None, *, gen: int = 1, expire: int = EXPIRE, dur: str = "634.566") -> str:
    clen_param = f"&clen={clen}" if clen else ""
    return (f"https://rr1---sn-abcd1234.googlevideo.com/videoplayback?expire={expire}&ei=xyz&ip=203.0.113.9"
            f"&itag={itag}{clen_param}&dur={dur}&gen={gen}&sig=SECRETSIG{itag}&lsig=SECRETLSIG")


def vfmt(fid, vcodec, height, tbr, size, *, ext="mp4", fps=30, protocol="https", gen=1, expire=EXPIRE,
         filesize=True, **extra):
    width = {144: 256, 360: 640, 480: 854, 720: 1280, 1080: 1920, 2160: 3840, 4320: 7680}.get(height)
    fmt = {"format_id": fid, "ext": ext, "protocol": protocol, "vcodec": vcodec, "acodec": "none",
           "width": width, "height": height, "fps": fps, "tbr": tbr, "vbr": tbr,
           "filesize": size if filesize else None, "url": gv_url(fid, size, gen=gen, expire=expire),
           "http_headers": dict(HEADERS), "downloader_options": {"http_chunk_size": 10485760}}
    fmt.update(extra)
    return fmt


def afmt(fid, acodec, abr, size, *, ext="m4a", gen=1, expire=EXPIRE, channels=2, dur="634.624", **extra):
    fmt = {"format_id": fid, "ext": ext, "protocol": "https", "vcodec": "none", "acodec": acodec,
           "abr": abr, "tbr": abr, "filesize": size, "audio_channels": channels,
           "url": gv_url(fid, size, gen=gen, expire=expire, dur=dur), "http_headers": dict(HEADERS),
           "downloader_options": {"http_chunk_size": 10485760}}
    fmt.update(extra)
    return fmt


def youtube_formats(gen: int = 1, expire: int = EXPIRE) -> list[dict]:
    """Shaped like yt-dlp's -J output for a public 1080p60/2160p60 upload."""
    kw = {"gen": gen, "expire": expire}
    return [
        {"format_id": "sb0", "ext": "mhtml", "protocol": "mhtml", "vcodec": "none", "acodec": "none",
         "format_note": "storyboard", "url": "https://i.ytimg.com/sb/x/storyboard3_L0/default.jpg?sigh=abc",
         "fragments": [{"url": "https://i.ytimg.com/sb/x/M0.jpg", "duration": 10}]},
        {"format_id": "230", "ext": "mp4", "protocol": "m3u8_native", "vcodec": "avc1.4D401E", "acodec": "none",
         "height": 360, "url": "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1/x/index.m3u8"},
        afmt("139", "mp4a.40.5", 48.792, 3_871_021, **kw),
        afmt("249", "opus", 49.561, 3_931_453, ext="webm", **kw),
        afmt("140", "mp4a.40.2", 129.481, 10_271_496, **kw),
        afmt("140-drc", "mp4a.40.2", 129.481, 10_271_496, format_note="medium, DRC", **kw),
        afmt("251", "opus", 128.612, 10_202_210, ext="webm", **kw),
        afmt("258", "mp4a.40.2", 387.853, 30_767_611, channels=6, **kw),
        afmt("380", "ac-3", 384.105, 30_468_809, channels=6, **kw),
        afmt("773", None, 336.673, 26_688_526, channels=6, **kw),  # IAMF yt-dlp can't name
        vfmt("160", "avc1.4D400C", 144, 54.511, 4_323_893, filesize=False, **kw),  # size from clen
        vfmt("278", "vp9", 144, 66.688, 5_289_812, ext="webm", **kw),
        vfmt("394", "av01.0.00M.08", 144, 58.493, 4_639_733, **kw),
        vfmt("136", "avc1.4D401F", 720, 1100.517, 87_293_859, **kw),
        vfmt("247", "vp9", 720, 709.467, 56_275_462, ext="webm", **kw),
        vfmt("398", "av01.0.08M.08", 720, 898.678, 71_283_827, fps=60, **kw),
        vfmt("299", "avc1.64002A", 1080, 3247.821, 257_619_653, fps=60, **kw),
        vfmt("303", "vp9", 1080, 2127.264, 168_736_189, ext="webm", fps=60, **kw),
        vfmt("399", "av01.0.09M.08", 1080, 1568.15, 124_386_876, fps=60, **kw),
        vfmt("401", "av01.0.13M.08", 2160, 8981.827, 712_445_280, fps=60, **kw),
        vfmt("571", "av01.0.16M.08", 4320, 21000.0, 1_600_000_000, fps=60, **kw),  # above the height cap
        vfmt("137", "avc1.640028", 1080, 4400.0, 200_000_000, has_drm=True, **kw),
        vfmt("135", "avc1.4D401F", 480, 355.608, None, protocol="http_dash_segments",
             fragments=[{"url": "https://rr1---sn-abcd1234.googlevideo.com/sq/0"}], **kw),
        vfmt("134", "avc1.4D401E", 360, 230.634, 18_294_110, url=None, **kw),
        {"format_id": "18", "ext": "mp4", "protocol": "https", "vcodec": "avc1.42001E", "acodec": "mp4a.40.2",
         "height": 360, "width": 640, "tbr": 359.607, "url": gv_url("18", None, gen=gen, expire=expire),
         "http_headers": dict(HEADERS)},
    ]


def youtube_info(gen: int = 1, **changes) -> dict:
    info = {"id": VIDEO_ID, "title": "Big Buck Bunny 60fps 4K", "duration": 635, "live_status": "not_live",
            "availability": "public", "channel": "Blender", "channel_id": "UCSMOQeBJ2RAnuFungnQOxLg",
            "formats": youtube_formats(gen)}
    info.update(changes)
    return info


# -- selection --------------------------------------------------------------------------------


def test_selects_mse_ready_tracks_in_order():
    video, audio = select_stream_tracks(youtube_formats(), max_height=2160)
    assert [t.id for t in video] == ["401", "299", "399", "136", "398", "394", "160"]
    # Stereo first (by bitrate, non-DRC before DRC), then the 5.1 track.
    assert [t.id for t in audio] == ["140", "140-drc", "139", "258"]

    best = video[1].view
    assert best.model_dump() == {"id": "299", "mime_type": "video/mp4", "codecs": "avc1.64002A", "width": 1920,
                                 "height": 1080, "fps": 60, "bitrate": 3247821, "size_bytes": 257_619_653}
    assert audio[0].view.model_dump() == {"id": "140", "mime_type": "audio/mp4", "codecs": "mp4a.40.2",
                                          "bitrate": 129481, "size_bytes": 10_271_496, "channels": 2}
    assert video[-1].size == 4_323_893, "size falls back to the URL's clen"
    # yt-dlp's headers are kept for the proxy, minus cookies.
    assert video[0].headers == {k: v for k, v in HEADERS.items() if k != "Cookie"}
    assert video[0].chunk_size == 10485760
    assert "googlevideo" not in repr(video[0]), "signed URLs stay out of reprs"


def test_height_cap():
    video, _ = select_stream_tracks(youtube_formats(), max_height=720)
    assert [t.id for t in video] == ["136", "398", "394", "160"]
    video, _ = select_stream_tracks(youtube_formats(), max_height=4320)
    assert video[0].id == "571"


def test_original_audio_language_comes_first():
    formats = [
        afmt("140-0", "mp4a.40.2", 129.6, 10_000_000, language="en", language_preference=-1),
        afmt("140-1", "mp4a.40.2", 129.4, 10_000_000, language="de", language_preference=10,
             format_note="German original (default), medium"),
        afmt("139-1", "mp4a.40.5", 48.8, 3_000_000, language="de", language_preference=10),
    ]
    _, audio = select_stream_tracks(formats, max_height=2160)
    assert [t.id for t in audio] == ["140-1", "139-1", "140-0"]


def test_nothing_usable_without_both_kinds():
    only_video = [f for f in youtube_formats() if f.get("vcodec") not in ("none", None)]
    assert select_stream_tracks(only_video, max_height=2160)[1] == []
    assert select_stream_tracks(None, max_height=2160) == ([], [])


# -- fakes ------------------------------------------------------------------------------------


class FakeClock:
    def __init__(self, now: float = NOW) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeYouTube(YouTubeStreamResolver):
    """The real resolver with yt-dlp replaced by canned info (one "generation" per call)."""

    def __init__(self, settings, make_info=youtube_info, delay: float = 0.0) -> None:
        super().__init__(settings)
        self.calls: list[tuple[str, bool]] = []
        self.make_info = make_info
        self.delay = delay

    async def extract(self, video_id, *, mark_watched):
        self.calls.append((video_id, mark_watched))
        if self.delay:
            await asyncio.sleep(self.delay)
        info = self.make_info(len(self.calls))
        if isinstance(info, Exception):
            raise info
        return info


_PATTERN = bytes(range(251))


def payload(start: int, end: int) -> bytes:
    offset, length = start % 251, end - start + 1
    return (_PATTERN * ((offset + length) // 251 + 1))[offset:offset + length]


class FakeUpstream:
    """Stands in for ``fetch_range``: serves a deterministic pattern as 206 responses."""

    def __init__(self) -> None:
        self.calls: list[SimpleNamespace] = []
        self.handler = None

    def __call__(self, url, headers, start, end, timeout):
        call = SimpleNamespace(url=url, headers=headers, start=start, end=end, timeout=timeout,
                               itag=re.search(r"itag=([\w-]+)", url).group(1),
                               gen=int(re.search(r"gen=(\d+)", url).group(1)))
        self.calls.append(call)
        if self.handler is not None:
            response = self.handler(call)
            if response is not None:
                return response
        size = int(re.search(r"clen=(\d+)", url).group(1))
        last = min(end, size - 1)
        return UpstreamResponse(206, payload(start, last), f"bytes {start}-{last}/{size}")


@pytest.fixture
def stack(settings):
    clock = FakeClock()
    upstream = FakeUpstream()
    resolver = FakeYouTube(settings)
    app = create_app(settings)
    app.state.streams = StreamManager(settings, {"youtube": resolver, "demo": DemoStreamResolver(settings)},
                                      fetcher=upstream, clock=clock)
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, clock=clock, upstream=upstream, resolver=resolver, app=app)


def create(stack, video_id=VIDEO_ID):
    response = stack.client.post("/api/streams", json={"source": "youtube", "id": video_id})
    assert response.status_code == 200, response.text
    return response.json()


def track_url(session, track_id):
    return f"/api/streams/{session['session_id']}/tracks/{track_id}"


def get_range(stack, session, track_id, start, end):
    return stack.client.get(track_url(session, track_id), params={"start": start, "end": end})


# -- sessions ---------------------------------------------------------------------------------


def test_session_json(stack):
    session = create(stack)
    assert set(session) == {"session_id", "source", "video_id", "video", "duration_seconds", "video_tracks",
                            "audio_tracks", "expires_at"}
    assert re.fullmatch(r"[A-Za-z0-9_-]{20,}", session["session_id"])
    assert session["source"] == "youtube" and session["video_id"] == VIDEO_ID
    assert session["video"]["id"] == VIDEO_ID and session["video"]["title"] == "Big Buck Bunny 60fps 4K"
    assert session["duration_seconds"] == 634.624, "the longest track's exact dur"
    assert [t["id"] for t in session["video_tracks"]][:3] == ["401", "299", "399"]
    assert session["audio_tracks"][0] == {"id": "140", "mime_type": "audio/mp4", "codecs": "mp4a.40.2",
                                          "bitrate": 129481, "size_bytes": 10_271_496, "channels": 2}
    assert session["expires_at"] == NOW + SESSION_TTL_SECONDS
    text = stack.client.post("/api/streams", json={"source": "youtube", "id": VIDEO_ID}).text
    assert "googlevideo" not in text and "SECRETSIG" not in text
    assert stack.client.get("/api/health").json()["streaming_enabled"] is True


def test_session_expiry_follows_url_expiry(settings, stack):
    soon = int(NOW) + 2 * 3600
    stack.resolver.make_info = lambda n: {**youtube_info(n), "formats": youtube_formats(n, expire=soon)}
    session = create(stack)
    assert session["expires_at"] == soon - URL_EXPIRY_MARGIN_SECONDS


def test_session_expires(stack):
    session = create(stack)
    assert get_range(stack, session, "140", 0, 99).status_code == 200
    stack.clock.advance(SESSION_TTL_SECONDS - 1)
    assert get_range(stack, session, "140", 0, 99).status_code == 200
    stack.clock.advance(1)
    response = get_range(stack, session, "140", 0, 99)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "stream_expired"
    assert get_range(stack, {"session_id": "nope"}, "140", 0, 99).json()["error"]["code"] == "stream_expired"


def test_resolve_is_cached_per_video(stack):
    def expiring(n):
        return {**youtube_info(n), "formats": youtube_formats(n, expire=int(stack.clock.now) + 6 * 3600)}

    stack.resolver.make_info = expiring
    first, second = create(stack), create(stack)
    assert first["session_id"] != second["session_id"]
    assert len(stack.resolver.calls) == 1
    # Near the end of the cached resolve a new session gets fresh URLs instead.
    stack.clock.advance(SESSION_TTL_SECONDS - 10 * 60)
    third = create(stack)
    assert len(stack.resolver.calls) == 2
    assert third["expires_at"] == stack.clock.now + SESSION_TTL_SECONDS
    assert get_range(stack, first, "140", 0, 9).status_code == 200, "older sessions keep working"


def test_sessions_are_lru_capped(settings):
    async def run():
        manager = StreamManager(settings, {"youtube": FakeYouTube(settings)}, fetcher=FakeUpstream(),
                                clock=FakeClock(), max_sessions=2)
        a = await manager.create("youtube", VIDEO_ID)
        b = await manager.create("youtube", VIDEO_ID)
        await manager.read(a.session_id, "140", 0, 9)  # a is now the most recently used
        await manager.create("youtube", VIDEO_ID)
        await manager.read(a.session_id, "140", 0, 9)
        with pytest.raises(AppError) as excinfo:
            await manager.read(b.session_id, "140", 0, 9)
        assert excinfo.value.code == "stream_expired"

    asyncio.run(run())


def test_concurrent_creates_share_one_resolve(settings):
    async def run():
        resolver = FakeYouTube(settings, delay=0.05)
        manager = StreamManager(settings, {"youtube": resolver}, fetcher=FakeUpstream(), clock=FakeClock())
        views = await asyncio.gather(*(manager.create("youtube", VIDEO_ID) for _ in range(3)))
        assert len({v.session_id for v in views}) == 3
        assert len(resolver.calls) == 1

    asyncio.run(run())


def test_resolve_uses_the_download_paths_extraction(settings, monkeypatch):
    seen = []

    async def fake_run_json(settings_, args, *, timeout, context):
        seen.append(args)
        return youtube_info()

    monkeypatch.setattr(streams, "run_json", fake_run_json)
    signed_in = with_settings(settings, cookies_file=settings.data_dir / "cookies.txt", mark_watched=True)

    async def run():
        resolver = YouTubeStreamResolver(signed_in)
        await resolver.resolve(VIDEO_ID)
        await resolver.resolve(VIDEO_ID, refresh=True)
        await YouTubeStreamResolver(settings).resolve(VIDEO_ID)

    asyncio.run(run())
    first, refresh, signed_out = seen
    assert first[-2:] == ["--", f"https://www.youtube.com/watch?v={VIDEO_ID}"]
    for flag in ("--ignore-config", "--no-playlist", "--dump-single-json", "--skip-download"):
        assert flag in first
    assert "--cookies" in first and "--mark-watched" in first
    assert "--cookies" in refresh and "--mark-watched" not in refresh, "a refresh only renews the URLs"
    assert "--cookies" not in signed_out and "--mark-watched" not in signed_out


@pytest.mark.parametrize("info, code, status", [
    (youtube_info(formats=[f for f in youtube_formats() if f.get("acodec") in ("none", None)]),
     "stream_unavailable", 422),
    (youtube_info(formats=[f for f in youtube_formats() if f.get("ext") != "mp4"]), "stream_unavailable", 422),
    (youtube_info(live_status="is_live", is_live=True), "live_unsupported", 422),
    (youtube_info(live_status="is_upcoming"), "live_unsupported", 422),
    (youtube_info(availability="needs_auth"), "restricted", 403),
    (classify_error("ERROR: [youtube] aqz-KE-bpKQ: Private video. Sign in if you've been granted access"),
     "unavailable", 404),
])
def test_resolve_errors(stack, info, code, status):
    stack.resolver.make_info = lambda n: info
    response = stack.client.post("/api/streams", json={"source": "youtube", "id": VIDEO_ID})
    assert response.status_code == status, response.text
    error = response.json()["error"]
    assert error["code"] == code
    if code == "stream_unavailable":
        assert error["message"] == "This video can't be streamed; download it instead."
        assert error["retryable"] is False


def test_long_videos_can_stream(stack, settings):
    stack.resolver.make_info = lambda n: youtube_info(duration=settings.max_duration_seconds * 3)
    assert create(stack)["video_tracks"], "the download length limit doesn't apply to streaming"


def test_request_validation(stack):
    client = stack.client
    assert client.post("/api/streams", json={"source": "youtube", "id": "bad"}).status_code == 400
    assert client.post("/api/streams", json={"source": "vimeo", "id": VIDEO_ID}).status_code == 400
    response = client.post("/api/streams", json={"source": "demo", "id": "nope"})
    assert response.status_code == 404 and response.json()["error"]["code"] == "not_found"


def test_streaming_disabled(settings):
    with TestClient(create_app(with_settings(settings, enable_streaming=False))) as client:
        assert client.get("/api/health").json()["streaming_enabled"] is False
        response = client.post("/api/streams", json={"source": "demo", "id": "bars"})
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"
        assert "YTC_ENABLE_STREAMING" in response.json()["error"]["message"]
        assert client.get("/api/streams/x/tracks/video?start=0&end=1").json()["error"]["code"] == "not_found"


def test_demo_streams_follow_enable_demo(settings):
    with TestClient(create_app(with_settings(settings, enable_demo=False))) as client:
        response = client.post("/api/streams", json={"source": "demo", "id": "bars"})
        assert response.status_code == 404 and "YTC_ENABLE_DEMO" in response.json()["error"]["message"]


# -- ranges -------------------------------------------------------------------------------------


def test_range_validation(stack):
    session = create(stack)
    size = 10_271_496  # track 140
    for params in ({"start": 10, "end": 9}, {"start": -1, "end": 9}, {"start": "a", "end": 9},
                   {"start": 0}, {"start": 1.5, "end": 9}, {"start": 0, "end": 16 * 1024 * 1024}):
        response = stack.client.get(track_url(session, "140"), params=params)
        assert response.status_code == 400, params
        assert response.json()["error"]["code"] == "invalid_input"
    assert get_range(stack, session, "140", 0, 16 * 1024 * 1024 - 1).status_code == 200, "exactly 16 MiB is fine"

    response = get_range(stack, session, "140", size, size + 10)
    assert response.status_code == 416 and response.json()["error"]["code"] == "invalid_input"

    stack.upstream.calls.clear()
    response = get_range(stack, session, "140", size - 100, size + 5000)
    assert response.status_code == 200 and response.content == payload(size - 100, size - 1)
    assert (stack.upstream.calls[0].start, stack.upstream.calls[0].end) == (size - 100, size - 1), "end clamped"

    response = get_range(stack, session, "nope", 0, 9)
    assert response.status_code == 404 and response.json()["error"]["code"] == "not_found"


def test_max_range_is_configurable(settings, stack):
    stack.app.state.streams.settings = with_settings(settings, stream_max_range_bytes=1024 * 1024)
    session = create(stack)
    assert get_range(stack, session, "140", 0, 1024 * 1024 - 1).status_code == 200
    assert get_range(stack, session, "140", 0, 1024 * 1024).status_code == 400


def test_proxy_returns_exact_bytes(stack):
    session = create(stack)
    response = get_range(stack, session, "299", 1000, 66535)
    assert response.status_code == 200
    assert response.content == payload(1000, 66535)
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-length"] == str(65536)
    assert response.headers["cache-control"] == "no-store"
    call = stack.upstream.calls[-1]
    assert (call.itag, call.start, call.end) == ("299", 1000, 66535)
    assert call.headers == {k: v for k, v in HEADERS.items() if k != "Cookie"}
    assert call.timeout == 30


def test_large_ranges_are_fetched_in_chunks(stack):
    session = create(stack)
    response = get_range(stack, session, "299", 5, 12 * 1024 * 1024)
    assert response.status_code == 200 and response.content == payload(5, 12 * 1024 * 1024)
    assert [(c.start, c.end) for c in stack.upstream.calls] == [(5, 10485764), (10485765, 12 * 1024 * 1024)]


def test_upstream_status_handling(stack):
    session = create(stack)
    cases = {
        200: (UpstreamResponse(200, payload(0, 99)), 200),
        500: (UpstreamResponse(500), 502),
        429: (UpstreamResponse(429), 503),
        416: (UpstreamResponse(416), 416),
    }
    for name, (upstream, status) in cases.items():
        stack.upstream.handler = lambda call, upstream=upstream: upstream
        response = get_range(stack, session, "140", 0, 99)
        assert response.status_code == status, name
        if status == 200:
            assert response.content == payload(0, 99)
    # A 200 (whole file) only answers a range that starts at 0.
    stack.upstream.handler = lambda call: UpstreamResponse(200, payload(0, 99))
    assert get_range(stack, session, "140", 10, 99).json()["error"]["code"] == "download_failed"
    # A 206 for the wrong range or with a short body is rejected.
    stack.upstream.handler = lambda call: UpstreamResponse(206, payload(0, 99), "bytes 1-100/10271496")
    assert get_range(stack, session, "140", 0, 99).json()["error"]["code"] == "download_failed"
    stack.upstream.handler = lambda call: UpstreamResponse(206, payload(0, 49), "bytes 0-99/10271496")
    assert get_range(stack, session, "140", 0, 99).json()["error"]["code"] == "download_failed"


def test_unknown_size_is_learned_from_content_range(settings):
    async def run():
        def info(n):
            data = youtube_info(n)
            for fmt in data["formats"]:
                if fmt["format_id"] == "140":
                    fmt["filesize"] = None
                    fmt["url"] = fmt["url"].replace("&clen=10271496", "")
            return data

        upstream = FakeUpstream()
        upstream.handler = lambda call: UpstreamResponse(206, payload(call.start, min(call.end, 999)),
                                                         f"bytes {call.start}-{min(call.end, 999)}/1000")
        manager = StreamManager(settings, {"youtube": FakeYouTube(settings, info)}, fetcher=upstream,
                                clock=FakeClock())
        view = await manager.create("youtube", VIDEO_ID)
        assert next(t for t in view.audio_tracks if t.id == "140").size_bytes is None
        assert await manager.read(view.session_id, "140", 900, 5000) == payload(900, 999)
        with pytest.raises(AppError) as excinfo:
            await manager.read(view.session_id, "140", 1000, 1100)
        assert excinfo.value.status == 416

    asyncio.run(run())


def test_network_errors_are_retryable(stack):
    session = create(stack)

    def fail(call):
        raise AppError("network_error", "Could not reach YouTube.", status=502, retryable=True)

    stack.upstream.handler = fail
    error = get_range(stack, session, "140", 0, 99).json()["error"]
    assert error["code"] == "network_error" and error["retryable"] is True


# -- re-resolving on 403/410 ----------------------------------------------------------------------


def test_forbidden_reresolves_once_then_502(stack, caplog):
    caplog.set_level(logging.DEBUG)
    session = create(stack)
    stack.upstream.handler = lambda call: UpstreamResponse(403)
    response = get_range(stack, session, "140", 0, 99)
    assert response.status_code == 502
    error = response.json()["error"]
    assert error["code"] == "download_forbidden" and "download" in error["hint"]
    assert stack.resolver.calls == [(VIDEO_ID, True), (VIDEO_ID, False)], "one re-resolve, without --mark-watched"
    assert [c.gen for c in stack.upstream.calls] == [1, 2], "the retry used the fresh URL"

    # No yt-dlp storm while YouTube keeps refusing: at most one re-resolve a minute.
    assert get_range(stack, session, "140", 0, 99).status_code == 502
    assert len(stack.resolver.calls) == 2
    stack.clock.advance(61)
    assert get_range(stack, session, "140", 0, 99).status_code == 502
    assert len(stack.resolver.calls) == 3

    for record in caplog.records:
        text = logging.Formatter().format(record)
        assert "googlevideo" not in text and "SECRETSIG" not in text, text
    assert "googlevideo" not in response.text


def test_gone_url_is_renewed_and_retried(stack):
    session = create(stack)
    other = create(stack)
    stack.upstream.handler = lambda call: UpstreamResponse(410) if call.gen == 1 else None
    response = get_range(stack, session, "299", 0, 999)
    assert response.status_code == 200 and response.content == payload(0, 999)
    assert len(stack.resolver.calls) == 2
    assert get_range(stack, session, "299", 1000, 1999).status_code == 200
    # Another session on the same video picks up the renewed URLs without resolving again.
    assert get_range(stack, other, "140", 0, 9).status_code == 200
    assert len(stack.resolver.calls) == 2
    assert [c.gen for c in stack.upstream.calls] == [1, 2, 2, 1, 2]


def test_track_missing_after_reresolve(stack):
    session = create(stack)
    stack.resolver.make_info = lambda n: youtube_info(n, formats=[f for f in youtube_formats(n)
                                                                  if f["format_id"] != "299"])
    stack.upstream.handler = lambda call: UpstreamResponse(403)
    assert get_range(stack, session, "299", 0, 9).json()["error"]["code"] == "download_forbidden"


# -- the real fetcher ----------------------------------------------------------------------------


class FakeHTTPResponse(io.BytesIO):
    def __init__(self, status, body, headers):
        super().__init__(body)
        self.status = status
        self.headers = email.message.Message()
        for key, value in headers.items():
            self.headers[key] = value


def test_fetch_range_forwards_headers_and_range(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout):
        seen.update(request=request, timeout=timeout)
        return FakeHTTPResponse(206, payload(10, 10_000), {"Content-Range": "bytes 10-19/100"})

    monkeypatch.setattr(streams.urllib.request, "urlopen", fake_urlopen)
    url = gv_url("140", 100)
    result = fetch_range(url, {"User-Agent": "UA/1", "Accept": "*/*"}, 10, 19, 12)
    request = seen["request"]
    assert request.full_url == url and request.get_method() == "GET"
    assert request.get_header("Range") == "bytes=10-19"
    assert request.get_header("User-agent") == "UA/1" and request.get_header("Accept") == "*/*"
    assert seen["timeout"] == 12
    assert result == UpstreamResponse(206, payload(10, 19), "bytes 10-19/100"), "reads only the range"


def test_fetch_range_errors_never_mention_the_url(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    url = gv_url("140", 100)

    def forbidden(request, timeout):
        raise urllib.error.HTTPError(url, 403, "Forbidden", email.message.Message(), None)

    monkeypatch.setattr(streams.urllib.request, "urlopen", forbidden)
    assert fetch_range(url, {}, 0, 9).status == 403

    for exc, code in ((urllib.error.URLError(OSError(8, "nodename nor servname provided")), "network_error"),
                      (urllib.error.URLError(TimeoutError("timed out")), "timeout"),
                      (TimeoutError("The read operation timed out"), "timeout"),
                      (ConnectionResetError(54, "Connection reset by peer"), "network_error")):
        def fail(request, timeout, exc=exc):
            raise exc

        monkeypatch.setattr(streams.urllib.request, "urlopen", fail)
        with pytest.raises(AppError) as excinfo:
            fetch_range(url, {}, 0, 9)
        assert excinfo.value.code == code and excinfo.value.retryable
        assert excinfo.value.__cause__ is None and excinfo.value.__suppress_context__
        assert "googlevideo" not in str(excinfo.value.to_dict())
    for record in caplog.records:
        assert "googlevideo" not in logging.Formatter().format(record)


# -- demo tracks (real FFmpeg) --------------------------------------------------------------------


def top_level(data: bytes) -> list[tuple[str, int, int]]:
    boxes, offset = [], 0
    while offset + 8 <= len(data):
        size, kind = struct.unpack_from(">I4s", data, offset)
        if size == 1:
            size = struct.unpack_from(">Q", data, offset + 8)[0]
        assert size >= 8
        boxes.append((kind.decode("latin-1"), offset, size))
        offset += size
    assert offset == len(data), "boxes must tile the file exactly"
    return boxes


def sidx_of(data: bytes, offset: int) -> dict:
    version = data[offset + 8]
    timescale = struct.unpack_from(">I", data, offset + 16)[0]
    if version == 0:
        first_offset = struct.unpack_from(">I", data, offset + 24)[0]
        pos = offset + 28
    else:
        first_offset = struct.unpack_from(">Q", data, offset + 28)[0]
        pos = offset + 36
    count = struct.unpack_from(">H", data, pos + 2)[0]
    refs = [struct.unpack_from(">III", data, pos + 4 + 12 * i) for i in range(count)]
    return {"timescale": timescale, "first_offset": first_offset,
            "refs": [(word & 0x7FFFFFFF, duration, bool(sap >> 31), word >> 31) for word, duration, sap in refs]}


def test_demo_generation_reuses_the_demo_graph(settings):
    sample = SAMPLES["bars"]
    throttled = with_settings(settings, demo_readrate=4)
    args = stream_generator_args(throttled, sample, "v.mp4", "a.m4a", with_label=True)
    assert "-readrate" not in args, "demo streams are generated as fast as possible"
    download = generator_args(settings, sample, "x.mkv", with_label=True)
    graph = args[args.index("-filter_complex") + 1]
    assert graph == download[download.index("-filter_complex") + 1]
    inputs = [args[i + 1] for i, arg in enumerate(args) if arg == "-i"]
    assert inputs == [download[i + 1] for i, arg in enumerate(download) if arg == "-i"]
    assert args.count("dash+global_sidx+skip_trailer") == 2


@needs_ffmpeg
def test_demo_stream_tracks(settings):
    sample = SAMPLES["bars"]
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/streams", json={"source": "demo", "id": "bars"})
        assert response.status_code == 200, response.text
        session = response.json()
        assert session["source"] == "demo" and session["video_id"] == "bars"
        assert session["video"]["title"].startswith("DEMO")
        assert sample.duration <= session["duration_seconds"] < sample.duration + 0.1
        (video,), (audio,) = session["video_tracks"], session["audio_tracks"]
        assert video["id"] == "video" and audio["id"] == "audio"
        assert (video["mime_type"], audio["mime_type"]) == ("video/mp4", "audio/mp4")
        assert (video["width"], video["height"], video["fps"]) == (sample.width, sample.height, 30)
        assert audio["codecs"] == "mp4a.40.2"

        directory = settings.streams_dir / "demo" / "bars"
        files = {"video": directory / "video.mp4", "audio": directory / "audio.m4a"}
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                                "stream=profile,level", "-of", "default=nw=1", str(files["video"])],
                               capture_output=True, text=True, check=True).stdout
        level = int(re.search(r"level=(\d+)", probe).group(1))
        assert "profile=High" in probe
        assert re.fullmatch(r"avc1\.64[0-9a-f]{2}" + f"{level:02x}", video["codecs"]), (video["codecs"], probe)

        for track in (video, audio):
            data = files[track["id"]].read_bytes()
            assert track["size_bytes"] == len(data)
            boxes = top_level(data)
            kinds = [kind for kind, _, _ in boxes]
            assert kinds[:3] == ["ftyp", "moov", "sidx"], kinds[:6]
            assert kinds[3:] == ["moof", "mdat"] * ((len(kinds) - 3) // 2), "only moof/mdat pairs after sidx"
            assert kinds.count("sidx") == 1

            _, sidx_offset, sidx_size = boxes[2]
            sidx = sidx_of(data, sidx_offset)
            refs = sidx["refs"]
            assert len(refs) >= sample.duration - 1
            assert len(refs) == kinds.count("moof")
            # Each reference covers exactly one moof+mdat pair, starting right after the sidx.
            position = sidx_offset + sidx_size + sidx["first_offset"]
            pairs = boxes[3:]
            for i, (size, duration, starts_with_sap, ref_type) in enumerate(refs):
                assert ref_type == 0 and starts_with_sap
                moof, mdat = pairs[2 * i], pairs[2 * i + 1]
                assert moof[1] == position and moof[2] + mdat[2] == size
                position += size
            assert position == len(data)
            if track is video:
                assert all(duration == sidx["timescale"] for _, duration, _, _ in refs), "a keyframe every second"

            url = track_url(session, track["id"])
            first = refs[0][0]
            start = sidx_offset + sidx_size
            segment = client.get(url, params={"start": start + first, "end": start + first + refs[1][0] - 1})
            assert segment.status_code == 200
            assert segment.content == data[start + first:start + first + refs[1][0]]
            assert segment.content[4:8] == b"moof"
            head = client.get(url, params={"start": 0, "end": 65535})
            assert head.content == data[:65536] and head.headers["cache-control"] == "no-store"
            tail = client.get(url, params={"start": len(data) - 10, "end": len(data) + 1000})
            assert tail.content == data[-10:]
            past = client.get(url, params={"start": len(data), "end": len(data) + 10})
            assert past.status_code == 416

        # Generated once: a second session serves the same files.
        mtime = files["video"].stat().st_mtime_ns
        again = client.post("/api/streams", json={"source": "demo", "id": "bars"}).json()
        assert again["session_id"] != session["session_id"]
        assert again["video_tracks"] == session["video_tracks"]
        assert files["video"].stat().st_mtime_ns == mtime



def test_stereo_audio_comes_before_multichannel():
    from app.media.streams import select_stream_tracks as select_tracks

    def audio(format_id, abr, channels):
        return {"format_id": format_id, "url": f"https://example.invalid/{format_id}", "protocol": "https",
                "ext": "m4a", "acodec": "mp4a.40.2", "vcodec": "none", "abr": abr, "tbr": abr,
                "audio_channels": channels}
    video = {"format_id": "137", "url": "https://example.invalid/137", "protocol": "https", "ext": "mp4",
             "vcodec": "avc1.640028", "acodec": "none", "height": 1080, "width": 1920, "tbr": 4400}
    _, tracks = select_tracks([video, audio("258", 384, 6), audio("140", 128, 2), audio("139", 48, 2)], max_height=2160)
    assert [t.view.id for t in tracks] == ["140", "139", "258"]
    assert [t.view.channels for t in tracks] == [2, 2, 6]

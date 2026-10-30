"""HTTP endpoints. All paths live under ``/api``."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .accounts.users import current_user
from .apps import AppList, AppRegistry, AppView
from .diagnostics import (
    MAX_REPORT_BYTES,
    MAX_SPEED_BYTES,
    MIN_SPEED_BYTES,
    BrowserReports,
    probe_video,
    speed_payload,
)
from .discovery.account import AccountService
from .discovery.service import DiscoveryService
from .discovery.youtube_pages import YouTubePagesService
from .errors import AppError
from .localnet import is_local_request
from .media.delivery import media_response
from .media.demo import CONTAINER_TYPES, SAMPLES, demo_summary, ensure_source
from .media.jobs import JobManager
from .media.models import JobView, StreamView
from .media.storage import MediaStorage
from .media.streams import StreamManager
from .models import Feed, FeedList, Me, Page, RelatedVideos
from .session import youtube_settings
from .validation import parse_input

router = APIRouter(prefix="/api")


def _discovery(request: Request) -> DiscoveryService:
    return request.app.state.discovery


def _feeds(request: Request) -> YouTubePagesService:
    return request.app.state.feeds


def _account(request: Request) -> AccountService:
    """The YouTube account of whoever is asking (the server's own in no-login mode)."""
    if request.app.state.settings.accounts_enabled:
        return request.app.state.user_youtube.account_service(current_user())
    return request.app.state.account


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


def _storage(request: Request) -> MediaStorage:
    return request.app.state.storage


def _streams(request: Request) -> StreamManager:
    if not request.app.state.settings.enable_streaming:
        raise AppError("not_found", "Streaming playback is turned off on this server (YTC_ENABLE_STREAMING=false).",
                       status=404, hint="Download the video first instead.")
    return request.app.state.streams


@router.get("/health")
async def health(request: Request) -> dict:
    state = request.app.state
    deps = state.dependencies
    return {
        "ok": deps.can_extract and deps.can_process,
        "demo_enabled": state.settings.enable_demo,
        "feeds_enabled": state.settings.enable_feeds,
        "streaming_enabled": state.settings.enable_streaming,
        "signed_in_configured": youtube_settings(state.settings).signed_in_configured,
        "accounts": state.settings.accounts_enabled,
        "max_height": state.settings.max_height,
        "dependencies": deps.to_dict(),
    }


@router.get("/resolve")
async def resolve_input(q: str = Query(..., max_length=500)) -> dict:
    """Classify search-bar input. Never contacts YouTube."""
    return parse_input(q).to_dict()


@router.get("/search", response_model=Page)
async def search(request: Request, q: str = Query(..., max_length=500), offset: int = 0) -> Page:
    parsed = parse_input(q)
    if parsed.kind != "search":
        raise AppError("invalid_input", "That looks like a YouTube URL, not keywords.",
                       hint="Use /api/resolve to classify URLs.")
    return await _discovery(request).search(parsed.query or q, offset)


@router.get("/channel", response_model=Page)
async def channel(request: Request, ref: str = Query(..., max_length=120), offset: int = 0) -> Page:
    return await _discovery(request).channel(ref, offset)


@router.get("/playlist", response_model=Page)
async def playlist(request: Request, id: str = Query(..., max_length=80), offset: int = 0) -> Page:
    return await _discovery(request).playlist(id, offset)


@router.get("/feeds", response_model=FeedList)
async def feeds(request: Request) -> FeedList:
    """Curated public YouTube feeds; empty when YTC_ENABLE_FEEDS=false."""
    return _feeds(request).feeds()


@router.get("/feeds/{feed_id}", response_model=Feed)
async def feed(request: Request, feed_id: str) -> Feed:
    return await _feeds(request).feed(feed_id)


@router.get("/related/{video_id}", response_model=RelatedVideos)
async def related(request: Request, video_id: str) -> RelatedVideos:
    """Related ("Up next") videos from the watch page (personalized when signed in)."""
    return await _feeds(request).related(video_id)


@router.get("/me", response_model=Me)
async def me(request: Request) -> Me:
    """The signed-in YouTube session. No network access unless sign-in is configured."""
    me = await _account(request).me()
    user = current_user()
    if not request.app.state.settings.accounts_enabled or user is None:
        return me
    meta = request.app.state.accounts.latest(user).secret_meta("youtube_cookies") or {}
    return me.model_copy(update={"uploads": True, "uploaded_at": meta.get("uploaded_at"),
                                 "cookie_count": meta.get("count")})


@router.get("/me/feed/{feed_id}", response_model=Page)
async def my_feed(request: Request, feed_id: str, offset: int = 0) -> Page:
    """recommended, subscriptions, history, watch_later or liked, for the signed-in account."""
    return await _account(request).feed(feed_id, offset)


@router.get("/demo", response_model=Page)
async def demo_samples(request: Request) -> Page:
    if not request.app.state.settings.enable_demo:
        raise AppError("not_found", "Demo media is disabled (YTC_ENABLE_DEMO=false).", status=404)
    return Page(
        kind="demo",
        title="Demo & test media",
        subtitle="Generated locally with FFmpeg — not from YouTube",
        items=[demo_summary(sample) for sample in SAMPLES.values() if sample.listed],
        provider="demo",
    )


@router.api_route("/demo/{sample_id}/source", methods=["GET", "HEAD"])
async def demo_source(request: Request, sample_id: str) -> Response:
    """A demo sample's original file with byte ranges, for playing it directly (no preparation)."""
    if not request.app.state.settings.enable_demo:
        raise AppError("not_found", "Demo media is disabled (YTC_ENABLE_DEMO=false).", status=404)
    sample = SAMPLES.get(sample_id)
    if sample is None:
        raise AppError("not_found", "Unknown demo sample.", status=404)
    path = await ensure_source(request.app.state.settings, sample)
    return FileResponse(path, media_type=CONTAINER_TYPES[sample.container][1], headers={"Cache-Control": "no-store"})


@router.get("/demo/{sample_id}/layout")
async def demo_layout(request: Request, sample_id: str) -> dict:
    """Pixel layout of a demo sample (used by the browser tests)."""
    sample = SAMPLES.get(sample_id)
    if sample is None or not request.app.state.settings.enable_demo:
        raise AppError("not_found", "Unknown demo sample.", status=404)
    return {"id": sample.id, "width": sample.width, "height": sample.height,
            "duration": sample.duration, **sample.layout()}


class PrepareRequest(BaseModel):
    source: Literal["youtube", "demo"] = "youtube"
    id: str = Field(..., min_length=1, max_length=64)


@router.post("/jobs", response_model=JobView)
async def create_job(request: Request, body: PrepareRequest, response: Response) -> JobView:
    if body.source == "demo" and not request.app.state.settings.enable_demo:
        raise AppError("not_found", "Demo media is disabled (YTC_ENABLE_DEMO=false).", status=404)
    manager = _jobs(request)
    job, created = manager.submit(body.source, body.id)
    response.status_code = 201 if created else 200
    return manager.view(job)


@router.get("/jobs/{job_id}", response_model=JobView)
async def get_job(request: Request, job_id: str) -> JobView:
    manager = _jobs(request)
    return manager.view(manager.get(job_id))


@router.delete("/jobs/{job_id}", response_model=JobView)
async def cancel_job(request: Request, job_id: str) -> JobView:
    manager = _jobs(request)
    return manager.view(manager.cancel(job_id))


@router.api_route("/media/{media_id}", methods=["GET", "HEAD"])
async def media(request: Request, media_id: str) -> Response:
    storage = _storage(request)
    stored = storage.get(media_id)
    if stored is None:
        raise AppError("not_found", "This media is not prepared (it may have expired from the cache).",
                       status=404, hint="Prepare the video again.")
    lease = storage.lease(media_id)
    return media_response(request, stored, lease, stored.meta.get("media", {}).get("content_type", "video/mp4"))


@router.post("/streams", response_model=StreamView)
async def create_stream(request: Request, body: PrepareRequest) -> StreamView:
    """Start a streaming session: tracks to read in byte ranges into Media Source Extensions."""
    streams = _streams(request)
    if body.source == "demo" and not request.app.state.settings.enable_demo:
        raise AppError("not_found", "Demo media is disabled (YTC_ENABLE_DEMO=false).", status=404)
    return await streams.create(body.source, body.id)


@router.get("/streams/{session_id}/tracks/{track_id}")
async def stream_track(request: Request, session_id: str, track_id: str,
                       start: int = Query(...), end: int = Query(...)) -> Response:
    """Bytes ``start..end`` (inclusive, like an HTTP Range; clamped to the track size)."""
    data = await _streams(request).read(session_id, track_id, start, end)
    return Response(content=data, media_type="application/octet-stream",
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


# -- add-on apps --------------------------------------------------------------------------


def _apps(request: Request) -> AppRegistry:
    return request.app.state.apps


class AppToggle(BaseModel):
    enabled: bool


@router.get("/apps", response_model=AppList)
async def list_apps(request: Request) -> AppList:
    """The add-on apps and whether each is on. Their own routes live under /api/apps/<id>/."""
    return _apps(request).listing()


@router.put("/apps/{app_id}", response_model=AppView)
async def set_app_enabled(request: Request, app_id: str, body: AppToggle) -> AppView:
    return await _apps(request).set_enabled(app_id, body.enabled)


# -- browser check (/check) --------------------------------------------------------------


def _reports(request: Request) -> BrowserReports:
    return request.app.state.browser_reports


@router.post("/diagnostics/browser")
async def post_browser_report(request: Request) -> dict:
    """Keep a /check report (capabilities and timings, nothing personal) for reading on this computer."""
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_REPORT_BYTES:
            raise AppError("invalid_input", "The report is too large.", status=413)
    return _reports(request).add(bytes(body))


@router.get("/diagnostics/browser")
async def list_browser_reports(request: Request) -> dict:
    """The newest reports, first. Only this computer may read them, not visitors through a tunnel."""
    if not is_local_request(request):
        raise AppError("forbidden", "Browser check reports can only be read on the computer running yt-canvas.",
                       status=403)
    return {"reports": _reports(request).all()}


@router.get("/diagnostics/speed")
async def speed_test(size: int = Query(..., alias="bytes", ge=MIN_SPEED_BYTES, le=MAX_SPEED_BYTES)) -> Response:
    """``bytes`` random bytes, to time the connection from the browser to this server."""
    return StreamingResponse(speed_payload(size), media_type="application/octet-stream",
                             headers={"Content-Length": str(size), "Cache-Control": "no-store",
                                      "X-Content-Type-Options": "nosniff"})


@router.get("/diagnostics/probe.mp4")
async def drive_lock_probe(request: Request) -> Response:
    """A tiny looping clip: the check page watches whether the browser pauses it (Tesla's drive lock)."""
    path = await probe_video(request.app.state.settings)
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "no-store"})

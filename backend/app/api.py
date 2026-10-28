"""HTTP endpoints. All paths live under ``/api``."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field

from .discovery.service import DiscoveryService
from .errors import AppError
from .media.delivery import media_response
from .media.demo import SAMPLES, demo_summary
from .media.jobs import JobManager
from .media.models import JobView
from .media.storage import MediaStorage
from .models import Page
from .validation import parse_input

router = APIRouter(prefix="/api")


def _discovery(request: Request) -> DiscoveryService:
    return request.app.state.discovery


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


def _storage(request: Request) -> MediaStorage:
    return request.app.state.storage


@router.get("/health")
async def health(request: Request) -> dict:
    state = request.app.state
    deps = state.dependencies
    return {
        "ok": deps.can_extract and deps.can_process,
        "demo_enabled": state.settings.enable_demo,
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


@router.get("/demo", response_model=Page)
async def demo_samples(request: Request) -> Page:
    if not request.app.state.settings.enable_demo:
        raise AppError("not_found", "Demo media is disabled (YTC_ENABLE_DEMO=false).", status=404)
    return Page(
        kind="demo",
        title="Demo & test media",
        subtitle="Generated locally with FFmpeg — not from YouTube",
        items=[demo_summary(sample) for sample in SAMPLES.values()],
        provider="demo",
    )


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

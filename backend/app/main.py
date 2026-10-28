"""FastAPI application factory.

Run with ``uvicorn app.main:app`` from the ``backend`` directory. Use a single
worker process: jobs, leases and caches live in memory.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from .api import router
from .config import Settings, load_settings
from .deps import detect_dependencies
from .discovery.provider import DiscoveryProvider
from .discovery.service import DiscoveryService
from .discovery.ytdlp_provider import YtDlpDiscoveryProvider
from .errors import AppError
from .media.demo import DemoMediaProvider
from .media.jobs import JobManager, Processor
from .media.provider import MediaSourceProvider
from .media.storage import MediaStorage
from .media.youtube import YouTubeMediaProvider

log = logging.getLogger("app")

_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https://i.ytimg.com https://*.ytimg.com https://*.ggpht.com "
    "https://*.googleusercontent.com; media-src 'self'; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'"
)


async def _cleanup_loop(app: FastAPI) -> None:
    state = app.state
    while True:
        await asyncio.sleep(state.settings.cleanup_interval_seconds)
        try:
            state.storage.evict_expired()
            state.storage.cleanup_workdirs(state.jobs.active_job_ids())
            state.jobs.prune()
        except Exception:  # never let housekeeping kill the loop
            log.exception("cache cleanup failed")


def create_app(
    settings: Settings | None = None,
    *,
    discovery_provider: DiscoveryProvider | None = None,
    media_providers: dict[str, MediaSourceProvider] | None = None,
    processor: Processor | None = None,
) -> FastAPI:
    settings = settings or load_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    storage = MediaStorage(settings)
    providers = media_providers or {"youtube": YouTubeMediaProvider(settings)}
    if settings.enable_demo and "demo" not in providers:
        providers = {**providers, "demo": DemoMediaProvider(settings)}

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        storage.init()
        app.state.dependencies = await detect_dependencies(settings)
        jobs_kwargs = {"processor": processor} if processor else {}
        app.state.jobs = JobManager(settings, storage, providers, **jobs_kwargs)
        cleanup = asyncio.create_task(_cleanup_loop(app))
        log.info("data dir: %s (cache limit %d MB, TTL %d h)", settings.data_dir,
                 settings.cache_max_bytes // (1024 * 1024), settings.cache_ttl_seconds // 3600)
        try:
            yield
        finally:
            cleanup.cancel()
            await app.state.jobs.shutdown()

    app = FastAPI(title="yt-canvas", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.storage = storage
    app.state.discovery = DiscoveryService(settings, discovery_provider or YtDlpDiscoveryProvider(settings))

    @app.exception_handler(AppError)
    async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={"error": exc.to_dict()})

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(part) for part in first.get("loc", [])[1:]) or "request"
        error = AppError("invalid_input", f"Invalid {field}: {first.get('msg', 'bad value')}.")
        return JSONResponse(status_code=400, content={"error": error.to_dict()})

    app.include_router(router)

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "HEAD"], include_in_schema=False)
    async def api_not_found(rest: str) -> JSONResponse:
        error = AppError("not_found", "Unknown API endpoint.", status=404)
        return JSONResponse(status_code=404, content={"error": error.to_dict()})

    dist = settings.frontend_dist
    if dist is not None and (dist / "index.html").is_file():
        _mount_frontend(app, dist)
    return app


def _mount_frontend(app: FastAPI, dist: Path) -> None:
    """Serve the production build from the same origin as the API (keeps canvas untainted)."""
    root = dist.resolve()
    index = root / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            headers = {"Cache-Control": "public, max-age=31536000, immutable"} if path.startswith("assets/") else {}
            return FileResponse(candidate, headers=headers)
        return FileResponse(index, headers={"Cache-Control": "no-cache", "Content-Security-Policy": _CSP})


app = create_app()

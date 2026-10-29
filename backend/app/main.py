"""FastAPI application factory.

Run with ``uvicorn app.main:app`` from the ``backend`` directory. Use a single
worker process: jobs, leases and caches live in memory.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .api import router
from .config import Settings, load_settings
from .cookies import CookieLoader
from .deps import detect_dependencies
from .discovery.account import AccountService
from .discovery.provider import DiscoveryProvider
from .discovery.service import DiscoveryService
from .discovery.youtube_pages import YouTubePagesService
from .discovery.ytdlp_provider import YtDlpDiscoveryProvider
from .errors import AppError
from .media.demo import DemoMediaProvider
from .media.demo_streams import DemoStreamResolver
from .media.jobs import JobManager, Processor
from .media.provider import MediaSourceProvider
from .media.storage import MediaStorage
from .media.streams import StreamManager, StreamResolver, YouTubeStreamResolver
from .media.youtube import YouTubeMediaProvider

log = logging.getLogger("app")

_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https://i.ytimg.com https://*.ytimg.com https://*.ggpht.com "
    "https://*.googleusercontent.com; media-src 'self' blob:; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'"
)


def _is_loopback_ip(host: str | None) -> bool:
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def _is_local_host_header(value: str | None) -> bool:
    """``Host`` names this computer: localhost, *.localhost or a loopback address (any port)."""
    if not value:
        return True  # HTTP/1.0 clients may omit it; the client address check still applies
    host = value.strip().lower()
    if host.startswith("["):
        host = host[1:host.find("]")] if "]" in host else host
    elif host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host == "localhost" or host.endswith(".localhost") or _is_loopback_ip(host)


class LoopbackGuard:
    """While a signed-in YouTube session is configured, ``/api`` only answers this computer.

    Requests must come from a loopback address and name a local host in ``Host`` (which
    also stops DNS-rebinding pages from reaching the API through the user's browser).
    Plain ASGI so media streaming isn't wrapped by BaseHTTPMiddleware.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/api" or path.startswith("/api/"):
                client = scope.get("client")
                headers = dict(scope.get("headers") or [])
                host_header = headers.get(b"host", b"").decode("latin-1") or None
                if not (_is_loopback_ip(client[0] if client else None) and _is_local_host_header(host_header)):
                    error = AppError(
                        "forbidden",
                        "This server is using a signed-in YouTube session, so it only answers requests from "
                        "this computer.",
                        status=403,
                        hint="Open the app on the computer running the server (http://localhost:...), or turn "
                             "sign-in off to use it from other devices.",
                    )
                    response = JSONResponse(status_code=403, content={"error": error.to_dict()})
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)


def _log_signin(settings: Settings) -> None:
    if settings.cookies_from_browser:
        log.info("YouTube sign-in: yt-dlp reads cookies from %s; the API only answers this computer",
                 settings.signin_source)
    elif settings.cookies_file:
        log.info("YouTube sign-in: cookies file %s; the API only answers this computer", settings.cookies_file)
        if not settings.cookies_file.is_file():
            log.warning("YTC_YTDLP_COOKIES_FILE does not exist: %s", settings.cookies_file)
    if settings.mark_watched and not settings.signed_in_configured:
        log.warning("YTC_MARK_WATCHED has no effect without YouTube sign-in")


async def _cleanup_loop(app: FastAPI) -> None:
    state = app.state
    while True:
        await asyncio.sleep(state.settings.cleanup_interval_seconds)
        try:
            state.storage.evict_expired()
            state.storage.cleanup_workdirs(state.jobs.active_job_ids())
            state.jobs.prune()
            state.streams.prune()
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
        _log_signin(settings)
        try:
            yield
        finally:
            cleanup.cancel()
            await app.state.jobs.shutdown()
            await app.state.streams.shutdown()

    app = FastAPI(title="yt-canvas", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.storage = storage
    stream_resolvers: dict[str, StreamResolver] = {"youtube": YouTubeStreamResolver(settings)}
    if settings.enable_demo:
        stream_resolvers["demo"] = DemoStreamResolver(settings)
    app.state.streams = StreamManager(settings, stream_resolvers)
    app.state.discovery = DiscoveryService(settings, discovery_provider or YtDlpDiscoveryProvider(settings))
    # Cookies are only read on demand (never at startup), and only when sign-in is configured.
    cookies = CookieLoader(settings)
    app.state.cookies = cookies
    app.state.feeds = YouTubePagesService(settings, cookies)
    app.state.account = AccountService(settings, cookies)
    if settings.signed_in_configured:
        app.add_middleware(LoopbackGuard)

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

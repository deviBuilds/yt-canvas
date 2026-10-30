"""FastAPI application factory.

Run with ``uvicorn app.main:app`` from the ``backend`` directory. Use a single
worker process: jobs, leases and caches live in memory.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .accounts.clerk import ClerkApi, ClerkVerifier, frontend_api
from .accounts.convex import AccountStore, ConvexClient
from .accounts.guard import AuthGuard
from .accounts.pairing import AccountPairing
from .accounts.routes import router as accounts_router
from .accounts.users import Accounts, current_user
from .accounts.youtube import UserYouTube
from .api import router
from .apps import AppRegistry, AppSpec, default_apps
from .config import Settings, load_settings
from .cookies import CookieLoader
from .deps import detect_dependencies
from .devices import DEVICE_COOKIE, DeviceStore, cookie_value
from .diagnostics import BrowserReports
from .discovery.account import AccountService
from .discovery.provider import DiscoveryProvider
from .discovery.service import DiscoveryService
from .discovery.youtube_pages import YouTubePagesService
from .discovery.ytdlp_provider import YtDlpDiscoveryProvider
from .errors import AppError
from .localnet import is_local_host_header, is_loopback_ip
from .pairing import router as pairing_router
from .media.demo import DemoMediaProvider
from .media.demo_streams import DemoStreamResolver
from .media.jobs import JobManager, Processor
from .media.provider import MediaSourceProvider
from .media.storage import MediaStorage
from .media.streams import StreamManager, StreamResolver, YouTubeStreamResolver
from .media.youtube import YouTubeMediaProvider

log = logging.getLogger("app")

def content_security_policy(settings: Settings) -> str:
    # With accounts on, Clerk's SDK loads from the instance's Frontend API, embeds its fonts,
    # shows avatars from img.clerk.com, and checks for bots with its Protect script and
    # Cloudflare Turnstile (in a frame). Its telemetry is turned off in the frontend instead.
    clerk = f"https://{frontend_api(settings.clerk_publishable_key)}" if settings.clerk_publishable_key else ""
    turnstile = "https://challenges.cloudflare.com" if clerk else ""
    protect = "https://*.protect.clerk.com:*" if clerk else ""  # its probes try several ports
    return " ".join(f"{directive};" for directive in (
        "default-src 'self'",
        f"script-src 'self' {clerk} {protect} {turnstile}".strip(),
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: https://i.ytimg.com https://*.ytimg.com https://*.ggpht.com "
        "https://*.googleusercontent.com" + (" https://img.clerk.com" if clerk else ""),
        "media-src 'self' blob:",
        f"connect-src 'self' {clerk} {protect}".strip(),
        "worker-src 'self' blob:",
        f"frame-src {turnstile}" if clerk else "frame-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
    )).rstrip(";")


class LoopbackGuard:
    """While the server holds private data, ``/api`` only answers this computer.

    Private data means a signed-in YouTube session or a connected app (such as Plex);
    ``reason`` says which, per request, or returns None when anyone may use the API.
    ``allow`` lets a request through anyway: a paired device's, or one to the pairing routes.
    Requests must come from a loopback address and name a local host in ``Host`` (which
    also stops DNS-rebinding pages from reaching the API through the user's browser).
    Plain ASGI so media streaming isn't wrapped by BaseHTTPMiddleware.
    """

    def __init__(self, app: ASGIApp, reason: Callable[[], AppError | None], allow: Callable[[Scope], bool]) -> None:
        self.app = app
        self.reason = reason
        self.allow = allow

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/api" or path.startswith("/api/"):
                client = scope.get("client")
                headers = dict(scope.get("headers") or [])
                host_header = headers.get(b"host", b"").decode("latin-1") or None
                local = is_loopback_ip(client[0] if client else None) and is_local_host_header(host_header)
                error = None if local else self.reason()
                if error is not None and not self.allow(scope):
                    response = JSONResponse(status_code=403, content={"error": error.to_dict()})
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)


def _log_signin(settings: Settings) -> None:
    if settings.accounts_enabled:
        log.info("accounts are on (Clerk %s): every request needs a signed-in, allowlisted person",
                 frontend_api(settings.clerk_publishable_key or ""))
        if settings.ignored_server_cookies:
            log.warning("YTC_YTDLP_COOKIES_* are ignored while accounts are on: everyone uploads their own cookies")
        if not settings.admin_emails:
            log.warning("YTC_ADMIN_EMAILS is empty: nobody can manage the allowlist")
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
    apps: list[AppSpec] | None = None,
    account_store: AccountStore | None = None,
    clerk_verifier: ClerkVerifier | None = None,
    clerk_api: ClerkApi | None = None,
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
        if accounts is not None:
            try:
                await accounts.ensure_admins()
            except AppError as exc:
                log.warning("couldn't add the admins to the allowlist yet: %s", exc.message)
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
    accounts: Accounts | None = None
    user_youtube: UserYouTube | None = None
    if settings.accounts_enabled:
        assert settings.clerk_publishable_key and settings.clerk_secret_key
        assert settings.convex_site_url and settings.convex_secret
        accounts = Accounts(
            settings,
            account_store or ConvexClient(settings.convex_site_url, settings.convex_secret),
            clerk_verifier or ClerkVerifier(settings.clerk_publishable_key, jwt_key=settings.clerk_jwt_key),
            clerk_api or ClerkApi(settings.clerk_secret_key, settings.clerk_api_url),
        )
        user_youtube = UserYouTube(settings, accounts)
    app.state.accounts = accounts
    app.state.user_youtube = user_youtube
    app.state.account_pairing = AccountPairing(accounts) if accounts is not None else None
    # Cookies are only read on demand (never at startup), and only when sign-in is configured.
    cookies = CookieLoader(settings)
    app.state.cookies = cookies
    cookies_for = (lambda: user_youtube.cookie_loader(current_user())) if user_youtube is not None else None
    app.state.feeds = YouTubePagesService(settings, cookies, cookies_for=cookies_for)
    app.state.account = AccountService(settings, cookies)
    app.state.browser_reports = BrowserReports()
    registry = AppRegistry(settings, default_apps(settings, accounts) if apps is None else apps, accounts)
    app.state.apps = registry

    def private_data() -> AppError | None:
        if settings.signed_in_configured:
            return AppError(
                "forbidden",
                "This server is using a signed-in YouTube session, so it only answers requests from this computer.",
                status=403,
                hint="Open the app on the computer running the server (http://localhost:...), or turn "
                     "sign-in off to use it from other devices.",
            )
        if registry.private_data_active():
            return AppError(
                "forbidden",
                "This server has an app connected to private data (such as a Plex library), so it only answers "
                "requests from this computer.",
                status=403,
                hint="Pair this device: open this site on it and choose Pair this device.",
            )
        return None

    devices = DeviceStore(settings.app_config_dir)
    app.state.devices = devices
    app.state.private_data = private_data

    def allowed(scope: Scope) -> bool:
        if scope.get("path", "").startswith("/api/pairing/"):
            return True
        cookies = dict(scope.get("headers") or []).get(b"cookie", b"").decode("latin-1")
        return devices.device_for(cookie_value(cookies, DEVICE_COOKIE)) is not None

    if accounts is not None and user_youtube is not None:
        app.add_middleware(AuthGuard, accounts=accounts, youtube=user_youtube)
    else:
        app.add_middleware(LoopbackGuard, reason=private_data, allow=allowed)

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
    app.include_router(pairing_router)
    app.include_router(accounts_router)
    registry.mount(app)

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "HEAD"], include_in_schema=False)
    async def api_not_found(rest: str) -> JSONResponse:
        error = AppError("not_found", "Unknown API endpoint.", status=404)
        return JSONResponse(status_code=404, content={"error": error.to_dict()})

    dist = settings.frontend_dist
    if dist is not None and (dist / "index.html").is_file():
        _mount_frontend(app, dist, content_security_policy(settings))
    return app


def _mount_frontend(app: FastAPI, dist: Path, csp: str) -> None:
    """Serve the production build from the same origin as the API (keeps canvas untainted)."""
    root = dist.resolve()
    index = root / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            headers = {"Cache-Control": "public, max-age=31536000, immutable"} if path.startswith("assets/") else {}
            return FileResponse(candidate, headers=headers)
        return FileResponse(index, headers={"Cache-Control": "no-cache", "Content-Security-Policy": csp})


app = create_app()

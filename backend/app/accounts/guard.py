"""With accounts on, every ``/api`` request must come from a signed-in, allowlisted person.

A request is signed in by a Clerk session token (``Authorization: Bearer``, or the
``__session`` cookie the Clerk SDK keeps on our origin, which also covers posters and media
byte ranges) or by a paired device's cookie. Writes authenticated only by a cookie must carry
an ``Origin`` of this same host, so other sites can't make a signed-in browser change things.
The person and their YouTube session are current for the rest of the request.

Open without signing in: ``/api/auth/config`` (the publishable key) and starting or
finishing a device pairing.
"""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ..devices import DEVICE_COOKIE, cookie_value
from ..errors import AppError
from ..session import reset_session, use_session
from .clerk import InvalidSession
from .users import Accounts, NotInvited, User, reset_user, use_user
from .youtube import UserYouTube

log = logging.getLogger(__name__)

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def is_public(method: str, path: str) -> bool:
    if path == "/api/auth/config":
        return True
    # A device asking to be paired, and collecting its cookie once approved.
    return ((path == "/api/pairing/requests" and method == "POST")
            or (path.startswith("/api/pairing/requests/") and method == "GET"))


def session_cookie(cookie_header: str) -> str | None:
    """Clerk's ``__session`` cookie (or its suffixed variant, ``__session_<id>``)."""
    token = cookie_value(cookie_header, "__session")
    if token:
        return token
    for part in cookie_header.split(";"):
        name, _, value = part.strip().partition("=")
        if name.startswith("__session_") and value:
            return value
    return None


def _deny(error: AppError) -> JSONResponse:
    return JSONResponse(status_code=error.status, content={"error": error.to_dict()})


class AuthGuard:
    def __init__(self, app: ASGIApp, accounts: Accounts, youtube: UserYouTube) -> None:
        self.app = app
        self.accounts = accounts
        self.youtube = youtube

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not (path == "/api" or path.startswith("/api/")):
            await self.app(scope, receive, send)
            return
        method = scope.get("method", "GET")
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope.get("headers") or []}
        if is_public(method, path):
            await self.app(scope, receive, send)
            return
        try:
            user, by_cookie = await self._identify(headers)
        except AppError as error:
            await _deny(error)(scope, receive, send)
            return
        if user is None:
            await _deny(AppError("auth_required", "Sign in to use yt-canvas.", status=401))(scope, receive, send)
            return
        if by_cookie and method not in SAFE_METHODS and not self._same_origin(headers):
            await _deny(AppError("forbidden", "That request came from another site.", status=403))(scope, receive, send)
            return
        user_token = use_user(user)
        session_token = use_session(await self.youtube.session(user))
        try:
            await self.app(scope, receive, send)
        finally:
            reset_session(session_token)
            reset_user(user_token)

    async def _identify(self, headers: dict[str, str]) -> tuple[User | None, bool]:
        """(the person, whether a cookie rather than a header said so). Raises AppError."""
        host = headers.get("host")
        cookies = headers.get("cookie", "")
        bearer = headers.get("authorization", "")
        candidates = []
        if bearer.lower().startswith("bearer "):
            candidates.append((bearer[7:].strip(), False))
        cookie_token = session_cookie(cookies)
        if cookie_token:
            candidates.append((cookie_token, True))
        try:
            for token, by_cookie in candidates:
                try:
                    return await self.accounts.from_session(token, host), by_cookie
                except InvalidSession as exc:
                    log.debug("ignoring a session token: %s", exc)
            device = cookie_value(cookies, DEVICE_COOKIE)
            if device:
                return await self.accounts.from_device(device), True
        except NotInvited as exc:
            raise AppError("not_invited", f"{exc.email} isn't on this yt-canvas's list of people who can use it.",
                           status=403, hint="Ask whoever runs it to add your email, or sign in with another account.") from None
        return None, False

    @staticmethod
    def _same_origin(headers: dict[str, str]) -> bool:
        origin = headers.get("origin")
        if not origin:
            # Browsers send Origin on every cross-site write; a missing one is a same-site form
            # or a non-browser client, which can't carry our SameSite cookies from elsewhere.
            return headers.get("sec-fetch-site") in (None, "same-origin", "none")
        return urlsplit(origin).netloc.lower() == (headers.get("host") or "").lower()

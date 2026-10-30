"""Signing in to Plex, choosing a server, and calling it.

Sign-in is Plex's PIN flow: yt-canvas asks plex.tv for a PIN, the person approves it on
Plex's own page (signing in there if needed), and plex.tv then hands the PIN's token to
yt-canvas. yt-canvas never sees a Plex password.
"""

from __future__ import annotations

import asyncio
import logging
import time
import urllib.parse
from typing import Any

from pydantic import BaseModel

from ...config import Settings
from ...errors import AppError
from .client import PRODUCT, PlexResponse, check, client_headers, send, url_with
from .store import PlexStore

log = logging.getLogger(__name__)

CONNECT_TIMEOUT = 6.0


class SignIn(BaseModel):
    pin_id: int
    code: str
    auth_url: str
    expires_at: str | None


class SignInState(BaseModel):
    # waiting: not approved yet; connected; no_server: signed in, no server reachable; expired.
    state: str
    status: PlexStatus | None = None


class PlexServerView(BaseModel):
    id: str
    name: str
    online: bool
    owned: bool
    selected: bool


class PlexStatus(BaseModel):
    connected: bool
    signed_in: bool
    account: str | None = None
    avatar: str | None = None
    server: str | None = None
    # How yt-canvas reaches it: "local", "remote" or "relay".
    connection: str | None = None


SignInState.model_rebuild()


class PlexService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = PlexStore(settings.app_config_dir)

    # -- status and sign-in -------------------------------------------------------------

    def status(self) -> PlexStatus:
        account = self.store.account
        server = self.store.server
        return PlexStatus(
            connected=self.store.connected,
            signed_in=account is not None,
            account=account.get("name") if account else None,
            avatar=account.get("avatar") if account else None,
            server=server.get("name") if server else None,
            connection=server.get("connection") if server else None,
        )

    def _tv_headers(self, token: str | None = None) -> dict[str, str]:
        return client_headers(self.store.client_id, token)

    async def start_signin(self) -> SignIn:
        response = check(await send("POST", url_with(self.settings.plex_tv_url, "/api/v2/pins", {"strong": "true"}),
                                    self._tv_headers()), "sign-in code")
        pin = response.json()
        fragment = urllib.parse.urlencode({
            "clientID": self.store.client_id,
            "code": pin["code"],
            "context[device][product]": PRODUCT,
        })
        return SignIn(pin_id=pin["id"], code=pin["code"], auth_url=f"{self.settings.plex_auth_url}#?{fragment}",
                      expires_at=pin.get("expiresAt"))

    async def check_signin(self, pin_id: int) -> SignInState:
        response = await send("GET", url_with(self.settings.plex_tv_url, f"/api/v2/pins/{pin_id}"), self._tv_headers())
        if response.status == 404:
            return SignInState(state="expired")
        pin = check(response, "sign-in code").json()
        token = pin.get("authToken")
        if not token:
            return SignInState(state="waiting")
        name, avatar = await self._account(token)
        self.store.set_account(token, name, avatar)
        log.info("signed in to Plex as %s", name or "(unnamed account)")
        try:
            await self.connect_server()
        except AppError as exc:
            log.warning("signed in to Plex, but no server is reachable: %s", exc.message)
            return SignInState(state="no_server", status=self.status())
        return SignInState(state="connected", status=self.status())

    async def _account(self, token: str) -> tuple[str | None, str | None]:
        response = await send("GET", url_with(self.settings.plex_tv_url, "/api/v2/user"), self._tv_headers(token))
        if not 200 <= response.status < 300:
            return None, None
        user = response.json()
        return user.get("friendlyName") or user.get("username") or user.get("title"), user.get("thumb")

    def disconnect(self) -> None:
        self.store.clear()
        log.info("disconnected from Plex")

    # -- servers ------------------------------------------------------------------------

    def _token(self) -> str:
        account = self.store.account
        if not account:
            raise AppError("plex_signed_out", "Plex isn't connected.", status=401, hint="Connect Plex first.")
        return account["token"]

    async def _resources(self) -> list[dict[str, Any]]:
        response = check(await send(
            "GET",
            url_with(self.settings.plex_tv_url, "/api/v2/resources", {"includeHttps": 1, "includeRelay": 1, "includeIPv6": 1}),
            self._tv_headers(self._token()),
        ), "server list")
        resources = response.json()
        servers = [r for r in resources if isinstance(r, dict) and "server" in str(r.get("provides", "")).split(",")]
        # Online servers first, then the account's own.
        return sorted(servers, key=lambda r: (not r.get("presence"), not r.get("owned")))

    async def servers(self) -> list[PlexServerView]:
        selected = (self.store.server or {}).get("id")
        return [PlexServerView(id=r["clientIdentifier"], name=r.get("name") or "Plex Media Server",
                               online=bool(r.get("presence")), owned=bool(r.get("owned")),
                               selected=r["clientIdentifier"] == selected) for r in await self._resources()]

    async def connect_server(self, server_id: str | None = None) -> PlexStatus:
        """Pick a server (the given one, or the first that answers) and the best way to reach it."""
        candidates = [r for r in await self._resources() if server_id in (None, r.get("clientIdentifier"))]
        if server_id and not candidates:
            raise AppError("not_found", "Your Plex account has no such server.", status=404)
        for resource in candidates:
            found = await self._reachable(resource)
            if found:
                uri, connection = found
                self.store.set_server({
                    "id": resource["clientIdentifier"],
                    "name": resource.get("name") or "Plex Media Server",
                    "uri": uri,
                    "token": resource.get("accessToken") or self._token(),
                    "connection": connection,
                })
                log.info("using Plex server %s (%s connection)", resource.get("name"), connection)
                return self.status()
        raise AppError("plex_unreachable", "None of your Plex servers can be reached from this computer.",
                       status=502, retryable=True, hint="Check that the server is running and remote access is on.")

    async def _reachable(self, resource: dict[str, Any]) -> tuple[str, str] | None:
        """Try every connection at once; prefer local, then remote, then relay."""
        connections = [c for c in resource.get("connections", []) if isinstance(c, dict) and c.get("uri")]
        token = resource.get("accessToken") or self._token()

        async def probe(connection: dict[str, Any]) -> bool:
            try:
                response = await send("GET", url_with(connection["uri"], "/identity"),
                                      client_headers(self.store.client_id, token), timeout=CONNECT_TIMEOUT)
            except AppError:
                return False
            return response.status == 200

        results = await asyncio.gather(*(probe(c) for c in connections))
        kind = lambda c: "relay" if c.get("relay") else "local" if c.get("local") else "remote"  # noqa: E731
        rank = {"local": 0, "remote": 1, "relay": 2}
        working = sorted((c for c, ok in zip(connections, results) if ok),
                         key=lambda c: (rank[kind(c)], c.get("protocol") != "https", bool(c.get("IPv6"))))
        return (working[0]["uri"], kind(working[0])) if working else None

    # -- calling the server -----------------------------------------------------------

    def _server(self) -> dict[str, Any]:
        server = self.store.server
        if not server or not self.store.account:
            raise AppError("plex_signed_out", "Plex isn't connected.", status=401, hint="Connect Plex first.")
        return server

    def server_headers(self, **extra: str) -> dict[str, str]:
        return client_headers(self.store.client_id, self._server()["token"], **extra)

    def server_url(self, path: str, params: dict[str, Any] | None = None) -> str:
        return url_with(self._server()["uri"], path, params)

    async def get(self, path: str, params: dict[str, Any] | None = None, *, what: str = "item",
                  headers: dict[str, str] | None = None, timeout: float = 20.0) -> PlexResponse:
        response = await send("GET", self.server_url(path, params), {**self.server_headers(), **(headers or {})},
                              timeout=timeout)
        return check(response, what)

    async def json(self, path: str, params: dict[str, Any] | None = None, *, what: str = "item") -> dict[str, Any]:
        container = (await self.get(path, params, what=what)).json().get("MediaContainer")
        return container if isinstance(container, dict) else {}

    @staticmethod
    def now() -> float:
        return time.time()

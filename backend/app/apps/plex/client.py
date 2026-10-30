"""HTTP to plex.tv and to a Plex Media Server, as the "yt-canvas" Plex client.

Tokens only travel in the ``X-Plex-Token`` header, never in a URL, and nothing here logs
them. Requests run in a worker thread with urllib, like the YouTube stream proxy.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

import anyio

from ...errors import AppError

PRODUCT = "yt-canvas"
VERSION = "0.1"

# Replaced in tests.
urlopen = urllib.request.urlopen


@dataclass
class PlexResponse:
    status: int
    headers: dict[str, str]
    body: bytes

    def header(self, name: str) -> str | None:
        lowered = name.lower()
        return next((value for key, value in self.headers.items() if key.lower() == lowered), None)

    def json(self) -> Any:
        try:
            return json.loads(self.body or b"{}")
        except ValueError:
            raise AppError("plex_error", "Plex sent an answer yt-canvas couldn't read.", status=502) from None


def client_headers(client_id: str, token: str | None = None, **extra: str) -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "X-Plex-Product": PRODUCT,
        "X-Plex-Version": VERSION,
        "X-Plex-Client-Identifier": client_id,
        "X-Plex-Platform": "Chrome",
        "X-Plex-Device": "yt-canvas",
        "X-Plex-Device-Name": "yt-canvas",
        **extra,
    }
    if token:
        headers["X-Plex-Token"] = token
    return headers


def url_with(base: str, path: str, params: dict[str, Any] | None = None) -> str:
    query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
    return f"{base.rstrip('/')}{path}{'?' + query if query else ''}"


def _send(method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> PlexResponse:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            return PlexResponse(response.status, dict(response.headers.items()), response.read())
    except urllib.error.HTTPError as exc:
        body = exc.read() if exc.fp else b""
        return PlexResponse(exc.code, dict(exc.headers.items()) if exc.headers else {}, body)


async def send(method: str, url: str, headers: dict[str, str], *, body: bytes | None = None,
               timeout: float = 20.0) -> PlexResponse:
    try:
        return await anyio.to_thread.run_sync(_send, method, url, headers, body, timeout)
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
        raise AppError("plex_unreachable", "Can't reach Plex right now.", status=502, retryable=True,
                       hint="Check that the Plex server is running and online.") from exc


def check(response: PlexResponse, what: str) -> PlexResponse:
    """Raise a clear error for a non-2xx answer."""
    if 200 <= response.status < 300:
        return response
    if response.status == 401:
        raise AppError("plex_signed_out", "Plex didn't accept the sign-in. Connect Plex again.", status=401)
    if response.status == 404:
        raise AppError("not_found", f"Plex doesn't have that {what}.", status=404)
    raise AppError("plex_error", f"Plex couldn't answer ({response.status}) for {what}.", status=502,
                   retryable=response.status >= 500)

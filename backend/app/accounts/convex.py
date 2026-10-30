"""The yt-canvas server's client for its Convex deployment.

Every call goes to the ``/backend`` HTTP action (``frontend/convex/http.ts``) with the shared
secret, naming one internal function (``users.resolve``, ``library.put``, ...). Secrets are
already encrypted when they get here, and nothing is logged but the operation's name.
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.error
import urllib.request
from typing import Any, Protocol

from ..errors import AppError

log = logging.getLogger(__name__)

TIMEOUT = 15


class AccountStore(Protocol):
    async def call(self, op: str, **args: Any) -> Any: ...


def unavailable(detail: str) -> AppError:
    return AppError("accounts_unavailable", "Couldn't reach the account database.", status=503,
                    hint=f"Try again in a moment. ({detail})", retryable=True)


class ConvexClient:
    def __init__(self, site_url: str, secret: str) -> None:
        self._url = f"{site_url.rstrip('/')}/backend"
        self._secret = secret

    def _post(self, body: bytes) -> tuple[int, bytes]:
        request = urllib.request.Request(self._url, data=body, method="POST", headers={
            "Authorization": f"Bearer {self._secret}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310 - fixed https URL
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    async def call(self, op: str, **args: Any) -> Any:
        body = json.dumps({"op": op, "args": args}).encode()
        try:
            status, raw = await asyncio.to_thread(self._post, body)
        except (OSError, TimeoutError) as exc:
            log.warning("convex %s failed: %s", op, type(exc).__name__)
            raise unavailable(type(exc).__name__) from None
        try:
            data = json.loads(raw)
        except ValueError:
            data = {}
        if status != 200:
            log.warning("convex %s: HTTP %d %s", op, status, data.get("error"))
            raise unavailable(f"HTTP {status}")
        return data.get("result")

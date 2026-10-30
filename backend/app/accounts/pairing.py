"""Pairing a device (a car, a TV) to someone's account, with accounts on.

The device asks for a 6-digit code; someone signed in on any of their devices enters it on
Devices, which ties the request to their account; the device's next check receives a
long-lived HttpOnly cookie. Pending requests live in memory for 10 minutes; paired devices
(only the hash of each cookie) are stored in the person's account, so they can see and
revoke them from anywhere.
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..devices import MAX_PENDING, REQUEST_TTL
from .users import Accounts, User, token_hash


@dataclass
class _Request:
    id: str
    code: str
    name: str
    created: float
    secret_hash: str
    approved_by: str | None = None  # a user id

    def view(self) -> dict[str, Any]:
        return {"id": self.id, "code": self.code, "name": self.name, "expires_at": self.created + REQUEST_TTL,
                "approved": self.approved_by is not None}


class AccountPairing:
    def __init__(self, accounts: Accounts, clock: Callable[[], float] = time.time) -> None:
        self.accounts = accounts
        self._clock = clock
        self._requests: dict[str, _Request] = {}

    def _live(self) -> list[_Request]:
        now = self._clock()
        self._requests = {r.id: r for r in self._requests.values() if now - r.created < REQUEST_TTL}
        return list(self._requests.values())

    def create_request(self, name: str) -> tuple[dict[str, Any], str]:
        secret = secrets.token_urlsafe(32)
        live = self._live()
        codes = {r.code for r in live}
        code = f"{secrets.randbelow(10**6):06d}"
        while code in codes:
            code = f"{secrets.randbelow(10**6):06d}"
        request = _Request(id=secrets.token_hex(8), code=code, name=name[:60], created=self._clock(),
                           secret_hash=token_hash(secret))
        for old in live[: max(0, len(live) - MAX_PENDING + 1)]:
            self._requests.pop(old.id, None)
        self._requests[request.id] = request
        return request.view(), secret

    def approve(self, code: str, user: User) -> dict[str, Any] | None:
        for request in self._live():
            if request.approved_by is None and secrets.compare_digest(request.code, code.strip()):
                request.approved_by = user.id
                return request.view()
        return None

    async def collect(self, request_id: str, secret: str | None) -> tuple[str, str | None]:
        """("waiting" | "paired" | "expired", the new device cookie when just paired)."""
        request = next((r for r in self._live() if r.id == request_id), None)
        if request is None or not secret or not secrets.compare_digest(request.secret_hash, token_hash(secret)):
            return "expired", None
        if request.approved_by is None:
            return "waiting", None
        token = secrets.token_urlsafe(32)
        await self.accounts.store.call("devices.create", userId=request.approved_by, name=request.name,
                                       tokenHash=token_hash(token))
        self._requests.pop(request.id, None)
        return "paired", token

    async def devices(self, user: User) -> list[dict[str, Any]]:
        return await self.accounts.store.call("devices.list", userId=user.id) or []

    async def revoke(self, user: User, device_id: str) -> bool:
        digest = await self.accounts.store.call("devices.revoke", userId=user.id, deviceId=device_id)
        if digest:
            self.accounts.forget_device(digest)
        return bool(digest)

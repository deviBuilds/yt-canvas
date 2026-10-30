"""Whose Plex: one connection for the whole server in no-login mode, one per person with accounts.

With accounts on, a person's Plex sign-in (client id, token, server) is loaded from their
account the first time they use Plex on this server, kept in memory, and saved back
encrypted whenever it changes. Each person also gets their own playback sessions.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

from ...accounts.users import Accounts, current_user, require_user
from ...config import Settings
from .library import PlexLibraryService
from .playback import PlexPlayback
from .service import PlexService
from .store import PlexStore

log = logging.getLogger(__name__)

KIND = "plex"


@dataclass
class PlexBundle:
    plex: PlexService
    library: PlexLibraryService
    playback: PlexPlayback


def _bundle(plex: PlexService) -> PlexBundle:
    return PlexBundle(plex, PlexLibraryService(plex), PlexPlayback(plex))


def _meta(data: dict[str, Any]) -> dict[str, Any]:
    """What's safe to keep unencrypted: whether it's connected, and to what."""
    account, server = data.get("account") or {}, data.get("server") or {}
    return {"connected": bool(account and server), "account": account.get("name"), "server": server.get("name")}


class PlexUsers:
    def __init__(self, settings: Settings, accounts: Accounts | None = None) -> None:
        self.settings = settings
        self.accounts = accounts
        self._local = _bundle(PlexService(settings)) if accounts is None else None
        self._bundles: dict[str, PlexBundle] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._pending: dict[str, dict[str, Any]] = {}
        self._writers: dict[str, asyncio.Task[None]] = {}

    async def current(self) -> PlexBundle:
        if self._local is not None:
            return self._local
        assert self.accounts is not None
        user = require_user()
        bundle = self._bundles.get(user.id)
        if bundle is not None:
            return bundle
        async with self._locks.setdefault(user.id, asyncio.Lock()):
            bundle = self._bundles.get(user.id)
            if bundle is None:
                data = await self.accounts.secret_json(user.id, KIND) if KIND in user.secrets else None
                store = PlexStore(None, data=data or {}, persist=lambda data, uid=user.id: self._save(uid, data))
                bundle = self._bundles[user.id] = _bundle(PlexService(self.settings, store))
        return bundle

    def connected(self) -> bool:
        """Is the current person's (or, in no-login mode, the server's) Plex connected?"""
        if self._local is not None:
            return self._local.plex.store.connected
        user = current_user()
        if user is None:
            return False
        bundle = self._bundles.get(user.id)
        if bundle is not None:
            return bundle.plex.store.connected
        return bool((user.secret_meta(KIND) or {}).get("connected"))

    def all_local(self) -> list[PlexBundle]:
        return [self._local] if self._local is not None else list(self._bundles.values())

    # -- saving, newest state last, one write at a time per person ------------------------------

    def _save(self, user_id: str, data: dict[str, Any]) -> None:
        self._pending[user_id] = data
        if user_id not in self._writers:
            task = asyncio.get_running_loop().create_task(self._write(user_id))
            self._writers[user_id] = task

    async def _write(self, user_id: str) -> None:
        assert self.accounts is not None
        try:
            while user_id in self._pending:
                data = self._pending.pop(user_id)
                try:
                    await self.accounts.put_secret(user_id, KIND, json.dumps(data).encode(), _meta(data))
                except Exception as exc:  # noqa: BLE001 - kept in memory; saved with the next change
                    log.warning("couldn't save a Plex connection: %s", type(exc).__name__)
        finally:
            self._writers.pop(user_id, None)

    async def flush(self) -> None:
        """Wait for pending saves (tests, shutdown)."""
        while self._writers:
            await asyncio.gather(*list(self._writers.values()), return_exceptions=True)

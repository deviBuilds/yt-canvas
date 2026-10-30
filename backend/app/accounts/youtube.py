"""Each person's YouTube cookies (uploaded as a cookies.txt) and their YouTube session.

The upload can be a Netscape cookies.txt, a JSON export or a Cookie header; it is converted to
a cookies.txt holding only its youtube.com cookies, which is encrypted into Convex. For yt-dlp, the cookies are written to ``<config dir>/users/<tag>/cookies.txt``
(mode 0600) whenever the stored copy is newer; yt-dlp rewrites that file with refreshed
cookies, which are re-encrypted and stored again (at most every few minutes), so the session
stays alive across restarts and on other servers. Cookie values are never logged.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import logging
import os
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Settings
from ..cookies import CookieLoader, UnknownCookieFormat, netscape_text, to_netscape, youtube_lines
from ..discovery.account import AccountService
from ..errors import AppError
from ..session import YouTubeSession
from .users import Accounts, User

log = logging.getLogger(__name__)

KIND = "youtube_cookies"
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
SYNC_EVERY = 5 * 60


@dataclass
class _Entry:
    updated_at: int  # the stored copy this file was written from
    meta: dict[str, Any]
    settings: Settings
    mtime: float
    synced_at: float
    loader: CookieLoader
    account: AccountService


class UserYouTube:
    def __init__(self, settings: Settings, accounts: Accounts, clock: Callable[[], float] = time.monotonic) -> None:
        self.base = settings  # accounts mode: no server-wide cookies
        self.accounts = accounts
        self._clock = clock
        self._dir = settings.app_config_dir / "users"
        self._entries: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._signed_out = AccountService(settings, CookieLoader(settings))
        self._tasks: set[asyncio.Task[Any]] = set()

    def _path(self, user_id: str) -> Path:
        tag = hashlib.sha256(f"ytc-user:{user_id}".encode()).hexdigest()[:16]
        return self._dir / tag / "cookies.txt"

    def _write(self, path: Path, text: str) -> float:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = path.with_name(f"cookies.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
        return path.stat().st_mtime

    def _entry_for(self, updated_at: int, meta: dict[str, Any], path: Path, mtime: float) -> _Entry:
        settings = dataclasses.replace(self.base, cookies_file=path, cookies_from_browser=None)
        loader = CookieLoader(settings)
        return _Entry(updated_at=updated_at, meta=meta, settings=settings, mtime=mtime, synced_at=self._clock(),
                      loader=loader, account=AccountService(settings, loader))

    def _drop(self, user_id: str) -> None:
        self._entries.pop(user_id, None)
        shutil.rmtree(self._path(user_id).parent, ignore_errors=True)

    async def session(self, user: User) -> YouTubeSession:
        """The person's YouTube session for this request (with their cookies, if they uploaded some)."""
        entry = await self._entry(user)
        return YouTubeSession(user.id, entry.settings if entry else self.base)

    async def _entry(self, user: User) -> _Entry | None:
        stored = user.secrets.get(KIND)
        if stored is None:
            if user.id in self._entries:
                self._drop(user.id)
            return None
        entry = self._entries.get(user.id)
        if entry is not None and entry.updated_at >= stored["updatedAt"]:
            self._maybe_sync(user.id, entry)
            return entry
        async with self._locks.setdefault(user.id, asyncio.Lock()):
            entry = self._entries.get(user.id)
            if entry is not None and entry.updated_at >= stored["updatedAt"]:
                return entry
            plaintext = await self.accounts.secret(user.id, KIND)
            if plaintext is None:
                return None
            path = self._path(user.id)
            mtime = await asyncio.to_thread(self._write, path, plaintext.decode("utf-8", errors="replace"))
            entry = self._entry_for(stored["updatedAt"], dict(stored.get("meta") or {}), path, mtime)
            self._entries[user.id] = entry
            return entry

    def account_service(self, user: User | None) -> AccountService:
        """The person's /api/me and personal feeds (or the signed-out one when they have no cookies)."""
        entry = self._entries.get(user.id) if user is not None and KIND in user.secrets else None
        return entry.account if entry else self._signed_out

    def cookie_loader(self, user: User | None) -> CookieLoader | None:
        entry = self._entries.get(user.id) if user is not None and KIND in user.secrets else None
        return entry.loader if entry else None

    # -- upload and removal ---------------------------------------------------------------------

    async def upload(self, user: User, raw: bytes) -> dict[str, Any]:
        if len(raw) > MAX_UPLOAD_BYTES:
            raise AppError("invalid_input", "That file is too large for a cookies.txt.", status=413)
        try:
            lines, source = to_netscape(raw.decode("utf-8", errors="replace"))
        except UnknownCookieFormat:
            raise AppError("invalid_input", "That isn't a cookie export yt-canvas can read.",
                           hint="Use a cookies.txt (Netscape format), a JSON export from a cookie extension, "
                                "or the Cookie header of a youtube.com request.") from None
        if not lines:
            raise AppError("invalid_input", "There are no youtube.com cookies in it.",
                           hint="Export the cookies while signed in to YouTube, with youtube.com open.")
        text = netscape_text(lines)
        meta = {"count": len(lines), "uploaded_at": time.time(), "format": source}
        updated_at = await self.accounts.put_secret(user.id, KIND, text.encode(), meta)
        path = self._path(user.id)
        mtime = await asyncio.to_thread(self._write, path, text)
        self._entries[user.id] = self._entry_for(updated_at, meta, path, mtime)
        log.info("stored %d youtube.com cookies for a user", len(lines))
        return meta

    async def remove(self, user: User) -> None:
        await self.accounts.delete_secret(user.id, KIND)
        self._drop(user.id)

    # -- keeping the stored copy fresh -------------------------------------------------------------

    def _maybe_sync(self, user_id: str, entry: _Entry) -> None:
        if self._clock() - entry.synced_at < SYNC_EVERY:
            return
        try:
            mtime = entry.settings.cookies_file.stat().st_mtime  # type: ignore[union-attr]
        except OSError:
            return
        entry.synced_at = self._clock()
        if mtime == entry.mtime:
            return
        entry.mtime = mtime
        task = asyncio.get_running_loop().create_task(self._sync(user_id, entry))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _sync(self, user_id: str, entry: _Entry) -> None:
        """yt-dlp refreshed the cookies: store the new ones (youtube.com lines only)."""
        try:
            path = entry.settings.cookies_file
            assert path is not None
            text = await asyncio.to_thread(path.read_text, "utf-8", "replace")
            lines = youtube_lines(text)
            if not lines:
                return
            meta = {**entry.meta, "count": len(lines), "refreshed_at": time.time()}
            entry.updated_at = await self.accounts.put_secret(user_id, KIND, netscape_text(lines).encode(), meta)
            entry.meta = meta
            log.info("stored refreshed YouTube cookies for a user")
        except Exception as exc:  # noqa: BLE001 - try again at the next sync
            log.warning("couldn't store refreshed YouTube cookies: %s", type(exc).__name__)

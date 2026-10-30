"""Each person's YouTube cookies (uploaded as a cookies.txt) and their YouTube session.

The upload can be a Netscape cookies.txt, a JSON export or a Cookie header; it is converted to
a cookies.txt holding only its youtube.com cookies, which is encrypted into Convex. For yt-dlp, the cookies are written to ``<config dir>/users/<tag>/cookies.txt``
(mode 0600) whenever the stored copy is newer; yt-dlp rewrites that file with refreshed
cookies, which are re-encrypted and stored again (at most every few minutes), so the session
stays alive across restarts and on other servers.

Renewing (:mod:`.renew`): every few hours (with jitter per person), or on "Renew now", a
youtube.com page load with the cookies keeps what YouTube refreshes, so they stay fresh while
nobody is watching. It stops when YouTube treats them as signed out, until new ones are
uploaded. Cookie values are never logged.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import logging
import os
import random
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
from .renew import Renewal, RenewFailed, SessionEnded, newest, refresh
from .users import Accounts, User

log = logging.getLogger(__name__)

KIND = "youtube_cookies"
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
SYNC_EVERY = 5 * 60
# Each person's next renewal is RENEW_EVERY ± RENEW_JITTER after the last, so renewals don't
# follow a clock or happen for everyone at once.
RENEW_EVERY = 3 * 60 * 60
RENEW_JITTER = 30 * 60
RENEW_CHECK = 5 * 60  # how often the background renewal looks for cookies that are due
RENEW_RETRY = 20 * 60  # after a failed background renewal
RENEW_SPACING = (1.0, 5.0)  # seconds between two people's renewals in one check
RENEW_MIN_GAP = 60  # "Renew now" at most this often


@dataclass
class _Entry:
    updated_at: int  # the stored copy this file was written from
    meta: dict[str, Any]
    settings: Settings
    mtime: float
    synced_at: float
    loader: CookieLoader
    account: AccountService
    lines: list[str]  # what was last stored


class UserYouTube:
    def __init__(self, settings: Settings, accounts: Accounts, clock: Callable[[], float] = time.monotonic, *,
                 refresher: Callable[[list[str]], Renewal] = refresh, now: Callable[[], float] = time.time,
                 jitter: Callable[[float, float], float] = random.uniform) -> None:
        self.base = settings  # accounts mode: no server-wide cookies
        self.accounts = accounts
        self._clock = clock
        self._refresh = refresher
        self._now = now
        self._jitter = jitter
        self._retry_at: dict[str, float] = {}  # after a failed background renewal
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

    def _entry_for(self, updated_at: int, meta: dict[str, Any], path: Path, mtime: float, lines: list[str]) -> _Entry:
        settings = dataclasses.replace(self.base, cookies_file=path, cookies_from_browser=None)
        loader = CookieLoader(settings)
        return _Entry(updated_at=updated_at, meta=meta, settings=settings, mtime=mtime, synced_at=self._clock(),
                      loader=loader, account=AccountService(settings, loader), lines=lines)

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
        return await self._entry_from(user.id, stored)

    async def _entry_from(self, user_id: str, stored: dict[str, Any]) -> _Entry | None:
        entry = self._entries.get(user_id)
        if entry is not None and entry.updated_at >= stored["updatedAt"]:
            self._maybe_sync(user_id, entry)
            return entry
        async with self._lock(user_id):
            entry = self._entries.get(user_id)
            if entry is not None and entry.updated_at >= stored["updatedAt"]:
                return entry
            plaintext = await self.accounts.secret(user_id, KIND)
            if plaintext is None:
                return None
            text = plaintext.decode("utf-8", errors="replace")
            path = self._path(user_id)
            mtime = await asyncio.to_thread(self._write, path, text)
            entry = self._entry_for(stored["updatedAt"], dict(stored.get("meta") or {}), path, mtime,
                                    youtube_lines(text))
            self._entries[user_id] = entry
            return entry

    def _lock(self, user_id: str) -> asyncio.Lock:
        return self._locks.setdefault(user_id, asyncio.Lock())

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
        meta = {"count": len(lines), "uploaded_at": self._now(), "format": source,
                "next_renew_at": self._next_renewal()}
        updated_at = await self.accounts.put_secret(user.id, KIND, text.encode(), meta)
        path = self._path(user.id)
        mtime = await asyncio.to_thread(self._write, path, text)
        self._entries[user.id] = self._entry_for(updated_at, meta, path, mtime, lines)
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
            written = youtube_lines(text)
            if not written:
                return
            lines = newest(entry.lines, written)
            if lines != written:  # a yt-dlp run wrote back cookies from before a renewal
                entry.mtime = await asyncio.to_thread(self._write, path, netscape_text(lines))
            meta = {**entry.meta, "count": len(lines), "refreshed_at": self._now()}
            entry.updated_at = await self.accounts.put_secret(user_id, KIND, netscape_text(lines).encode(), meta)
            entry.meta = meta
            entry.lines = lines
            log.info("stored refreshed YouTube cookies for a user")
        except Exception as exc:  # noqa: BLE001 - try again at the next sync
            log.warning("couldn't store refreshed YouTube cookies: %s", type(exc).__name__)

    # -- renewing ---------------------------------------------------------------------------------

    async def renew(self, user: User) -> dict[str, Any]:
        """"Renew now": refresh the person's cookies with a youtube.com visit."""
        entry = await self._entry(user)
        if entry is None:
            raise AppError("invalid_input", "Upload your YouTube cookies first.", status=409)
        if self._now() - (entry.meta.get("renewed_at") or 0) < RENEW_MIN_GAP:
            raise AppError("rate_limited", "They were renewed less than a minute ago.", status=429, retryable=True)
        async with self._lock(user.id):
            try:
                refreshed = await self._renew(user.id, entry)
            except SessionEnded:
                raise AppError(
                    "signin_failed", "YouTube treats these cookies as signed out.", status=409,
                    hint="Upload fresh ones, exported from a private window that you then close, and don't give the "
                         "same export to another app: copies of one session that drift apart get it ended.") from None
            except RenewFailed as exc:
                raise AppError("upstream_error", "Couldn't renew your cookies with YouTube.", status=502,
                               hint=f"{exc}. Try again in a minute.", retryable=True) from None
        return {"renewed_at": entry.meta["renewed_at"], "refreshed": refreshed}

    async def _renew(self, user_id: str, entry: _Entry) -> list[str]:
        """Refresh and store the cookies (hold the person's lock). On :class:`SessionEnded` the
        stored copy is marked so and background renewal stops; other failures change nothing."""
        path = entry.settings.cookies_file
        assert path is not None
        text = await asyncio.to_thread(path.read_text, "utf-8", "replace")
        lines = newest(entry.lines, youtube_lines(text))  # with what yt-dlp has refreshed since
        try:
            renewal = await asyncio.to_thread(self._refresh, lines)
        except SessionEnded:
            meta = {**entry.meta, "renew_error": "session_ended", "renew_failed_at": self._now()}
            entry.updated_at = await self.accounts.put_secret(user_id, KIND, netscape_text(lines).encode(), meta)
            entry.meta = meta
            log.info("YouTube treats a person's cookies as signed out; they need uploading again")
            raise
        meta = {k: v for k, v in entry.meta.items() if k not in ("renew_error", "renew_failed_at")}
        meta.update(count=len(renewal.lines), renewed_at=self._now(), next_renew_at=self._next_renewal())
        text = netscape_text(renewal.lines)
        entry.updated_at = await self.accounts.put_secret(user_id, KIND, text.encode(), meta)
        entry.mtime = await asyncio.to_thread(self._write, path, text)
        entry.meta, entry.lines, entry.synced_at = meta, renewal.lines, self._clock()
        log.info("renewed a person's YouTube cookies (YouTube refreshed %s)", ", ".join(renewal.refreshed) or "none")
        return renewal.refreshed

    def _next_renewal(self) -> float:
        return self._now() + RENEW_EVERY + self._jitter(-RENEW_JITTER, RENEW_JITTER)

    async def renew_due(self) -> int:
        """Renew everyone's cookies that are due; how many were renewed."""
        due = []
        for stored in await self.accounts.store.call("secrets.ofKind", kind=KIND) or []:
            meta = stored.get("meta") or {}
            if meta.get("renew_error") == "session_ended":
                continue
            next_at = meta.get("next_renew_at") or (meta.get("renewed_at") or meta.get("uploaded_at") or 0) + RENEW_EVERY
            if self._now() >= max(next_at, self._retry_at.get(stored["userId"], 0)):
                due.append(stored)
        renewed = 0
        for i, stored in enumerate(due):
            if i:
                await asyncio.sleep(self._jitter(*RENEW_SPACING))
            user_id = stored["userId"]
            entry = await self._entry_from(user_id, stored)
            if entry is None:
                continue
            async with self._lock(user_id):
                try:
                    await self._renew(user_id, entry)
                    renewed += 1
                except SessionEnded:
                    pass
                except RenewFailed as exc:
                    self._retry_at[user_id] = self._now() + RENEW_RETRY
                    log.warning("couldn't renew a person's YouTube cookies: %s", exc)
        return renewed

    async def run(self) -> None:
        """Background renewal, for as long as the app runs."""
        while True:
            await asyncio.sleep(RENEW_CHECK)
            try:
                await self.renew_due()
            except Exception as exc:  # noqa: BLE001 - Convex may be down; try at the next check
                log.warning("couldn't check for YouTube cookies to renew: %s", type(exc).__name__)

"""Who a request is from, and what's theirs.

A request is from a person when it carries a valid Clerk session token for someone on the
allowlist, or the cookie of a device they paired. Lookups are cached for a minute, so a
removal from the allowlist or a revoked device takes effect within that time (at once on
this server when done through it). The person is available to the rest of the request
through :func:`current_user`.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import json
import logging
import time
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from ..config import Settings
from ..errors import AppError
from .clerk import ClerkApi, ClerkVerifier, Profile
from .convex import AccountStore
from .crypto import Sealer

log = logging.getLogger(__name__)

USER_TTL = 60
PROFILE_TTL = 600
SEEN_EVERY = 5 * 60


@dataclass(frozen=True)
class User:
    id: str  # the Convex document id
    clerk_id: str
    email: str
    name: str | None
    image_url: str | None
    apps: frozenset[str]
    # kind -> {"meta": ..., "updatedAt": ms} for each stored secret ("plex", "youtube_cookies").
    secrets: dict[str, dict[str, Any]] = field(default_factory=dict)
    admin: bool = False
    via: str = "clerk"  # "clerk" (a Clerk session) or "device" (a paired device's cookie)
    device_id: str | None = None
    device_name: str | None = None

    def secret_meta(self, kind: str) -> dict[str, Any] | None:
        entry = self.secrets.get(kind)
        return entry.get("meta") if entry else None

    def view(self) -> dict[str, Any]:
        return {"email": self.email, "name": self.name, "image_url": self.image_url, "admin": self.admin,
                "via": self.via, "device": self.device_name}


def user_from(view: dict[str, Any], *, admin: bool, via: str = "clerk", device: dict[str, Any] | None = None) -> User:
    return User(id=view["id"], clerk_id=view["clerkId"], email=view["email"], name=view.get("name"),
                image_url=view.get("imageUrl"), apps=frozenset(view.get("apps") or ()),
                secrets=dict(view.get("secrets") or {}), admin=admin, via=via,
                device_id=device["id"] if device else None, device_name=device["name"] if device else None)


_current: ContextVar[User | None] = ContextVar("ytc_user", default=None)


def use_user(user: User | None) -> object:
    return _current.set(user)


def reset_user(token: object) -> None:
    _current.reset(token)  # type: ignore[arg-type]


def current_user() -> User | None:
    return _current.get()


def require_user() -> User:
    user = _current.get()
    if user is None:
        raise AppError("auth_required", "Sign in to use yt-canvas.", status=401)
    return user


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class NotInvited(Exception):
    def __init__(self, email: str) -> None:
        super().__init__(email)
        self.email = email


class Accounts:
    def __init__(self, settings: Settings, store: AccountStore, verifier: ClerkVerifier, clerk: ClerkApi,
                 clock: Callable[[], float] = time.monotonic) -> None:
        assert settings.secrets_key is not None
        self.settings = settings
        self.store = store
        self.verifier = verifier
        self.clerk = clerk
        self.sealer = Sealer(settings.secrets_key)
        self.admins = frozenset(settings.admin_emails)
        self._clock = clock
        # Clerk user id -> (expires, user, or the email of someone not on the allowlist)
        self._sessions: dict[str, tuple[float, User | str]] = {}
        self._devices: dict[str, tuple[float, User | str | None]] = {}  # device token hash -> ...
        self._profiles: dict[str, tuple[float, Profile]] = {}
        self._seen: dict[str, float] = {}
        self._tasks: set[asyncio.Task[Any]] = set()

    async def ensure_admins(self) -> None:
        """Admins (YTC_ADMIN_EMAILS) are always on the allowlist, so the Clerk webhook lets them sign up."""
        if self.admins:
            await self.store.call("allowlist.add", emails=sorted(self.admins), addedBy="YTC_ADMIN_EMAILS")

    # -- who is this? ---------------------------------------------------------------------

    async def from_session(self, token: str, host: str | None) -> User:
        """The person a Clerk session token belongs to. Raises InvalidSession or NotInvited."""
        claims = await self.verifier.verify(token, host=host, allowed_origins=self.settings.allowed_origins)
        clerk_id = str(claims["sub"])
        cached = self._sessions.get(clerk_id)
        if cached is None or self._clock() >= cached[0]:
            cached = (self._clock() + USER_TTL, await self._resolve(clerk_id, claims))
            self._sessions[clerk_id] = cached
        if isinstance(cached[1], str):
            raise NotInvited(cached[1])
        return cached[1]

    async def _profile(self, clerk_id: str, claims: dict[str, Any]) -> Profile:
        # A session token customized in Clerk's dashboard can carry the email; else ask Clerk.
        if isinstance(claims.get("email"), str) and claims["email"]:
            return Profile(email=claims["email"].strip().lower(), name=claims.get("name"), image_url=None)
        cached = self._profiles.get(clerk_id)
        if cached is not None and self._clock() < cached[0]:
            return cached[1]
        profile = await self.clerk.profile(clerk_id)
        if profile is None:
            raise AppError("accounts_unavailable", "Couldn't read your account from Clerk.", status=503,
                           hint="Try again in a moment.", retryable=True)
        self._profiles[clerk_id] = (self._clock() + PROFILE_TTL, profile)
        return profile

    async def _resolve(self, clerk_id: str, claims: dict[str, Any]) -> User | str:
        profile = await self._profile(clerk_id, claims)
        admin = profile.email in self.admins
        result = await self.store.call("users.resolve", clerkId=clerk_id, email=profile.email,
                                       **({"name": profile.name} if profile.name else {}),
                                       **({"imageUrl": profile.image_url} if profile.image_url else {}),
                                       admin=admin)
        if not result or not result.get("allowed"):
            log.info("signed in but not on the allowlist")
            return profile.email
        return user_from(result["user"], admin=admin)

    async def from_device(self, token: str) -> User | None:
        """The owner of a paired device's cookie; None if the device isn't paired (any more)."""
        digest = token_hash(token)
        cached = self._devices.get(digest)
        if cached is None or self._clock() >= cached[0]:
            found = await self.store.call("devices.byHash", tokenHash=digest)
            value: User | str | None
            if not found:
                value = None
            elif not found.get("allowed") and found["user"]["email"] not in self.admins:
                value = found["user"]["email"]
            else:
                value = user_from(found["user"], admin=found["user"]["email"] in self.admins, via="device",
                                  device=found["device"])
            cached = (self._clock() + USER_TTL, value)
            self._devices[digest] = cached
        value = cached[1]
        if isinstance(value, str):
            raise NotInvited(value)
        if value is not None and value.device_id and self._clock() - self._seen.get(value.device_id, -SEEN_EVERY) >= SEEN_EVERY:
            self._seen[value.device_id] = self._clock()
            self._background(self.store.call("devices.touch", deviceId=value.device_id))
        return value

    def _background(self, coro: Any) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(lambda t: t.cancelled() or t.exception())

    # -- keeping the caches current ------------------------------------------------------------

    def _replace(self, user_id: str, **changes: Any) -> None:
        for cache in (self._sessions, self._devices):
            for key, (expires, value) in list(cache.items()):
                if isinstance(value, User) and value.id == user_id:
                    cache[key] = (expires, dataclasses.replace(value, **changes))

    def forget_device(self, digest: str) -> None:
        self._devices.pop(digest, None)

    def forget_all(self) -> None:
        """After an allowlist change: look everyone up again."""
        self._sessions.clear()
        self._devices.clear()

    def latest(self, user: User) -> User:
        """``user`` as currently cached (it may have changed during this request)."""
        for cache in (self._sessions, self._devices):
            for _, value in cache.values():
                if isinstance(value, User) and value.id == user.id:
                    return dataclasses.replace(value, via=user.via, device_id=user.device_id,
                                               device_name=user.device_name)
        return user

    # -- what's theirs ---------------------------------------------------------------------------

    async def set_apps(self, user: User, apps: set[str]) -> User:
        await self.store.call("users.setApps", userId=user.id, apps=sorted(apps))
        self._replace(user.id, apps=frozenset(apps))
        return dataclasses.replace(user, apps=frozenset(apps))

    async def secret(self, user_id: str, kind: str) -> bytes | None:
        stored = await self.store.call("secrets.get", userId=user_id, kind=kind)
        if not stored:
            return None
        plaintext = self.sealer.open(stored["ciphertext"], f"{user_id}:{kind}")
        if plaintext is None:
            log.warning("a stored %s secret can't be decrypted (was YTC_SECRETS_KEY changed?)", kind)
        return plaintext

    async def secret_json(self, user_id: str, kind: str) -> dict[str, Any] | None:
        raw = await self.secret(user_id, kind)
        if raw is None:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    async def put_secret(self, user_id: str, kind: str, plaintext: bytes, meta: dict[str, Any]) -> int:
        updated_at = await self.store.call("secrets.put", userId=user_id, kind=kind,
                                           ciphertext=self.sealer.seal(plaintext, f"{user_id}:{kind}"), meta=meta)
        self._update_secret(user_id, kind, {"meta": meta, "updatedAt": updated_at})
        return updated_at

    async def delete_secret(self, user_id: str, kind: str) -> None:
        await self.store.call("secrets.delete", userId=user_id, kind=kind)
        self._update_secret(user_id, kind, None)

    def _update_secret(self, user_id: str, kind: str, entry: dict[str, Any] | None) -> None:
        for cache in (self._sessions, self._devices):
            for key, (expires, value) in list(cache.items()):
                if isinstance(value, User) and value.id == user_id:
                    secrets = {k: v for k, v in value.secrets.items() if k != kind}
                    if entry is not None:
                        secrets[kind] = entry
                    cache[key] = (expires, dataclasses.replace(value, secrets=secrets))

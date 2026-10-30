"""Clerk: verifying session tokens, and reading a user's profile.

The frontend's Clerk SDK keeps a short-lived (60 s) session token in the ``__session``
cookie on our origin and refreshes it; API calls also send it as ``Authorization: Bearer``.
A token is accepted when its RS256 signature matches Clerk's keys (``CLERK_JWT_KEY``, or the
instance's JWKS, fetched and cached), it was issued by this Clerk instance, it hasn't
expired, and its ``azp`` (the page that asked for it) is an allowed origin.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit

import jwt

log = logging.getLogger(__name__)

LEEWAY = 5  # seconds of clock skew allowed
JWKS_TTL = 3600
JWKS_RETRY = 30  # at most one refetch this often when a token names an unknown key
TIMEOUT = 10


class InvalidSession(Exception):
    """The token isn't a valid session of this Clerk instance (the message says why, for logs)."""


def frontend_api(publishable_key: str) -> str:
    """The instance's Frontend API host, which a publishable key encodes: ``pk_test_<b64(host$)>``."""
    parts = publishable_key.split("_", 2)
    if len(parts) != 3 or parts[0] != "pk":
        raise ValueError("The Clerk publishable key must look like pk_test_... or pk_live_...")
    encoded = parts[2]
    try:
        host = base64.b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
    except ValueError as exc:
        raise ValueError("The Clerk publishable key can't be decoded.") from exc
    host = host.rstrip("$")
    if not host or "/" in host:
        raise ValueError("The Clerk publishable key can't be decoded.")
    return host


def _get_json(url: str, headers: dict[str, str]) -> tuple[int, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310 - fixed https URLs
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, None


class ClerkVerifier:
    def __init__(self, publishable_key: str, *, jwt_key: str | None = None,
                 fetch: Callable[[str], Any] | None = None, clock: Callable[[], float] = time.time) -> None:
        self.frontend_api = frontend_api(publishable_key)
        self.issuer = f"https://{self.frontend_api}"
        self.jwks_url = f"{self.issuer}/.well-known/jwks.json"
        self._static_key = jwt.PyJWK.from_dict(_pem_to_jwk(jwt_key)).key if jwt_key else None
        self._fetch = fetch or (lambda url: _get_json(url, {})[1])
        self._clock = clock
        self._keys: dict[str, Any] = {}
        self._fetched_at = 0.0
        self._lock = asyncio.Lock()

    async def _key(self, kid: str | None) -> Any:
        if self._static_key is not None:
            return self._static_key

        def needs_fetch() -> bool:
            age = self._clock() - self._fetched_at
            return age >= JWKS_TTL or (kid not in self._keys and age >= JWKS_RETRY)

        if needs_fetch():
            async with self._lock:
                if needs_fetch():
                    await self._refresh()
        key = self._keys.get(kid or "")
        if key is None:
            raise InvalidSession("unknown signing key")
        return key

    async def _refresh(self) -> None:
        try:
            data = await asyncio.to_thread(self._fetch, self.jwks_url)
            keys = jwt.PyJWKSet.from_dict(data).keys
        except Exception as exc:  # noqa: BLE001 - keep the old keys and try again later
            log.warning("couldn't fetch Clerk's signing keys: %s", type(exc).__name__)
            self._fetched_at = self._clock() - JWKS_TTL + JWKS_RETRY
            return
        self._keys = {key.key_id: key.key for key in keys if key.key_id}
        self._fetched_at = self._clock()

    async def verify(self, token: str, *, host: str | None, allowed_origins: tuple[str, ...] = ()) -> dict[str, Any]:
        """The token's claims; raises :class:`InvalidSession`.

        ``host`` is the request's Host header: without ``allowed_origins``, a token is only
        accepted from pages on the same host it is presented to.
        """
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise InvalidSession("malformed") from exc
        if header.get("alg") != "RS256":
            raise InvalidSession("unexpected algorithm")
        key = await self._key(header.get("kid"))
        try:
            claims = jwt.decode(token, key, algorithms=["RS256"], issuer=self.issuer, leeway=LEEWAY,
                                options={"require": ["exp", "iat", "iss", "sub"], "verify_aud": False})
        except jwt.ExpiredSignatureError as exc:
            raise InvalidSession("expired") from exc
        except jwt.PyJWTError as exc:
            raise InvalidSession(type(exc).__name__) from exc
        azp = claims.get("azp")
        if azp:
            if allowed_origins:
                ok = azp.rstrip("/") in allowed_origins
            else:
                ok = bool(host) and urlsplit(azp).netloc.lower() == (host or "").lower()
            if not ok:
                raise InvalidSession("token from another origin")
        return claims


def _pem_to_jwk(pem: str) -> dict[str, Any]:
    from cryptography.hazmat.primitives import serialization

    public = serialization.load_pem_public_key(pem.replace("\\n", "\n").encode())
    return json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(public))


@dataclass(frozen=True)
class Profile:
    email: str
    name: str | None
    image_url: str | None


def profile_from(user: dict[str, Any]) -> Profile | None:
    emails = user.get("email_addresses") or []
    primary = next((e for e in emails if e.get("id") == user.get("primary_email_address_id")), None)
    email = (primary or (emails[0] if emails else {})).get("email_address")
    if not email:
        return None
    name = " ".join(part for part in (user.get("first_name"), user.get("last_name")) if part) or None
    return Profile(email=email.strip().lower(), name=name, image_url=user.get("image_url"))


class ClerkApi:
    """Clerk's Backend API, with the secret key; only to read a user's email and name."""

    def __init__(self, secret_key: str, api_url: str = "https://api.clerk.com") -> None:
        self._secret = secret_key
        self._api = api_url.rstrip("/")

    async def profile(self, clerk_id: str) -> Profile | None:
        url = f"{self._api}/v1/users/{quote(clerk_id, safe='')}"
        try:
            status, data = await asyncio.to_thread(_get_json, url, {"Authorization": f"Bearer {self._secret}"})
        except (OSError, TimeoutError, ValueError) as exc:
            log.warning("couldn't read a Clerk profile: %s", type(exc).__name__)
            return None
        if status != 200 or not isinstance(data, dict):
            log.warning("Clerk's Backend API answered %d for a profile", status)
            return None
        return profile_from(data)

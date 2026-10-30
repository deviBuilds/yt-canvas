"""Paired devices: other devices (a phone, a car) allowed to use private data through a tunnel.

While the server holds private data (YouTube sign-in, a connected Plex), the API answers
only this computer, unless the request carries the cookie of a paired device.

Pairing: the device asks for a pairing request and shows its 6-digit code; someone on this
computer types the code in (``/devices``); the device's next check then receives a
long-lived HttpOnly cookie. Only a hash of each device's token is stored, in
``<config dir>/devices.json`` (mode 0600). The file is shared, so a request made through
one server process (the tunnel's) can be approved on another (the dev server's).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import time
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

DEVICE_COOKIE = "ytc_device"
REQUEST_COOKIE = "ytc_pairing"
DEVICE_MAX_AGE = 400 * 24 * 3600  # browsers cap cookie lifetimes at 400 days
REQUEST_TTL = 10 * 60
MAX_PENDING = 20
SEEN_EVERY = 5 * 60


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def cookie_value(cookie_header: str | None, name: str) -> str | None:
    if not cookie_header:
        return None
    jar = SimpleCookie()
    try:
        jar.load(cookie_header)
    except Exception:  # malformed cookies are simply not ours
        return None
    morsel = jar.get(name)
    return morsel.value if morsel else None


def device_name(user_agent: str | None) -> str:
    agent = user_agent or ""
    if "Tesla" in agent:
        return "Tesla"
    browser = next((name for key, name in (("Edg/", "Edge"), ("Chrome/", "Chrome"), ("Firefox/", "Firefox"),
                                           ("Safari/", "Safari")) if key in agent), "Browser")
    system = next((name for key, name in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"),
                                          ("Mac OS X", "Mac"), ("Windows", "Windows"), ("Linux", "Linux")) if key in agent), "")
    return f"{browser} on {system}" if system else browser


class DeviceStore:
    def __init__(self, directory: Path) -> None:
        self._path = directory / "devices.json"
        self._data: dict[str, Any] = {"devices": [], "requests": []}
        self._mtime: float | None = None

    # -- the file, re-read whenever another process changed it ---------------------

    def _load(self) -> dict[str, Any]:
        try:
            mtime = self._path.stat().st_mtime
        except FileNotFoundError:
            self._data, self._mtime = {"devices": [], "requests": []}, None
            return self._data
        if mtime != self._mtime:
            try:
                data = json.loads(self._path.read_text("utf-8"))
                self._data = {"devices": list(data.get("devices", [])), "requests": list(data.get("requests", []))}
            except (OSError, ValueError, AttributeError) as exc:
                log.warning("ignoring unreadable %s (%s)", self._path, exc)
                self._data = {"devices": [], "requests": []}
            self._mtime = mtime
        return self._data

    def _save(self) -> None:
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = self._path.with_name(f"devices.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(self._data, handle, indent=2)
        os.replace(tmp, self._path)
        self._mtime = self._path.stat().st_mtime

    def _live_requests(self) -> list[dict[str, Any]]:
        now = time.time()
        return [r for r in self._load()["requests"] if now - r["created"] < REQUEST_TTL]

    # -- pairing --------------------------------------------------------------------

    def create_request(self, name: str) -> tuple[dict[str, Any], str]:
        """A new pairing request: its public view, and the secret only the asking device gets."""
        secret = secrets.token_urlsafe(32)
        pending = self._live_requests()
        codes = {r["code"] for r in pending}
        code = f"{secrets.randbelow(10**6):06d}"
        while code in codes:
            code = f"{secrets.randbelow(10**6):06d}"
        request = {"id": secrets.token_hex(8), "code": code, "name": name[:60], "created": time.time(),
                   "secret": _hash(secret), "approved": False}
        self._data["requests"] = (pending + [request])[-MAX_PENDING:]
        self._save()
        return self._request_view(request), secret

    @staticmethod
    def _request_view(request: dict[str, Any]) -> dict[str, Any]:
        return {"id": request["id"], "code": request["code"], "name": request["name"],
                "expires_at": request["created"] + REQUEST_TTL, "approved": request["approved"]}

    def approve(self, code: str) -> dict[str, Any] | None:
        for request in self._live_requests():
            if secrets.compare_digest(request["code"], code.strip()) and not request["approved"]:
                request["approved"] = True
                self._data["requests"] = self._live_requests()
                self._save()
                log.info("approved pairing for %s", request["name"])
                return self._request_view(request)
        return None

    def collect(self, request_id: str, secret: str | None) -> tuple[str, str | None]:
        """("waiting" | "paired" | "expired", the new device token when just paired)."""
        request = next((r for r in self._live_requests() if r["id"] == request_id), None)
        if request is None or not secret or not secrets.compare_digest(request["secret"], _hash(secret)):
            return "expired", None
        if not request["approved"]:
            return "waiting", None
        token = secrets.token_urlsafe(32)
        now = time.time()
        self._data["devices"].append({"id": secrets.token_hex(6), "name": request["name"], "hash": _hash(token),
                                      "created": now, "last_seen": now})
        self._data["requests"] = [r for r in self._live_requests() if r["id"] != request_id]
        self._save()
        log.info("paired %s", request["name"])
        return "paired", token

    # -- paired devices -----------------------------------------------------------

    def device_for(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        digest = _hash(token)
        device = next((d for d in self._load()["devices"] if secrets.compare_digest(d["hash"], digest)), None)
        if device and time.time() - device.get("last_seen", 0) > SEEN_EVERY:
            device["last_seen"] = time.time()
            self._save()
        return device

    def listing(self) -> dict[str, Any]:
        data = self._load()
        return {
            "devices": [{k: d[k] for k in ("id", "name", "created", "last_seen")} for d in data["devices"]],
            "requests": [self._request_view(r) for r in self._live_requests() if not r["approved"]],
        }

    def revoke(self, device_id: str) -> bool:
        devices = self._load()["devices"]
        kept = [d for d in devices if d["id"] != device_id]
        if len(kept) == len(devices):
            return False
        self._data["devices"] = kept
        self._save()
        log.info("revoked device %s", device_id)
        return True

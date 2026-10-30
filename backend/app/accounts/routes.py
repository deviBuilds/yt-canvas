"""Account routes.

- ``GET /api/auth/config``: whether accounts are on, and Clerk's publishable key (open to all).
- ``GET /api/auth/me``: who is signed in.
- ``PUT``/``DELETE /api/me/cookies``: upload or remove your YouTube cookies.txt.
- ``/api/library``: your favorites, history (positions, for continue watching) and searches.
- ``/api/admin/allowlist``: who may sign in (admins only).

Apart from the config, these answer 404 in no-login mode, where the browser keeps the
library itself.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..errors import AppError
from .clerk import frontend_api
from .users import Accounts, User, require_user
from .youtube import UserYouTube

router = APIRouter(prefix="/api")

LIBRARY_LIMITS = {"favorites": 200, "history": 100, "searches": 12}
MAX_ENTRY_BYTES = 16 * 1024


def _accounts(request: Request) -> Accounts:
    accounts = request.app.state.accounts
    if accounts is None:
        raise AppError("not_found", "Accounts are off on this server.", status=404)
    return accounts


def _youtube(request: Request) -> UserYouTube:
    _accounts(request)
    return request.app.state.user_youtube


def _me(request: Request) -> User:
    return _accounts(request).latest(require_user())


@router.get("/auth/config")
async def auth_config(request: Request) -> dict:
    settings = request.app.state.settings
    if not settings.accounts_enabled:
        return {"accounts": False}
    return {"accounts": True, "clerk_publishable_key": settings.clerk_publishable_key,
            "clerk_frontend_api": frontend_api(settings.clerk_publishable_key)}


@router.get("/auth/me")
async def auth_me(request: Request) -> dict:
    return _me(request).view()


# -- YouTube cookies ---------------------------------------------------------------------------


@router.put("/me/cookies")
async def upload_cookies(request: Request) -> dict:
    """The body is a cookies.txt, a JSON cookie export or a Cookie header; only youtube.com cookies are kept."""
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > 2 * 1024 * 1024:
            raise AppError("invalid_input", "That file is too large for a cookies.txt.", status=413)
    meta = await _youtube(request).upload(_me(request), bytes(body))
    return {"ok": True, "count": meta["count"], "uploaded_at": meta["uploaded_at"], "format": meta["format"]}


@router.delete("/me/cookies")
async def delete_cookies(request: Request) -> dict:
    await _youtube(request).remove(_me(request))
    return {"ok": True}


# -- library -----------------------------------------------------------------------------------


ListName = Literal["favorites", "history", "searches"]


class LibraryEntry(BaseModel):
    key: str = Field(..., min_length=1, max_length=300)
    data: dict[str, Any]
    updatedAt: float = Field(..., ge=0)  # noqa: N815 - the frontend's and Convex's spelling


class LibraryPut(BaseModel):
    entries: list[LibraryEntry] = Field(..., max_length=200)


@router.get("/library")
async def library(request: Request) -> dict:
    return await _accounts(request).store.call("library.get", userId=_me(request).id)


@router.put("/library/{name}")
async def library_put(request: Request, name: ListName, body: LibraryPut) -> dict:
    entries = body.entries[: LIBRARY_LIMITS[name]]
    for entry in entries:
        if len(json.dumps(entry.data)) > MAX_ENTRY_BYTES:
            raise AppError("invalid_input", "A library entry is too large.", status=413)
    await _accounts(request).store.call("library.put", userId=_me(request).id, list=name,
                                        entries=[entry.model_dump() for entry in entries])
    return {"ok": True}


@router.delete("/library/{name}/{key:path}")
async def library_remove(request: Request, name: ListName, key: str) -> dict:
    await _accounts(request).store.call("library.remove", userId=_me(request).id, list=name, key=key)
    return {"ok": True}


@router.delete("/library/{name}")
async def library_clear(request: Request, name: ListName) -> dict:
    await _accounts(request).store.call("library.clear", userId=_me(request).id, list=name)
    return {"ok": True}


# -- allowlist (admins) -----------------------------------------------------------------------


class AllowlistAdd(BaseModel):
    emails: list[str] = Field(..., min_length=1, max_length=100)


def _admin(request: Request) -> tuple[Accounts, User]:
    accounts = _accounts(request)
    user = _me(request)
    if not user.admin:
        raise AppError("forbidden", "Only admins can change who may sign in.", status=403)
    return accounts, user


def _email(raw: str) -> str:
    email = raw.strip().lower()
    local, _, domain = email.partition("@")
    if not local or "." not in domain or len(email) > 254 or any(c.isspace() for c in email):
        raise AppError("invalid_input", f"{raw.strip()!r} isn't an email address.")
    return email


@router.get("/admin/allowlist")
async def allowlist(request: Request) -> dict:
    accounts, _ = _admin(request)
    entries = await accounts.store.call("allowlist.list") or []
    return {"entries": [{**entry, "admin": entry["email"] in accounts.admins} for entry in entries]}


@router.post("/admin/allowlist")
async def allowlist_add(request: Request, body: AllowlistAdd) -> dict:
    accounts, user = _admin(request)
    emails = [_email(raw) for raw in body.emails]
    added = await accounts.store.call("allowlist.add", emails=emails, addedBy=user.email)
    accounts.forget_all()
    return {"added": added}


@router.delete("/admin/allowlist/{email}")
async def allowlist_remove(request: Request, email: str) -> dict:
    accounts, _ = _admin(request)
    email = _email(email)
    if email in accounts.admins:
        raise AppError("invalid_input", "Admins (YTC_ADMIN_EMAILS) are always allowed.",
                       hint="Change YTC_ADMIN_EMAILS on the server to remove one.")
    if not await accounts.store.call("allowlist.remove", email=email):
        raise AppError("not_found", "That email isn't on the list.", status=404)
    accounts.forget_all()
    return {"ok": True}

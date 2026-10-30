"""Pairing routes, under /api/pairing/ (always reachable, so an unpaired device can ask).

No-login mode: devices are approved on this computer and kept in ``devices.json``. With
accounts on: anyone signed in approves a code for their own account (``accounts/pairing.py``),
and lists and revokes their own devices from any of their devices.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .devices import (
    DEVICE_COOKIE,
    DEVICE_MAX_AGE,
    REQUEST_COOKIE,
    REQUEST_TTL,
    DeviceStore,
    cookie_value,
    device_name,
)
from .accounts.pairing import AccountPairing
from .accounts.users import current_user, require_user
from .errors import AppError
from .localnet import is_local_request

router = APIRouter(prefix="/api/pairing")


class PairingStatus(BaseModel):
    # This computer: never needs pairing.
    local: bool
    paired: bool
    # Whether the server holds private data, so other devices need pairing.
    required: bool
    device: str | None = None
    # Accounts are on: devices are paired to the account that approves them.
    accounts: bool = False


class NewRequest(BaseModel):
    name: str | None = Field(None, max_length=60)


class Approval(BaseModel):
    code: str = Field(..., min_length=6, max_length=6, pattern=r"^\d{6}$")


def _store(request: Request) -> DeviceStore:
    return request.app.state.devices


def _accounts(request: Request) -> AccountPairing | None:
    return request.app.state.account_pairing


def _local_only(request: Request) -> None:
    if not is_local_request(request):
        raise AppError("forbidden", "Pairing is approved on the computer running yt-canvas.", status=403,
                       hint="Open the Devices page there (http://localhost:...) and enter the code.")


@router.get("/status", response_model=PairingStatus)
async def status(request: Request) -> PairingStatus:
    if _accounts(request) is not None:
        user = current_user()
        return PairingStatus(local=False, paired=bool(user and user.via == "device"), required=True,
                             device=user.device_name if user else None, accounts=True)
    device = _store(request).device_for(cookie_value(request.headers.get("cookie"), DEVICE_COOKIE))
    return PairingStatus(local=is_local_request(request), paired=device is not None,
                         required=request.app.state.private_data() is not None,
                         device=device["name"] if device else None)


@router.post("/requests")
async def create_request(request: Request, response: Response, body: NewRequest) -> dict:
    """Start pairing this device: show the code, then poll the request."""
    name = body.name or device_name(request.headers.get("user-agent"))
    pairing = _accounts(request)
    view, secret = pairing.create_request(name) if pairing is not None else _store(request).create_request(name)
    response.set_cookie(REQUEST_COOKIE, secret, max_age=REQUEST_TTL, httponly=True, secure=True, samesite="strict",
                        path="/api/pairing")
    return view


@router.get("/requests/{request_id}")
async def check_request(request: Request, response: Response, request_id: str) -> dict:
    secret = cookie_value(request.headers.get("cookie"), REQUEST_COOKIE)
    pairing = _accounts(request)
    state, token = (await pairing.collect(request_id, secret) if pairing is not None
                    else _store(request).collect(request_id, secret))
    if token:
        response.set_cookie(DEVICE_COOKIE, token, max_age=DEVICE_MAX_AGE, httponly=True, secure=True, samesite="strict",
                            path="/")
        response.delete_cookie(REQUEST_COOKIE, path="/api/pairing")
    return {"state": state}


@router.post("/approve")
async def approve(request: Request, body: Approval) -> dict:
    pairing = _accounts(request)
    if pairing is not None:
        user = require_user()
        if user.via != "clerk":
            raise AppError("forbidden", "Approve new devices from a device where you signed in.", status=403,
                           hint="A paired device can't pair others.")
        approved = pairing.approve(body.code, user)
    else:
        _local_only(request)
        approved = _store(request).approve(body.code)
    if approved is None:
        raise AppError("not_found", "No device is waiting with that code.", status=404,
                       hint="Check the code on the device; codes last 10 minutes.")
    return approved


@router.get("/devices")
async def devices(request: Request) -> dict:
    pairing = _accounts(request)
    if pairing is not None:
        user = require_user()
        return {"devices": await pairing.devices(user), "requests": [], "current": user.device_id}
    _local_only(request)
    return _store(request).listing()


@router.delete("/devices/{device_id}")
async def revoke(request: Request, device_id: str) -> dict:
    pairing = _accounts(request)
    if pairing is not None:
        found = await pairing.revoke(require_user(), device_id)
    else:
        _local_only(request)
        found = _store(request).revoke(device_id)
    if not found:
        raise AppError("not_found", "No such device.", status=404)
    return {"ok": True}


@router.post("/forget")
async def forget(request: Request, response: Response) -> dict:
    """This paired device signs itself out: it's removed from the account and loses its cookie."""
    pairing = _accounts(request)
    user = current_user()
    if pairing is not None and user is not None and user.via == "device" and user.device_id:
        await pairing.revoke(user, user.device_id)
    response.delete_cookie(DEVICE_COOKIE, path="/")
    return {"ok": True}

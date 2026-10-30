"""The Plex app's routes, under /api/apps/plex/ (404 app_disabled while the app is off)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field

from .library import PlexDetails, PlexHome, PlexItem, PlexLibrary, PlexLibraryService, PlexPage
from .playback import PlayRequest, PlayResponse, PlexPlayback
from .service import PlexServerView, PlexService, PlexStatus, SignIn, SignInState


class ServerChoice(BaseModel):
    id: str


class Timeline(BaseModel):
    key: str
    state: Literal["playing", "paused", "stopped", "buffering"]
    time: float = Field(ge=0)
    duration: float | None = None
    session: str | None = None


def plex_router(plex: PlexService, library: PlexLibraryService, playback: PlexPlayback) -> APIRouter:
    router = APIRouter()

    @router.get("/status", response_model=PlexStatus)
    async def status() -> PlexStatus:
        return plex.status()

    @router.post("/signin", response_model=SignIn)
    async def start_signin() -> SignIn:
        """Start Plex's PIN sign-in: open ``auth_url``, approve, then poll the PIN."""
        return await plex.start_signin()

    @router.get("/signin/{pin_id}", response_model=SignInState)
    async def check_signin(pin_id: int) -> SignInState:
        return await plex.check_signin(pin_id)

    @router.delete("/signin", response_model=PlexStatus)
    async def disconnect() -> PlexStatus:
        await playback.stop_all()
        plex.disconnect()
        return plex.status()

    @router.get("/servers", response_model=list[PlexServerView])
    async def servers() -> list[PlexServerView]:
        return await plex.servers()

    @router.put("/server", response_model=PlexStatus)
    async def choose_server(body: ServerChoice) -> PlexStatus:
        await playback.stop_all()
        return await plex.connect_server(body.id)

    @router.get("/home", response_model=PlexHome)
    async def home() -> PlexHome:
        return await library.home()

    @router.get("/libraries", response_model=list[PlexLibrary])
    async def libraries() -> list[PlexLibrary]:
        return await library.libraries()

    @router.get("/libraries/{key}/items", response_model=PlexPage)
    async def library_items(key: str, offset: int = Query(0, ge=0), limit: int = Query(60, ge=1, le=200),
                            sort: Literal["title", "added", "year"] = "title") -> PlexPage:
        return await library.library_items(key, offset, limit, sort)

    @router.get("/items/{key}", response_model=PlexDetails)
    async def item(key: str) -> PlexDetails:
        return await library.details(key)

    @router.get("/search", response_model=list[PlexItem])
    async def search(q: str = Query(..., min_length=1, max_length=200)) -> list[PlexItem]:
        return await library.search(q)

    @router.get("/image")
    async def image(path: str, w: int = Query(300, ge=16, le=1920), h: int = Query(450, ge=16, le=1920)) -> Response:
        body, content_type = await library.image(path, w, h)
        return Response(body, media_type=content_type, headers={"Cache-Control": "private, max-age=3600"})

    @router.post("/play", response_model=PlayResponse)
    async def play(body: PlayRequest) -> PlayResponse:
        return await playback.play(body)

    @router.get("/sessions/{session_id}/file")
    async def file(request: Request, session_id: str) -> Response:
        """Bytes of the original file, as asked for in Range (at most 16 MiB)."""
        upstream = await playback.file_range(session_id, request.headers.get("range"))
        headers = {"Cache-Control": "no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff"}
        if upstream.header("Content-Range"):
            headers["Content-Range"] = upstream.header("Content-Range") or ""
        return Response(upstream.body, status_code=upstream.status, headers=headers,
                        media_type=upstream.header("Content-Type") or "application/octet-stream")

    @router.get("/sessions/{session_id}/dash/{path:path}")
    async def dash(request: Request, session_id: str, path: str) -> Response:
        body, content_type = await playback.dash(session_id, path, request.url.query)
        return Response(body, media_type=content_type, headers={"Cache-Control": "no-store"})

    @router.post("/sessions/{session_id}/ping")
    async def ping(session_id: str) -> dict:
        await playback.ping(session_id)
        return {"ok": True}

    @router.delete("/sessions/{session_id}")
    async def stop(session_id: str) -> dict:
        await playback.stop(session_id)
        return {"ok": True}

    @router.post("/timeline")
    async def timeline(body: Timeline) -> dict:
        await playback.timeline(body.key, body.state, body.time, body.duration, body.session)
        return {"ok": True}

    return router

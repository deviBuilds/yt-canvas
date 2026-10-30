"""A fake plex.tv and Plex Media Server for the browser tests (``frontend/e2e/plex.spec.ts``).

Run: ``python -m uvicorn tests.fakeplex:app --port 8797`` from ``backend``. Opening the
approval page (``/auth``) approves the pending sign-in. The library has a movie that plays
directly (H.264 + AAC in Matroska, served in byte ranges) and one with DTS audio that goes
through the "transcoder", which serves a ready-made DASH output.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

FIXTURES = Path(__file__).resolve().parents[2] / "frontend" / "src" / "player" / "engine" / "fixtures"
PORT = int(os.environ.get("FAKE_PLEX_PORT", "8797"))
SELF = f"http://127.0.0.1:{PORT}"
TOKEN = "fake-plex-token"

app = FastAPI()
state = {"approved": False, "bytes": 0, "timeline": []}


def mc(**body) -> JSONResponse:
    return JSONResponse({"MediaContainer": body})


def movie(key: str, title: str, file: str, audio: str) -> dict:
    return {
        "ratingKey": key, "type": "movie", "title": title, "year": 2024, "summary": f"{title}, a test film.",
        "duration": 2000, "thumb": f"/library/metadata/{key}/thumb/1", "art": f"/library/metadata/{key}/art/1",
        "librarySectionTitle": "Movies", "Genre": [{"tag": "Test"}],
        "Media": [{"container": "mkv", "videoCodec": "h264", "audioCodec": audio, "audioChannels": 2, "bitrate": 400,
                   "width": 160, "height": 90, "videoResolution": "sd",
                   "Part": [{"id": int(key), "key": f"/library/parts/{key}/1/{file}", "container": "mkv",
                             "size": (FIXTURES / "mkv" / file).stat().st_size,
                             "Stream": [{"id": 1, "index": 0, "streamType": 1, "codec": "h264"},
                                        {"id": 2, "index": 1, "streamType": 2, "codec": audio, "channels": 2,
                                         "selected": True, "displayTitle": f"English ({audio.upper()})"}]}]}],
    }


MOVIES = {"101": movie("101", "Direct Movie", "h264-aac.mkv", "aac"), "102": movie("102", "Transcoded Movie", "h264-dts.mkv", "dca")}


# -- plex.tv -----------------------------------------------------------------------------

@app.post("/api/v2/pins")
async def create_pin() -> JSONResponse:
    state["approved"] = False
    return JSONResponse({"id": 7, "code": "fakecode", "expiresAt": "2099-01-01T00:00:00Z", "authToken": None}, status_code=201)


@app.get("/api/v2/pins/7")
async def check_pin() -> JSONResponse:
    return JSONResponse({"id": 7, "authToken": TOKEN if state["approved"] else None})


@app.get("/auth")
async def approve() -> HTMLResponse:
    state["approved"] = True
    return HTMLResponse("<!doctype html><title>Plex</title><h1>yt-canvas is approved</h1>")


@app.get("/api/v2/user")
async def user() -> JSONResponse:
    return JSONResponse({"friendlyName": "Tester"})


@app.get("/api/v2/resources")
async def resources() -> JSONResponse:
    return JSONResponse([{"name": "Fake Server", "clientIdentifier": "fake", "provides": "server", "owned": True,
                          "presence": True, "accessToken": TOKEN,
                          "connections": [{"uri": SELF, "local": True, "relay": False, "protocol": "http"}]}])


# -- the media server --------------------------------------------------------------------

@app.get("/identity")
async def identity() -> JSONResponse:
    return mc(machineIdentifier="fake")


@app.get("/library/sections")
async def sections() -> JSONResponse:
    return mc(Directory=[{"key": "1", "title": "Movies", "type": "movie"}])


@app.get("/hubs/home/continueWatching")
async def continue_watching() -> JSONResponse:
    return mc()


@app.get("/library/onDeck")
async def on_deck() -> JSONResponse:
    return mc()


@app.get("/library/sections/1/recentlyAdded")
@app.get("/library/sections/1/all")
async def all_movies() -> JSONResponse:
    return mc(Metadata=list(MOVIES.values()), totalSize=len(MOVIES))


@app.get("/library/metadata/{key}")
async def metadata(key: str) -> Response:
    return mc(Metadata=[MOVIES[key]]) if key in MOVIES else JSONResponse({}, status_code=404)


@app.get("/hubs/search")
async def search(query: str) -> JSONResponse:
    found = [m for m in MOVIES.values() if query.lower() in m["title"].lower()]
    return mc(Hub=[{"type": "movie", "Metadata": found}])


@app.get("/photo/:/transcode")
async def photo() -> Response:
    # A 1x1 grey PNG.
    return Response(bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                                  "1f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"),
                    media_type="image/png")


@app.get("/library/parts/{part}/1/{file}")
async def part(request: Request, part: str, file: str) -> Response:
    response = FileResponse(FIXTURES / "mkv" / file, media_type="video/x-matroska")
    match = re.fullmatch(r"bytes=(\d+)-(\d+)", request.headers.get("range", ""))
    if match:
        state["bytes"] += int(match.group(2)) - int(match.group(1)) + 1
    return response


@app.get("/video/:/transcode/universal/start.mpd")
async def start(session: str, path: str) -> Response:
    manifest = (FIXTURES / "dash" / "number" / "manifest.mpd").read_text()
    manifest = manifest.replace('initialization="init-$RepresentationID$.m4s"', f'initialization="session/{session}/$RepresentationID$/header"')
    manifest = manifest.replace('media="chunk-$RepresentationID$-$Number%05d$.m4s"', f'media="session/{session}/$RepresentationID$/$Number$.m4s"')
    return Response(manifest, media_type="application/dash+xml")


@app.get("/video/:/transcode/universal/session/{session}/{rep}/{name}")
async def segment(session: str, rep: str, name: str) -> Response:
    file = f"init-{rep}.m4s" if name == "header" else f"chunk-{rep}-{int(name.removesuffix('.m4s')):05d}.m4s"
    return FileResponse(FIXTURES / "dash" / "number" / file, media_type="video/mp4")


@app.get("/video/:/transcode/universal/{action}")
async def transcode_control(action: str) -> JSONResponse:
    return JSONResponse({})


@app.get("/:/timeline")
async def timeline(request: Request) -> JSONResponse:
    state["timeline"].append(dict(request.query_params))
    return JSONResponse({})


@app.get("/test/state")
async def test_state() -> JSONResponse:
    """For the browser test: bytes served from files, and the progress reports received."""
    return JSONResponse(state)

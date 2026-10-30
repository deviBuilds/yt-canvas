"""The Plex app against a fake plex.tv and Plex Media Server (no network)."""

from __future__ import annotations

import io
import json
import os
import urllib.error
import urllib.parse

import pytest
from fastapi.testclient import TestClient

from app.apps.plex import client as plex_client
from app.main import create_app

USER_TOKEN = "user-token-secret"
SERVER_TOKEN = "server-token-secret"
LOCAL = "https://10-0-0-5.abc.plex.direct:32400"
REMOTE = "https://203-0-113-7.abc.plex.direct:32400"


class Headers(dict):
    def items(self):  # like http.client.HTTPMessage
        return list(super().items())


class Answer:
    def __init__(self, status: int, body: bytes | str | dict | list, headers: dict | None = None) -> None:
        self.status = status
        self.body = json.dumps(body).encode() if isinstance(body, (dict, list)) else body.encode() if isinstance(body, str) else body
        self.headers = Headers({"Content-Type": "application/json", **(headers or {})})

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def movie(key: str, container: str, video: str, audio: str, **extra) -> dict:
    return {
        "ratingKey": key, "type": "movie", "title": f"Movie {key}", "year": 2001, "summary": "A film.",
        "duration": 5_997_000, "thumb": f"/library/metadata/{key}/thumb/1700000000",
        "art": f"/library/metadata/{key}/art/1700000000", "Genre": [{"tag": "Drama"}], "Role": [{"tag": "Someone"}],
        "Media": [{
            "container": container, "videoCodec": video, "audioCodec": audio, "audioChannels": 6, "bitrate": 7102,
            "width": 1920, "height": 796, "videoResolution": "1080", "videoFrameRate": "24p",
            "Part": [{"id": int(key) * 10, "key": f"/library/parts/{int(key) * 10}/1700000000/file.{container}",
                      "container": container, "size": 5_323_473_020,
                      "Stream": [
                          {"id": 1, "index": 0, "streamType": 1, "codec": video, "displayTitle": "1080p"},
                          {"id": 2, "index": 1, "streamType": 2, "codec": audio, "channels": 6, "default": True,
                           "selected": True, "language": "English", "displayTitle": "English (5.1)"},
                          {"id": 3, "index": 2, "streamType": 3, "codec": "pgs", "language": "English"},
                      ]}],
        }],
        **extra,
    }


class FakePlex:
    """Answers like plex.tv and one reachable server; records every request."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []
        self.approved = False
        self.segment_misses = 1

    def __call__(self, request, timeout=None):
        url = request.full_url
        headers = {k.lower(): v for k, v in request.header_items()}
        self.calls.append((request.get_method(), url, headers))
        parsed = urllib.parse.urlsplit(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        path = parsed.path
        query = dict(urllib.parse.parse_qsl(parsed.query))
        answer = self.answer(request.get_method(), origin, path, query, headers)
        if isinstance(answer, Exception):
            raise answer
        if answer.status >= 400:
            raise urllib.error.HTTPError(url, answer.status, "error", answer.headers, io.BytesIO(answer.body))
        return answer

    def answer(self, method, origin, path, query, headers):
        if origin == "https://plex.tv":
            if path == "/api/v2/pins" and method == "POST":
                return Answer(201, {"id": 42, "code": "abcdefghijkl", "expiresAt": "2026-10-29T17:00:00Z", "authToken": None})
            if path == "/api/v2/pins/42":
                return Answer(200, {"id": 42, "authToken": USER_TOKEN if self.approved else None})
            if path == "/api/v2/pins/99":
                return Answer(404, {"errors": []})
            if path == "/api/v2/user":
                return Answer(200, {"friendlyName": "Devi", "thumb": "https://plex.tv/users/abc/avatar"})
            if path == "/api/v2/resources":
                assert headers.get("x-plex-token") == USER_TOKEN
                return Answer(200, [
                    {"name": "Old server", "clientIdentifier": "old", "provides": "server", "owned": True, "presence": False,
                     "accessToken": "old-token", "connections": [{"uri": "https://192-168-1-2.x.plex.direct:32400", "local": True}]},
                    {"name": "Home", "clientIdentifier": "home", "provides": "server", "owned": True, "presence": True,
                     "accessToken": SERVER_TOKEN, "connections": [
                         {"uri": LOCAL, "local": True, "relay": False, "protocol": "https"},
                         {"uri": REMOTE, "local": False, "relay": False, "protocol": "https"},
                     ]},
                    {"name": "A phone", "clientIdentifier": "phone", "provides": "player", "connections": []},
                ])
        if origin in (LOCAL, "https://192-168-1-2.x.plex.direct:32400"):
            return urllib.error.URLError("unreachable from here")
        if origin != REMOTE:
            return Answer(500, "unexpected")
        if path == "/identity":
            return Answer(200, {"MediaContainer": {"machineIdentifier": "home"}})
        assert headers.get("x-plex-token") == SERVER_TOKEN
        mc = lambda **body: Answer(200, {"MediaContainer": body})  # noqa: E731
        if path == "/library/sections":
            return mc(Directory=[{"key": "1", "title": "Movies", "type": "movie"}, {"key": "2", "title": "Shows", "type": "show"},
                                 {"key": "3", "title": "Music", "type": "artist"}])
        if path == "/hubs/home/continueWatching":
            return mc(Metadata=[{"ratingKey": "9", "type": "episode", "title": "Pilot", "grandparentTitle": "A Show",
                                 "parentIndex": 1, "index": 1, "viewOffset": 61_000, "duration": 1_800_000,
                                 "thumb": "/library/metadata/9/thumb/1", "grandparentThumb": "/library/metadata/5/thumb/1"}])
        if path == "/library/sections/1/recentlyAdded":
            return mc(Metadata=[movie("1", "mkv", "h264", "dca")])
        if path == "/library/sections/2/recentlyAdded":
            return mc()
        if path == "/library/sections/1/all":
            return mc(Metadata=[movie("1", "mkv", "h264", "dca"), movie("7", "mp4", "h264", "aac")], totalSize=2,
                      offset=int(query.get("X-Plex-Container-Start", 0)))
        if path == "/library/metadata/1":
            return mc(Metadata=[movie("1", "mkv", "h264", "dca")])
        if path == "/library/metadata/7":
            return mc(Metadata=[movie("7", "mp4", "h264", "aac")])
        if path == "/library/metadata/8":
            return mc(Metadata=[movie("8", "mkv", "h264", "aac")])
        if path == "/library/metadata/5":
            return mc(Metadata=[{"ratingKey": "5", "type": "show", "title": "A Show", "childCount": 2,
                                 "thumb": "/library/metadata/5/thumb/1"}])
        if path == "/library/metadata/5/children":
            return mc(Metadata=[{"ratingKey": "51", "type": "season", "title": "Season 1", "index": 1, "leafCount": 8,
                                 "viewedLeafCount": 8, "parentTitle": "A Show"}])
        if path == "/hubs/search":
            return mc(Hub=[{"type": "movie", "Metadata": [movie("1", "mkv", "h264", "dca")]}, {"type": "artist", "Metadata": [{}]}])
        if path == "/photo/:/transcode":
            return Answer(200, b"\xff\xd8jpeg", {"Content-Type": "image/jpeg"})
        if path == "/video/:/transcode/universal/start.mpd":
            session = query["session"]
            return Answer(200, (
                f'<MPD><BaseURL>{REMOTE}/video/:/transcode/universal/</BaseURL><Period><AdaptationSet>'
                f'<SegmentTemplate initialization="session/{session}/0/header?X-Plex-Token={SERVER_TOKEN}" '
                f'media="session/{session}/0/$Number$.m4s"/></AdaptationSet></Period></MPD>'), {"Content-Type": "application/dash+xml"})
        if path.startswith("/video/:/transcode/universal/session/"):
            if path.endswith("/1.m4s") and self.segment_misses > 0:
                self.segment_misses -= 1
                return Answer(404, "not yet")
            return Answer(200, b"segment-bytes", {"Content-Type": "video/mp4"})
        if path in ("/video/:/transcode/universal/stop", "/video/:/transcode/universal/ping", "/:/timeline"):
            return Answer(200, {})
        if path.startswith("/library/parts/") and method == "PUT":
            return Answer(200, {})
        if path.startswith("/library/parts/70/"):
            start, end = (int(x) for x in headers["range"].removeprefix("bytes=").split("-"))
            data = bytes(range(256)) * 4
            return Answer(206, data[start:end + 1], {"Content-Range": f"bytes {start}-{min(end, len(data) - 1)}/{len(data)}",
                                                     "Content-Type": "video/mp4"})
        return Answer(404, "nope")


CAPS = {"video": ["h264", "hevc", "av1", "vp9"], "audio": ["aac", "mp3", "opus", "flac"]}


@pytest.fixture
def fake(monkeypatch) -> FakePlex:
    plex = FakePlex()
    monkeypatch.setattr(plex_client, "urlopen", plex)
    return plex


def local(settings) -> TestClient:
    return TestClient(create_app(settings), client=("127.0.0.1", 50000), base_url="http://localhost:8000")


def connect(c: TestClient, fake: FakePlex) -> None:
    assert c.put("/api/apps/plex", json={"enabled": True}).status_code == 200
    pin = c.post("/api/apps/plex/signin").json()
    fake.approved = True
    assert c.get(f"/api/apps/plex/signin/{pin['pin_id']}").json()["state"] == "connected"


def test_sign_in_with_a_pin_then_pick_a_reachable_server(settings, fake):
    with local(settings) as c:
        c.put("/api/apps/plex", json={"enabled": True})
        assert c.get("/api/apps/plex/status").json() == {"connected": False, "signed_in": False, "account": None,
                                                         "avatar": None, "server": None, "connection": None}
        pin = c.post("/api/apps/plex/signin").json()
        assert pin["pin_id"] == 42 and pin["code"] == "abcdefghijkl"
        auth = urllib.parse.urlsplit(pin["auth_url"])
        assert f"{auth.scheme}://{auth.netloc}{auth.path}" == "https://app.plex.tv/auth"
        fragment = dict(urllib.parse.parse_qsl(auth.fragment.removeprefix("?")))
        assert fragment["code"] == "abcdefghijkl" and fragment["context[device][product]"] == "yt-canvas"
        assert fragment["clientID"].startswith("yt-canvas-")

        assert c.get("/api/apps/plex/signin/42").json() == {"state": "waiting", "status": None}
        fake.approved = True
        done = c.get("/api/apps/plex/signin/42").json()
        assert done["state"] == "connected"
        # The local connection doesn't answer from here, so the remote one is used; the offline server is skipped.
        assert done["status"] == {"connected": True, "signed_in": True, "account": "Devi",
                                  "avatar": "https://plex.tv/users/abc/avatar", "server": "Home", "connection": "remote"}
        assert c.get("/api/apps/plex/signin/99").json()["state"] == "expired"
        servers = c.get("/api/apps/plex/servers").json()
        assert [(s["name"], s["online"], s["selected"]) for s in servers] == [("Home", True, True), ("Old server", False, False)]

    saved = settings.app_config_dir / "plex.json"
    assert oct(os.stat(saved).st_mode & 0o777) == "0o600"
    stored = json.loads(saved.read_text())
    assert stored["account"]["token"] == USER_TOKEN and stored["server"]["uri"] == REMOTE
    # Tokens only ever travel in headers.
    assert not any(USER_TOKEN in url or SERVER_TOKEN in url for _, url, _ in fake.calls)


def test_tokens_never_reach_the_browser(settings, fake):
    with local(settings) as c:
        connect(c, fake)
        bodies = [c.get(path).text for path in ("/api/apps/plex/status", "/api/apps/plex/servers", "/api/apps/plex/home",
                                                 "/api/apps/plex/items/1", "/api/apps/plex/libraries/1/items", "/api/apps")]
        play = c.post("/api/apps/plex/play", json={"key": "1", "capabilities": CAPS}).json()
        bodies.append(c.get(play["url"]).text)
    for body in bodies:
        assert USER_TOKEN not in body and SERVER_TOKEN not in body and REMOTE not in body


def test_once_connected_only_this_computer_may_use_the_api(settings, fake):
    with local(settings) as c:
        connect(c, fake)
    remote = TestClient(create_app(settings), client=("192.168.1.30", 50000), base_url="http://localhost:8000")
    with remote:
        assert remote.get("/api/apps/plex/home").status_code == 403


def test_browsing(settings, fake):
    with local(settings) as c:
        connect(c, fake)
        assert c.get("/api/apps/plex/libraries").json() == [{"key": "1", "title": "Movies", "type": "movie"},
                                                            {"key": "2", "title": "Shows", "type": "show"}]
        home = c.get("/api/apps/plex/home").json()
        watching = home["continue_watching"][0]
        assert watching | {"poster": None, "still": None} == watching | {
            "type": "episode", "title": "Pilot", "show_title": "A Show", "season": 1, "episode": 1,
            "view_offset_seconds": 61, "poster": None, "still": None}
        assert watching["poster"] == "/api/apps/plex/image?path=%2Flibrary%2Fmetadata%2F5%2Fthumb%2F1&w=300&h=450"
        assert [row["library"]["title"] for row in home["rows"]] == ["Movies"]

        page = c.get("/api/apps/plex/libraries/1/items", params={"sort": "added", "offset": 0}).json()
        assert page["total"] == 2 and [i["key"] for i in page["items"]] == ["1", "7"]
        sent = next(url for _, url, _ in fake.calls if "/library/sections/1/all" in url)
        assert "sort=addedAt%3Adesc" in sent

        details = c.get("/api/apps/plex/items/1").json()
        assert details["genres"] == ["Drama"] and details["duration_seconds"] == 5997
        media = details["media"][0]
        assert (media["container"], media["video_codec"], media["audio_codec"], media["bitrate_kbps"]) == ("mkv", "h264", "dca", 7102)
        assert [s["kind"] for s in media["streams"]] == ["video", "audio", "subtitle"]

        show = c.get("/api/apps/plex/items/5").json()
        assert [(s["type"], s["season"], s["child_count"], s["watched"]) for s in show["children"]] == [("season", 1, 8, True)]
        assert [i["key"] for i in c.get("/api/apps/plex/search", params={"q": "movie"}).json()] == ["1"]
        assert c.get("/api/apps/plex/items/404").status_code == 404


def test_posters_go_through_the_backend_and_only_for_library_images(settings, fake):
    with local(settings) as c:
        connect(c, fake)
        image = c.get("/api/apps/plex/image", params={"path": "/library/metadata/1/thumb/1700000000", "w": 300, "h": 450})
        assert image.status_code == 200 and image.content == b"\xff\xd8jpeg" and image.headers["content-type"] == "image/jpeg"
        for bad in ("/:/prefs", "/library/metadata/1/thumb/1?x=1", "https://evil.example/x.jpg"):
            assert c.get("/api/apps/plex/image", params={"path": bad}).status_code == 404


def test_dts_audio_goes_through_the_transcoder_as_dash(settings, fake):
    with local(settings) as c:
        connect(c, fake)
        play = c.post("/api/apps/plex/play", json={"key": "1", "capabilities": CAPS}).json()
        assert play["mode"] == "transcode" and "DTS audio" in play["reason"] and "copies the video" in play["reason"]
        assert play["duration_seconds"] == 5997
        start = next((url, headers) for method, url, headers in fake.calls if "start.mpd" in url)
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(start[0]).query))
        assert (query["protocol"], query["directStream"], query["path"]) == ("dash", "1", "/library/metadata/1")
        assert "audioCodec=aac" in start[1]["x-plex-client-profile-extra"]

        manifest = c.get(play["url"])
        assert manifest.headers["content-type"].startswith("application/dash+xml")
        assert REMOTE not in manifest.text and SERVER_TOKEN not in manifest.text
        session = query["session"]
        base = play["url"].removesuffix("start.mpd")
        assert c.get(f"{base}session/{session}/0/header").content == b"segment-bytes"
        # A segment the transcoder hasn't written yet is waited for.
        assert c.get(f"{base}session/{session}/0/1.m4s").content == b"segment-bytes"
        # Nothing outside this session's segments is proxied.
        assert c.get(f"{base}session/other/0/1.m4s").status_code == 404
        assert c.get(f"{base}../../../library/sections").status_code == 404

        assert c.post(f"/api/apps/plex/sessions/{play['session']}/ping").json() == {"ok": True}
        assert c.delete(f"/api/apps/plex/sessions/{play['session']}").json() == {"ok": True}
        assert any("/transcode/universal/stop" in url for _, url, _ in fake.calls)
        assert c.get(play["url"]).status_code == 410


def test_decodable_files_play_directly_in_byte_ranges(settings, fake):
    with local(settings) as c:
        connect(c, fake)
        play = c.post("/api/apps/plex/play", json={"key": "7", "capabilities": CAPS}).json()
        assert (play["mode"], play["container"], play["audio_track"]) == ("direct", "mp4", 2)
        part = c.get(play["url"], headers={"Range": "bytes=10-19"})
        assert part.status_code == 206 and part.content == bytes(range(10, 20))
        assert part.headers["content-range"] == "bytes 10-19/1024"
        assert play["url"].startswith("/api/apps/plex/sessions/")
        mkv = c.post("/api/apps/plex/play", json={"key": "8", "capabilities": CAPS}).json()
        assert (mkv["mode"], mkv["container"]) == ("direct", "matroska")


@pytest.mark.parametrize("change, expected", [
    ({"max_bitrate_kbps": 4000}, "under the 4 Mbit/s you chose"),
    ({"capabilities": {"video": ["av1"], "audio": ["aac"]}}, "can't decode H.264 video"),
])
def test_a_bitrate_cap_or_an_undecodable_video_means_transcoding(settings, fake, change, expected):
    with local(settings) as c:
        connect(c, fake)
        play = c.post("/api/apps/plex/play", json={"key": "7", "capabilities": CAPS, **change}).json()
        assert play["mode"] == "transcode" and expected in play["reason"]


def test_progress_is_reported_to_plex(settings, fake):
    with local(settings) as c:
        connect(c, fake)
        assert c.post("/api/apps/plex/timeline", json={"key": "1", "state": "paused", "time": 61.5, "duration": 5997}).json() == {"ok": True}
    url = next(url for _, url, _ in fake.calls if "/:/timeline" in url)
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
    assert (query["state"], query["time"], query["duration"], query["key"]) == ("paused", "61500", "5997000", "/library/metadata/1")


def test_disconnecting_forgets_the_account(settings, fake):
    with local(settings) as c:
        connect(c, fake)
        assert c.delete("/api/apps/plex/signin").json()["connected"] is False
        assert c.get("/api/apps/plex/home").json()["error"]["code"] == "plex_signed_out"
    stored = json.loads((settings.app_config_dir / "plex.json").read_text())
    assert "account" not in stored and stored["client_id"].startswith("yt-canvas-")


def test_unreachable_servers_are_reported(settings, fake, monkeypatch):
    with local(settings) as c:
        c.put("/api/apps/plex", json={"enabled": True})
        pin = c.post("/api/apps/plex/signin").json()
        fake.approved = True
        monkeypatch.setattr(fake, "answer", lambda method, origin, path, query, headers: (
            urllib.error.URLError("down") if origin != "https://plex.tv" else FakePlex.answer(fake, method, origin, path, query, headers)))
        state = c.get(f"/api/apps/plex/signin/{pin['pin_id']}").json()
        assert state["state"] == "no_server" and state["status"]["signed_in"] is True

"""Opt-in integration tests against real YouTube.

Run with ``YTC_LIVE_TESTS=1 pytest -m live -s``. They report what actually
happens; YouTube may refuse downloads from some networks (e.g. HTTP 403 from
cloud/datacenter IPs), in which case the preparation test fails with that
error code rather than passing on fixtures.
"""

import json
import os
import struct
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("YTC_LIVE_TESTS") != "1", reason="set YTC_LIVE_TESTS=1 to contact YouTube"),
]

# "Big Buck Bunny" by the Blender Foundation (CC BY 3.0), a long-lived public upload.
VIDEO_ID = os.environ.get("YTC_LIVE_VIDEO_ID", "aqz-KE-bpKQ")


def _signed_in_settings():
    """The configured sign-in (YTC_YTDLP_COOKIES_*), only looked at when live tests are on."""
    if os.environ.get("YTC_LIVE_TESTS") != "1":
        return None
    from app.config import load_settings

    try:
        settings = load_settings()
    except ValueError:
        return None
    return settings if settings.signed_in_configured else None


SIGNED_IN = _signed_in_settings()
needs_signin = pytest.mark.skipif(
    SIGNED_IN is None, reason="set YTC_YTDLP_COOKIES_FROM_BROWSER or YTC_YTDLP_COOKIES_FILE to test sign-in")


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    from app.config import Settings

    settings = Settings(data_dir=tmp_path_factory.mktemp("live"), min_free_disk_bytes=0, frontend_dist=None,
                        max_download_bytes=400 * 1024 * 1024)
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_live_search(client):
    response = client.get("/api/search", params={"q": "blender open movie"})
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["items"], "search returned no results"
    assert all(len(item["id"]) == 11 for item in page["items"])
    print(f"\nsearch: {len(page['items'])} results, next_offset={page['next_offset']}")


def test_live_channel_and_playlist(client):
    channel = client.get("/api/channel", params={"ref": "@BlenderOfficial"})
    assert channel.status_code == 200, channel.text
    assert channel.json()["channel"]["id"] == "UCSMOQeBJ2RAnuFungnQOxLg"
    playlist = client.get("/api/playlist", params={"id": "PLa1F2ddGya_-UvuAqHAksYnB0qL9yWDO6"})
    assert playlist.status_code == 200, playlist.text
    assert playlist.json()["items"]


@pytest.mark.parametrize("feed_id", ["music", "news", "live", "gaming"])
def test_live_feeds(client, feed_id):
    response = client.get(f"/api/feeds/{feed_id}")
    assert response.status_code == 200, response.text
    shelves = response.json()["shelves"]
    items = [item for shelf in shelves for item in shelf["items"]]
    summary = "; ".join(f"{shelf['title']}: {len(shelf['items'])}" for shelf in shelves)
    print(f"\n{feed_id}: {len(shelves)} shelves, {len(items)} videos ({summary})")
    assert all(shelf["items"] for shelf in shelves), "empty shelves must be dropped"
    for item in items:
        assert len(item["id"]) == 11 and item["title"] and item["thumbnail_url"]
        assert item["live_status"] not in ("is_live", "is_upcoming"), item
    if feed_id in ("music", "news"):
        assert any(len(shelf["items"]) >= 5 for shelf in shelves), f"no {feed_id} shelf has 5+ playable videos"


def test_live_related(client):
    response = client.get(f"/api/related/{VIDEO_ID}")
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    print(f"\nrelated to {VIDEO_ID}: {len(items)} videos, e.g. {[item['title'] for item in items[:3]]}")
    assert items, "the logged-out watch page carried no related videos"
    assert VIDEO_ID not in {item["id"] for item in items}
    assert all(item["live_status"] not in ("is_live", "is_upcoming") for item in items)


def test_live_preparation(client):
    job = client.post("/api/jobs", json={"source": "youtube", "id": VIDEO_ID}).json()
    deadline = time.monotonic() + 900
    seen = []
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job['id']}").json()
        if not seen or seen[-1] != job["state"]:
            seen.append(job["state"])
        if job["state"] in ("ready", "failed"):
            break
        time.sleep(1)
    print(f"\nstates: {' -> '.join(seen)}")
    if job["state"] == "failed":
        print(f"error: {job['error']}")
    assert job["state"] == "ready", f"live preparation failed: {job['error']}"
    head = client.head(job["media"]["url"])
    assert head.status_code == 200 and int(head.headers["content-length"]) > 0


def _boxes(data: bytes) -> list[tuple[str, int, int]]:
    """Top-level boxes that start within ``data`` (the last one may run past its end)."""
    boxes, offset = [], 0
    while offset + 8 <= len(data):
        size, kind = struct.unpack_from(">I4s", data, offset)
        if size == 1 and offset + 16 <= len(data):
            size = struct.unpack_from(">Q", data, offset + 8)[0]
        if size < 8:
            break
        boxes.append((kind.decode("latin-1"), offset, size))
        offset += size
    return boxes


def test_live_streaming(client):
    response = client.post("/api/streams", json={"source": "youtube", "id": VIDEO_ID})
    assert response.status_code == 200, response.text
    session = response.json()
    trimmed = {**session, "video_tracks": session["video_tracks"][:2], "audio_tracks": session["audio_tracks"][:2]}
    print(f"\nsession: {json.dumps(trimmed, indent=1)}")
    print(f"{len(session['video_tracks'])} video tracks: {[t['id'] for t in session['video_tracks']]}; "
          f"{len(session['audio_tracks'])} audio tracks: {[t['id'] for t in session['audio_tracks']]}")
    assert session["video_tracks"] and session["audio_tracks"]
    assert "googlevideo" not in response.text
    video = next((t for t in session["video_tracks"] if t["codecs"].startswith("avc1")), session["video_tracks"][0])
    for track in (video, session["audio_tracks"][0]):
        url = f"/api/streams/{session['session_id']}/tracks/{track['id']}"
        part = client.get(url, params={"start": 0, "end": 65535})
        assert part.status_code == 200, part.text
        data = part.content
        assert len(data) == min(65536, track["size_bytes"] or 65536)
        boxes = _boxes(data)
        print(f"track {track['id']} ({track['codecs']}): {[(kind, offset, size) for kind, offset, size in boxes[:5]]}")
        assert data[4:8] == b"ftyp"
        assert "sidx" in [kind for kind, _, _ in boxes], "expected a top-level sidx in the first 64 KiB"


@pytest.fixture(scope="module")
def signed_in_client(tmp_path_factory):
    from app.config import Settings

    settings = Settings(data_dir=tmp_path_factory.mktemp("live-signin"), min_free_disk_bytes=0, frontend_dist=None,
                        cookies_from_browser=SIGNED_IN.cookies_from_browser, cookies_file=SIGNED_IN.cookies_file)
    # The API only answers loopback clients while sign-in is configured.
    with TestClient(create_app(settings), client=("127.0.0.1", 50000), base_url="http://localhost") as client:
        yield client


@needs_signin
def test_live_me_signed_in(signed_in_client):
    response = signed_in_client.get("/api/me")
    assert response.status_code == 200, response.text
    me = response.json()
    print(f"\nme: signed_in={me['signed_in']} source={me['source']} chips={me['chips']} detail={me['detail']}")
    assert me["configured"] is True
    assert me["signed_in"] is True, me["detail"]


@needs_signin
def test_live_recommended_feed(signed_in_client):
    response = signed_in_client.get("/api/me/feed/recommended")
    assert response.status_code == 200, response.text
    page = response.json()
    print(f"\nrecommended: {len(page['items'])} videos, next_offset={page['next_offset']}")
    assert page["kind"] == "feed" and page["items"], "the signed-in home feed returned no videos"

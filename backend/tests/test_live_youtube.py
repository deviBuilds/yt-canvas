"""Opt-in integration tests against real YouTube.

Run with ``YTC_LIVE_TESTS=1 pytest -m live -s``. They report what actually
happens; YouTube may refuse downloads from some networks (e.g. HTTP 403 from
cloud/datacenter IPs), in which case the preparation test fails with that
error code rather than passing on fixtures.
"""

import os
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

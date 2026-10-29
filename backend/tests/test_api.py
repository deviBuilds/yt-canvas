"""API surface tests with a fake discovery provider (no network)."""

import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import ChannelInfo, Page, VideoSummary


class FakeDiscovery:
    name = "fake"

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def _page(self, kind, offset, limit, **extra):
        items = [VideoSummary(id=f"vid{offset + i:08d}", title=f"Item {offset + i}") for i in range(limit)]
        return Page(kind=kind, items=items, offset=offset, next_offset=offset + limit if offset < 40 else None,
                    provider=self.name, **extra)

    async def search(self, query, *, offset, limit):
        self.calls.append(("search", query, offset))
        return self._page("search", offset, limit, title=query)

    async def channel(self, ref, *, offset, limit):
        self.calls.append(("channel", ref, offset))
        return self._page("channel", offset, limit, channel=ChannelInfo(ref=ref, name="Chan"))

    async def playlist(self, playlist_id, *, offset, limit):
        self.calls.append(("playlist", playlist_id, offset))
        return self._page("playlist", offset, limit, playlist_id=playlist_id)


@pytest.fixture
def fake():
    return FakeDiscovery()


@pytest.fixture
def client(settings, fake):
    with TestClient(create_app(settings, discovery_provider=fake)) as test_client:
        yield test_client


def test_health_reports_dependencies(client):
    body = client.get("/api/health").json()
    assert set(body["dependencies"]) >= {"ytdlp", "ytdlp_ejs", "ffmpeg", "ffprobe", "js_runtimes"}
    assert body["demo_enabled"] is True


def test_resolve_classifies_without_network(client, fake):
    body = client.get("/api/resolve", params={"q": "https://youtu.be/dQw4w9WgXcQ?t=30"}).json()
    assert body == {"kind": "video", "video_id": "dQw4w9WgXcQ", "playlist_id": None, "channel_ref": None,
                    "query": None, "start_seconds": 30}
    bad = client.get("/api/resolve", params={"q": "https://example.com/x"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_input"
    assert fake.calls == []


def test_search_is_cached(client, fake):
    first = client.get("/api/search", params={"q": "cats"}).json()
    second = client.get("/api/search", params={"q": "  CATS "}).json()
    assert first["cached"] is False and second["cached"] is True
    assert len(fake.calls) == 1
    assert first["next_offset"] == 20


def test_pagination_bounds(client, fake):
    assert client.get("/api/search", params={"q": "cats", "offset": 20}).status_code == 200
    assert client.get("/api/search", params={"q": "cats", "offset": 7}).status_code == 400
    assert client.get("/api/search", params={"q": "cats", "offset": -20}).status_code == 400
    assert client.get("/api/search", params={"q": "cats", "offset": 100}).status_code == 400
    assert client.get("/api/search", params={"q": "cats", "offset": "x"}).status_code == 400


def test_search_rejects_urls(client):
    response = client.get("/api/search", params={"q": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"})
    assert response.status_code == 400


def test_channel_and_playlist_validation(client, fake):
    assert client.get("/api/channel", params={"ref": "@BlenderOfficial"}).json()["channel"]["name"] == "Chan"
    assert client.get("/api/channel", params={"ref": "not valid"}).status_code == 400
    assert client.get("/api/playlist", params={"id": "PLa1F2ddGya_-UvuAqHAksYnB0qL9yWDO6"}).status_code == 200
    assert client.get("/api/playlist", params={"id": "WL"}).status_code == 400
    assert [c[0] for c in fake.calls] == ["channel", "playlist"]


def test_demo_listing_and_layout(client):
    page = client.get("/api/demo").json()
    assert [item["id"] for item in page["items"]] == ["bars", "vertical", "sweep"]
    assert all(item["source"] == "demo" and item["title"].startswith("DEMO") for item in page["items"])
    layout = client.get("/api/demo/bars/layout").json()
    assert layout["width"] == 640 and layout["swatches"]["red"] == [16, 284]


def test_job_endpoints_validate_input(client):
    assert client.post("/api/jobs", json={"source": "youtube", "id": "bad"}).status_code == 400
    assert client.post("/api/jobs", json={"source": "vimeo", "id": "abc"}).status_code == 400
    assert client.post("/api/jobs", json={"source": "demo", "id": "nope"}).status_code == 404
    assert client.get("/api/jobs/unknown").status_code == 404


def test_unknown_api_paths_return_json(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404 and response.json()["error"]["code"] == "not_found"


def test_demo_job_lifecycle_over_http(client):
    """Full pipeline with real ffmpeg: generate -> remux -> serve with ranges."""
    created = client.post("/api/jobs", json={"source": "demo", "id": "bars"})
    assert created.status_code == 201
    job = created.json()
    assert job["demo"] is True and job["state"] in {"queued", "resolving", "downloading"}

    dup = client.post("/api/jobs", json={"source": "demo", "id": "bars"})
    assert dup.status_code == 200 and dup.json()["id"] == job["id"]

    deadline = time.monotonic() + 60
    states = set()
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{job['id']}").json()
        states.add(job["state"])
        if job["state"] in {"ready", "failed"}:
            break
        time.sleep(0.1)
    assert job["state"] == "ready", job.get("error")
    assert job["media"]["processing"] == "remux"
    assert job["media"]["video_codec"] == "h264" and job["media"]["audio_codec"] == "aac"
    assert states & {"downloading", "processing"}

    media = client.get(job["media"]["url"], headers={"Range": "bytes=0-7"})
    assert media.status_code == 206
    assert media.content[4:8] == b"ftyp"


def test_index_csp_allows_media_source_blobs(settings, tmp_path):
    # Streaming feeds the decoder from a Media Source, whose URL is a blob: URL.
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>t</title>")
    from tests.conftest import with_settings

    with TestClient(create_app(with_settings(settings, frontend_dist=dist))) as client:
        csp = client.get("/watch").headers["content-security-policy"]
    assert "media-src 'self' blob:" in csp
    assert "script-src 'self';" in csp

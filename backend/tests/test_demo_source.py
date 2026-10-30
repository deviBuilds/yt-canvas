"""Demo samples' original files, served with byte ranges for direct play."""

import shutil

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import with_settings

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")


def client(settings) -> TestClient:
    return TestClient(create_app(settings), client=("127.0.0.1", 50000), base_url="http://localhost:8000")


@needs_ffmpeg
@pytest.mark.parametrize("sample, magic, kind", [("bars", b"\x1a\x45\xdf\xa3", "video/x-matroska"),
                                                ("sweep", b"\x1a\x45\xdf\xa3", "video/webm")])
def test_source_is_served_in_ranges_and_made_once(settings, sample, magic, kind):
    with client(settings) as c:
        head = c.get(f"/api/demo/{sample}/source", headers={"Range": "bytes=0-3"})
        assert head.status_code == 206
        assert head.content == magic
        assert head.headers["content-type"] == kind
        total = int(head.headers["content-range"].split("/")[1])
        tail = c.get(f"/api/demo/{sample}/source", headers={"Range": f"bytes={total - 10}-"})
        assert tail.status_code == 206 and len(tail.content) == 10
        made = next((settings.data_dir / "demo-sources").glob(f"{sample}.*")).stat().st_mtime_ns
        assert c.head(f"/api/demo/{sample}/source").headers["content-length"] == str(total)
    assert next((settings.data_dir / "demo-sources").glob(f"{sample}.*")).stat().st_mtime_ns == made


def test_unknown_or_disabled_demo_sources(settings):
    with client(settings) as c:
        assert c.get("/api/demo/nope/source").json()["error"]["code"] == "not_found"
    with client(with_settings(settings, enable_demo=False)) as c:
        assert c.get("/api/demo/bars/source").status_code == 404

"""The browser check's endpoints: reports, speed test, drive-lock probe video, benchmark clip."""

import json
import shutil

import pytest
from fastapi.testclient import TestClient

from app.diagnostics import KEPT_REPORTS, MAX_REPORT_BYTES, MAX_SPEED_BYTES, BrowserReports, summary
from app.errors import AppError
from app.main import create_app
from app.media.demo import SAMPLES
from app.media.demo_streams import stream_generator_args

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")

REPORT = {
    "browser": {"chromium": "100.0.4896.127", "tesla": "2026.32.5"},
    "apis": {"webCodecs": True},
    "video": [{"name": "h264", "supported": True}, {"name": "hevc", "supported": False}],
    "audio": [{"name": "ac3", "supported": False}],
    "benchmark": {"fps": 58.9, "dropped": 3},
    "speed": {"mbps": 41.2},
}


def client(settings, host: str = "127.0.0.1", base_url: str = "http://localhost:8000") -> TestClient:
    return TestClient(create_app(settings), client=(host, 50000), base_url=base_url)


def test_reports_are_kept_and_read_back_newest_first(settings):
    with client(settings) as c:
        first = c.post("/api/diagnostics/browser", content=json.dumps(REPORT))
        second = c.post("/api/diagnostics/browser", content=json.dumps({**REPORT, "speed": {"mbps": 7}}))
        assert first.status_code == second.status_code == 200
        reports = c.get("/api/diagnostics/browser").json()["reports"]
    assert [r["id"] for r in reports] == [second.json()["id"], first.json()["id"]]
    assert reports[1]["report"] == REPORT


def test_reports_are_only_readable_on_this_computer(settings):
    # A tunnel connects from 127.0.0.1 but keeps its public Host.
    with client(settings, base_url="https://example.trycloudflare.com") as tunnel:
        assert tunnel.post("/api/diagnostics/browser", content=json.dumps(REPORT)).status_code == 200
        assert tunnel.get("/api/diagnostics/browser").status_code == 403
    with client(settings, host="192.168.1.20") as lan:
        assert lan.get("/api/diagnostics/browser").status_code == 403


@pytest.mark.parametrize("body, status", [
    (b"[1, 2]", 400),
    (b"not json", 400),
    (b"\xff\xfe", 400),
    (b"{" + b" " * MAX_REPORT_BYTES + b"}", 413),
])
def test_bad_reports_are_refused(settings, body, status):
    with client(settings) as c:
        assert c.post("/api/diagnostics/browser", content=body).status_code == status
        assert c.get("/api/diagnostics/browser").json()["reports"] == []


def test_only_the_newest_reports_are_kept():
    reports = BrowserReports()
    ids = [reports.add(json.dumps({"n": n}).encode())["id"] for n in range(KEPT_REPORTS + 3)]
    kept = reports.all()
    assert len(kept) == KEPT_REPORTS
    assert kept[0]["id"] == ids[-1] and kept[0]["report"] == {"n": KEPT_REPORTS + 2}
    with pytest.raises(AppError):
        reports.add(b"null")


def test_summary_tolerates_any_shape():
    line = summary(REPORT)
    assert "chromium=100.0.4896.127" in line and "tesla=2026.32.5" in line
    assert "h264=yes" in line and "hevc=no" in line and "ac3=no" in line
    assert "bench=58.9fps dropped=3" in line and "speed=41.2Mbps" in line
    assert summary({"video": "nonsense", "browser": 3}).startswith("chromium=None")


def test_speed_test_sends_exactly_the_bytes_asked_for(settings):
    with client(settings) as c:
        response = c.get("/api/diagnostics/speed", params={"bytes": 300_000})
        assert response.status_code == 200
        assert len(response.content) == 300_000
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["content-type"] == "application/octet-stream"
        assert len(set(response.content[:4096])) > 200  # random, so a proxy can't compress it
        assert c.get("/api/diagnostics/speed", params={"bytes": 10}).status_code == 400
        assert c.get("/api/diagnostics/speed", params={"bytes": MAX_SPEED_BYTES + 1}).status_code == 400


@needs_ffmpeg
def test_drive_lock_probe_video_is_made_once(settings):
    with client(settings) as c:
        first = c.get("/api/diagnostics/probe.mp4")
        assert first.status_code == 200
        assert first.headers["content-type"] == "video/mp4"
        assert first.content[4:8] == b"ftyp"
        made = (settings.data_dir / "diagnostics" / "probe.mp4").stat().st_mtime_ns
        assert c.get("/api/diagnostics/probe.mp4").content == first.content
    assert (settings.data_dir / "diagnostics" / "probe.mp4").stat().st_mtime_ns == made


def test_benchmark_clip_is_1080p60_and_not_listed(settings):
    sample = SAMPLES["bench1080"]
    assert (sample.width, sample.height, sample.frame_rate) == (1920, 1080, 60)
    args = stream_generator_args(settings, sample, "v.mp4", "a.m4a", with_label=True)
    assert args[args.index("-g") + 1] == "60"  # still one keyframe (one fragment) per second
    assert any("rate=60" in arg for arg in args if arg.startswith("color="))
    with client(settings) as c:
        ids = [item["id"] for item in c.get("/api/demo").json()["items"]]
    assert "bench1080" not in ids and ids == ["bars", "vertical", "sweep"]

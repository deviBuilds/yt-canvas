import shutil
import subprocess
from pathlib import Path

import pytest

from app.media.demo import SAMPLES, DemoMediaProvider
from app.media.ffmpeg import (
    ProbeResult,
    StreamInfo,
    build_plan,
    is_browser_safe_audio,
    is_browser_safe_video,
    probe,
    process_to_mp4,
)
from app.media.models import JobState
from app.media.mp4 import is_faststart, top_level_boxes
from app.media.provider import MediaInput

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
                                  reason="ffmpeg/ffprobe not installed")


def vstream(codec="h264", profile="High", pix_fmt="yuv420p", height=720, index=0):
    return StreamInfo(index, "video", codec, profile, pix_fmt, height * 16 // 9, height, None)


def astream(codec="aac", profile="LC", index=1):
    return StreamInfo(index, "audio", codec, profile, None, None, None, 2)


@pytest.mark.parametrize(
    "stream, safe",
    [
        (vstream(), True),
        (vstream(profile="Main"), True),
        (vstream(profile="Constrained Baseline"), True),
        (vstream(profile="High 10", pix_fmt="yuv420p10le"), False),
        (vstream(profile="High 4:4:4 Predictive", pix_fmt="yuv444p"), False),
        (vstream(codec="hevc", profile="Main"), False),
        (vstream(codec="vp9", profile=None), False),
        (vstream(height=1080), False),
    ],
)
def test_video_compatibility(stream, safe):
    assert is_browser_safe_video(stream, max_height=720) is safe


def test_audio_compatibility():
    assert is_browser_safe_audio(astream())
    assert is_browser_safe_audio(astream(profile="HE-AAC"))
    assert not is_browser_safe_audio(astream(codec="opus", profile=None))
    assert not is_browser_safe_audio(astream(codec="ac3", profile=None))


def plan_for(settings, video, audio, tmp_path):
    inputs = [
        (MediaInput(tmp_path / "v.mp4", "video"), ProbeResult(10.0, [video])),
        (MediaInput(tmp_path / "a.webm", "audio"), ProbeResult(10.0, [audio])),
    ]
    return build_plan(settings, inputs, tmp_path / "out.mp4")


def test_plan_remux_copies_both_streams(settings, tmp_path):
    plan = plan_for(settings, vstream(), astream(index=0), tmp_path)
    assert plan.mode == "remux"
    args = " ".join(plan.args)
    assert "-c:v copy" in args and "-c:a copy" in args
    assert "-map 0:0" in args and "-map 1:0" in args
    assert "+faststart" in args


def test_plan_transcodes_only_what_is_needed(settings, tmp_path):
    plan = plan_for(settings, vstream(), astream(codec="opus", profile=None, index=0), tmp_path)
    assert plan.mode == "transcode_audio"
    assert "-c:v copy" in " ".join(plan.args) and "-c:a aac" in " ".join(plan.args)

    plan = plan_for(settings, vstream(codec="vp9", profile=None), astream(index=0), tmp_path)
    assert plan.mode == "transcode_video"
    args = " ".join(plan.args)
    assert "libx264" in args and "-pix_fmt yuv420p" in args and "-c:a copy" in args
    assert f"-crf {settings.transcode_crf}" in args and f"-preset {settings.transcode_preset}" in args


@needs_ffmpeg
def test_faststart_detection(tmp_path):
    base = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
            "testsrc2=size=64x64:rate=10:duration=1", "-c:v", "libx264"]
    slow = tmp_path / "slow.mp4"
    fast = tmp_path / "fast.mp4"
    subprocess.run([*base, str(slow)], check=True)
    subprocess.run([*base, "-movflags", "+faststart", str(fast)], check=True)
    assert not is_faststart(slow)
    assert is_faststart(fast)
    assert [box for box, _, _ in top_level_boxes(fast)][:1] == ["ftyp"]
    junk = tmp_path / "junk.bin"
    junk.write_bytes(b"not an mp4 at all")
    assert not is_faststart(junk)


class Ctx:
    def __init__(self, workdir: Path) -> None:
        self.workdir = workdir
        self.states: list[JobState] = []
        self.progress = []

    def set_state(self, state, detail=None):
        self.states.append(state)

    def set_progress(self, progress):
        self.progress.append(progress)

    def set_video(self, video):
        pass


@needs_ffmpeg
@pytest.mark.anyio
@pytest.mark.parametrize("sample_id, mode", [("bars", "remux"), ("vertical", "transcode"), ("sweep", "transcode")])
async def test_demo_samples_through_the_real_pipeline(settings, tmp_path, sample_id, mode):
    sample = SAMPLES[sample_id]
    provider = DemoMediaProvider(settings)
    ctx = Ctx(tmp_path)
    resolved = await provider.resolve(sample_id, ctx)
    assert resolved.video.source == "demo" and resolved.video.title.startswith("DEMO")
    acquired = await provider.acquire(resolved, ctx)
    assert ctx.states == [JobState.DOWNLOADING]
    assert any(p.fraction and p.fraction > 0 for p in ctx.progress), "generation should report real progress"

    reports = []
    out = tmp_path / "out.mp4"
    processed = await process_to_mp4(settings, acquired.inputs, out, reports.append,
                                      duration_hint=acquired.duration_hint)
    assert processed.mode == mode
    assert is_faststart(out)
    final = await probe(settings, out)
    video, audio = final.first("video"), final.first("audio")
    assert (video.codec_name, video.pix_fmt) == ("h264", "yuv420p")
    assert (video.width, video.height) == (sample.width, sample.height)
    assert audio.codec_name == "aac"
    assert abs(final.duration - sample.duration) < 0.5
    if mode == "transcode":
        assert any(r.fraction and 0 < r.fraction < 1 for r in reports), "transcoding should report progress"

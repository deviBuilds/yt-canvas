"""Deterministic, locally generated DEMO / TEST media.

These samples let the whole pipeline (job states, processing, byte-range
delivery, canvas rendering) run without YouTube. They are always labelled as
demo media in the API and the UI.

Every sample has the same machine-readable layout, used by the browser tests:

* a 24 px *time bar* across the top: the left ``T / duration`` fraction is
  white (Y=235), the rest black (Y=16), so any frame encodes its timestamp;
* three solid swatches (red, green, blue) of side ``min(w, h) // 6`` on a dark
  panel, 16 px from the bottom-left corner;
* an animated background so consecutive frames differ.

Each sample's *source* is deliberately encoded differently so both the remux
and the transcode paths are exercised.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from ..config import Settings
from ..errors import AppError
from ..models import ChannelInfo, VideoSummary
from ..procs import ExecutableNotFound, ProcessTimeout, run_process
from .models import JobProgress, JobState
from .provider import AcquiredMedia, JobContext, MediaInput, ResolvedMedia

log = logging.getLogger(__name__)

TIME_BAR_HEIGHT = 24
FRAME_RATE = 30  # the samples' default rate for the background and time bar
DEMO_CHANNEL = ChannelInfo(ref=None, name="Demo media (local)")


@dataclass(frozen=True)
class DemoSample:
    id: str
    title: str
    width: int
    height: int
    duration: int
    background: str
    video_args: tuple[str, ...]
    audio_args: tuple[str, ...]
    container: str
    tone_hz: int
    description: str
    frame_rate: int = FRAME_RATE
    # Shown on the Demo page; the benchmark clip for /check isn't.
    listed: bool = True

    @property
    def swatch_size(self) -> int:
        return min(self.width, self.height) // 6

    def layout(self) -> dict:
        s = self.swatch_size
        y = self.height - 16 - s
        return {
            "time_bar_height": TIME_BAR_HEIGHT,
            "swatch_size": s,
            "swatches": {
                "red": [16, y],
                "green": [16 + s + 8, y],
                "blue": [16 + 2 * s + 16, y],
            },
        }


SAMPLES: dict[str, DemoSample] = {
    sample.id: sample
    for sample in (
        DemoSample(
            id="bars",
            title="DEMO · Test pattern (16:9, 20 s)",
            width=640,
            height=360,
            duration=20,
            background="testsrc2=size={w}x{h}:rate=30:duration={d}",
            video_args=("-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-pix_fmt", "yuv420p"),
            audio_args=("-c:a", "aac", "-b:a", "96k"),
            container="matroska",
            tone_hz=440,
            description="H.264/AAC in Matroska → remuxed to MP4 without re-encoding.",
        ),
        DemoSample(
            id="vertical",
            title="DEMO · Vertical clip (9:16, 12 s)",
            width=360,
            height=640,
            duration=12,
            background=("life=size={w}x{h}:rate=30:seed=42:mold=10:ratio=0.2:"
                        "death_color=#101830:life_color=#3fc8ff,trim=duration={d}"),
            video_args=("-c:v", "mpeg4", "-q:v", "6"),
            audio_args=("-c:a", "libmp3lame", "-b:a", "96k"),
            container="avi",
            tone_hz=330,
            description="MPEG-4 Part 2/MP3 in AVI → transcoded to H.264/AAC.",
        ),
        DemoSample(
            id="sweep",
            title="DEMO · Colour sweep (4:3, 16 s)",
            width=480,
            height=360,
            duration=16,
            background="smptehdbars=size={w}x{h}:rate=30:duration={d},hue=H=2*PI*t/8",
            video_args=("-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "600k"),
            audio_args=("-c:a", "libopus", "-b:a", "64k"),
            container="webm",
            tone_hz=550,
            description="VP9/Opus in WebM → transcoded to H.264/AAC.",
        ),
        DemoSample(
            id="bench1080",
            title="DEMO · 1080p60 decode benchmark (12 s)",
            width=1920,
            height=1080,
            duration=12,
            background="testsrc2=size={w}x{h}:rate=60:duration={d}",
            video_args=("-c:v", "libx264", "-preset", "veryfast", "-g", "60", "-pix_fmt", "yuv420p"),
            audio_args=("-c:a", "aac", "-b:a", "96k"),
            container="matroska",
            tone_hz=440,
            description="1080p60 H.264/AAC streamed by the benchmark on /check.",
            frame_rate=60,
            listed=False,
        ),
    )
}


def demo_summary(sample: DemoSample) -> VideoSummary:
    return VideoSummary(
        source="demo",
        id=sample.id,
        title=sample.title,
        channel=DEMO_CHANNEL,
        duration_seconds=sample.duration,
        thumbnail_url=None,
        live_status="not_live",
    )


def _filter_graph(sample: DemoSample) -> str:
    w, h, d = sample.width, sample.height, sample.duration
    s = sample.swatch_size
    y = h - 16 - s
    return (
        f"[1:v]format=yuv420p,geq=lum='if(lt(X,W*T/{d}),235,16)':cb=128:cr=128[bar];"
        f"[0:v][bar]overlay=0:0:shortest=1,"
        f"drawbox=x=8:y={y - 8}:w={3 * s + 32}:h={s + 16}:color=0x101010@1:t=fill,"
        f"drawbox=x=16:y={y}:w={s}:h={s}:color=0xFF0000@1:t=fill,"
        f"drawbox=x={16 + s + 8}:y={y}:w={s}:h={s}:color=0x00FF00@1:t=fill,"
        f"drawbox=x={16 + 2 * s + 16}:y={y}:w={s}:h={s}:color=0x0000FF@1:t=fill"
    )


def lavfi_inputs(sample: DemoSample, readrate: int = 0) -> list[str]:
    """The three generator inputs: background (0:v), time-bar canvas (1:v) and tone (2:a)."""
    w, h, d = sample.width, sample.height, sample.duration
    # -readrate (FFmpeg 5.0+) makes generation take a predictable minimum time, like a download.
    throttle = ("-readrate", str(readrate)) if readrate else ()
    return [
        *throttle, "-f", "lavfi", "-i", sample.background.format(w=w, h=h, d=d),
        *throttle, "-f", "lavfi", "-i",
        f"color=c=black:size={w}x{TIME_BAR_HEIGHT}:rate={sample.frame_rate}:duration={d}",
        *throttle, "-f", "lavfi", "-i", f"sine=frequency={sample.tone_hz}:sample_rate=48000:duration={d}",
    ]


def video_graph(sample: DemoSample, *, with_label: bool) -> str:
    """The ``-filter_complex`` graph over :func:`lavfi_inputs`; its output pad is ``[v]``."""
    graph = _filter_graph(sample)
    if with_label:
        graph += (",drawtext=text='DEMO':fontcolor=white:fontsize=24:x=w-tw-16:y=40:"
                  "box=1:boxcolor=black@0.6:boxborderw=8")
    return graph + ",format=yuv420p[v]"


def generator_args(settings: Settings, sample: DemoSample, output: str, *, with_label: bool) -> list[str]:
    return [
        settings.ffmpeg_path, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-progress", "pipe:1", "-nostats",
        *lavfi_inputs(sample, settings.demo_readrate),
        "-filter_complex", video_graph(sample, with_label=with_label),
        "-map", "[v]", "-map", "2:a",
        *sample.video_args, *sample.audio_args,
        "-t", str(sample.duration),
        "-f", sample.container,
        output,
    ]


CONTAINER_TYPES = {"matroska": ("mkv", "video/x-matroska"), "webm": ("webm", "video/webm"), "avi": ("avi", "video/x-msvideo")}
_source_locks: dict[str, asyncio.Lock] = {}


async def ensure_source(settings: Settings, sample: DemoSample) -> Path:
    """The sample's original file (Matroska, WebM or AVI), made once and kept, for direct play.

    The same file the demo provider prepares from, served as it is: the player reads it in
    byte ranges, the way the Plex app plays files.
    """
    ext, _ = CONTAINER_TYPES[sample.container]
    path = settings.data_dir / "demo-sources" / f"{sample.id}.{ext}"
    async with _source_locks.setdefault(sample.id, asyncio.Lock()):
        if path.is_file() and path.stat().st_size > 0:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{sample.id}.{os.getpid()}.tmp.{ext}")
        try:
            last_error = ""
            for with_label in (True, False):  # drawtext needs a font; retry without the label
                try:
                    result = await run_process(generator_args(settings, sample, str(tmp), with_label=with_label), timeout=120)
                except ExecutableNotFound as exc:
                    raise AppError("dependency_missing", "ffmpeg is required to generate demo media.", status=500,
                                   hint="Install FFmpeg and make sure it is on PATH.") from exc
                except ProcessTimeout as exc:
                    raise AppError("processing_failed", "Generating demo media timed out.", status=500) from exc
                if result.returncode == 0:
                    os.replace(tmp, path)
                    return path
                last_error = result.stderr_tail
            log.warning("demo source generation failed: %s", last_error[-4000:])
            raise AppError("processing_failed", "Generating demo media failed.", status=500,
                           hint="Check the backend log for the ffmpeg error.")
        finally:
            tmp.unlink(missing_ok=True)


class DemoMediaProvider:
    source = "demo"
    supports_progressive = False

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def validate_ref(self, ref: str) -> str:
        if ref not in SAMPLES:
            raise AppError("not_found", "Unknown demo sample.", status=404)
        return ref

    async def resolve(self, ref: str, ctx: JobContext) -> ResolvedMedia:
        sample = SAMPLES[self.validate_ref(ref)]
        return ResolvedMedia(video=demo_summary(sample), estimated_bytes=40 * 1024 * 1024,
                             details={"sample": sample})

    async def acquire(self, resolved: ResolvedMedia, ctx: JobContext) -> AcquiredMedia:
        sample: DemoSample = resolved.details["sample"]
        ext, _ = CONTAINER_TYPES[sample.container]
        output = ctx.workdir / f"source.{ext}"
        ctx.set_state(JobState.DOWNLOADING, "Generating demo source locally (no network)")

        def on_line(line: str) -> None:
            key, _, value = line.partition("=")
            if key == "out_time_us":
                try:
                    seconds = int(value) / 1_000_000
                except ValueError:
                    return
                ctx.set_progress(JobProgress(
                    fraction=max(0.0, min(1.0, seconds / sample.duration)),
                    detail="Generating demo source locally (no network)",
                ))

        last_error = ""
        for with_label in (True, False):  # drawtext needs a font; retry without the label
            try:
                result = await run_process(
                    generator_args(self.settings, sample, str(output), with_label=with_label),
                    timeout=120,
                    on_stdout_line=on_line,
                )
            except ExecutableNotFound as exc:
                raise AppError("dependency_missing", "ffmpeg is required to generate demo media.", status=500,
                               hint="Install FFmpeg and make sure it is on PATH.") from exc
            except ProcessTimeout as exc:
                raise AppError("processing_failed", "Generating demo media timed out.", status=500) from exc
            if result.returncode == 0:
                return AcquiredMedia(inputs=[MediaInput(output, "muxed")], duration_hint=float(sample.duration))
            last_error = result.stderr_tail
        log.warning("demo generation failed: %s", last_error[-4000:])
        raise AppError("processing_failed", "Generating demo media failed.", status=500,
                       hint="Check the backend log for the ffmpeg error.")

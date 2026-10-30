"""Demo streaming tracks: the demo samples as DASH-style fragmented MP4s, made locally.

``POST /api/streams {"source": "demo", "id": ...}`` serves these through the same track
endpoint as YouTube streams, so the Media Source Extensions player can be tested offline.
Each sample is generated once with FFmpeg from the same lavfi inputs and filter graph as
the downloadable demo (time bar, swatches, background; see :mod:`app.media.demo`), never
throttled by YTC_DEMO_READRATE, and cached under ``<data dir>/streams/demo/<sample>/``:

* ``video.mp4``: H.264 (libx264, yuv420p, no B-frames), a keyframe every second, no audio;
* ``audio.m4a``: AAC-LC, no video, 1 s fragments.

Both are laid out like YouTube's DASH files: ``ftyp``, ``moov``, one top-level ``sidx``
indexing every fragment, then ``moof``/``mdat`` pairs. That is FFmpeg's
``-movflags dash+global_sidx``; ``skip_trailer`` drops the ``mfra`` it would append.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import struct
from dataclasses import dataclass
from pathlib import Path

from ..config import Settings
from ..errors import AppError
from ..procs import ExecutableNotFound, ProcessTimeout, run_process
from .demo import SAMPLES, DemoSample, demo_summary, lavfi_inputs, video_graph
from .models import StreamAudioTrack, StreamVideoTrack
from .mp4 import codec_string, read_sidx, top_level_boxes
from .streams import ResolvedStream, Track

log = logging.getLogger(__name__)

# Bump to regenerate cached tracks when the layout changes in a way the arguments don't show.
GENERATION_VERSION = 1
MOVFLAGS = "dash+global_sidx+skip_trailer"
VIDEO_TRACK_ID = "video"
AUDIO_TRACK_ID = "audio"
_TIMEOUT = 120


def stream_generator_args(settings: Settings, sample: DemoSample, video_out: str, audio_out: str, *,
                          with_label: bool) -> list[str]:
    gop = str(sample.frame_rate)  # one keyframe (and so one fragment) per second
    duration = str(sample.duration)
    return [
        settings.ffmpeg_path, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        *lavfi_inputs(sample),
        "-filter_complex", video_graph(sample, with_label=with_label),
        "-map", "[v]", "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-bf", "0",
        "-t", duration, "-f", "mp4", "-movflags", MOVFLAGS, video_out,
        "-map", "2:a", "-vn",
        "-c:a", "aac", "-b:a", "96k",
        "-t", duration, "-f", "mp4", "-frag_duration", "1000000", "-movflags", MOVFLAGS, audio_out,
    ]


def _fingerprint(settings: Settings, sample: DemoSample) -> str:
    args = stream_generator_args(settings, sample, "video", "audio", with_label=True)[1:]
    return hashlib.sha256(json.dumps([GENERATION_VERSION, args]).encode()).hexdigest()[:16]


def _has_dash_layout(path: Path) -> bool:
    types = [box for box, _, _ in top_level_boxes(path, limit=8)]
    return types[:4] == ["ftyp", "moov", "sidx", "moof"]


@dataclass(frozen=True)
class DemoTracks:
    video: Path
    audio: Path
    video_codecs: str
    audio_codecs: str
    duration: float  # of the longer track (AAC frames make the audio run slightly long)


class DemoStreamResolver:
    source = "demo"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._locks: dict[str, asyncio.Lock] = {}

    def validate_ref(self, ref: str) -> str:
        if ref not in SAMPLES:
            raise AppError("not_found", "Unknown demo sample.", status=404)
        return ref

    async def resolve(self, ref: str, *, refresh: bool = False) -> ResolvedStream:
        sample = SAMPLES[self.validate_ref(ref)]
        files = await self.ensure(sample)
        video_size, audio_size = files.video.stat().st_size, files.audio.stat().st_size
        duration = float(sample.duration)  # nominal, for bitrates
        video = StreamVideoTrack(
            id=VIDEO_TRACK_ID, mime_type="video/mp4", codecs=files.video_codecs,
            width=sample.width, height=sample.height, fps=sample.frame_rate,
            bitrate=int(video_size * 8 / duration), size_bytes=video_size,
        )
        audio = StreamAudioTrack(id=AUDIO_TRACK_ID, mime_type="audio/mp4", codecs=files.audio_codecs,
                                 bitrate=int(audio_size * 8 / duration), size_bytes=audio_size)
        return ResolvedStream(
            source="demo",
            video_id=sample.id,
            video=demo_summary(sample),
            duration=files.duration,
            tracks={
                VIDEO_TRACK_ID: Track(VIDEO_TRACK_ID, "video", video, video_size, path=files.video),
                AUDIO_TRACK_ID: Track(AUDIO_TRACK_ID, "audio", audio, audio_size, path=files.audio),
            },
        )

    async def ensure(self, sample: DemoSample) -> DemoTracks:
        """The sample's tracks, generated on first use (one generation at a time per sample)."""
        lock = self._locks.setdefault(sample.id, asyncio.Lock())
        async with lock:
            directory = self.settings.streams_dir / "demo" / sample.id
            fingerprint = _fingerprint(self.settings, sample)
            cached = self._load(directory, fingerprint)
            if cached is not None:
                return cached
            return await self._generate(sample, directory, fingerprint)

    @staticmethod
    def _load(directory: Path, fingerprint: str) -> DemoTracks | None:
        try:
            meta = json.loads((directory / "meta.json").read_text("utf-8"))
            tracks = DemoTracks(directory / "video.mp4", directory / "audio.m4a",
                                str(meta["video_codecs"]), str(meta["audio_codecs"]), float(meta["duration"]))
            if meta.get("fingerprint") != fingerprint:
                return None
            if tracks.video.stat().st_size > 0 and tracks.audio.stat().st_size > 0:
                return tracks
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    async def _generate(self, sample: DemoSample, directory: Path, fingerprint: str) -> DemoTracks:
        directory.mkdir(parents=True, exist_ok=True)
        tag = os.getpid()  # another server sharing the data dir mustn't write the same temp files
        tmp_video, tmp_audio = directory / f"video.{tag}.tmp.mp4", directory / f"audio.{tag}.tmp.m4a"
        try:
            video_codecs, audio_codecs, duration = await self._encode(sample, tmp_video, tmp_audio)
            tracks = DemoTracks(directory / "video.mp4", directory / "audio.m4a", video_codecs, audio_codecs,
                                duration)
            os.replace(tmp_video, tracks.video)
            os.replace(tmp_audio, tracks.audio)
        finally:
            tmp_video.unlink(missing_ok=True)
            tmp_audio.unlink(missing_ok=True)
        meta = {"fingerprint": fingerprint, "video_codecs": video_codecs, "audio_codecs": audio_codecs,
                "duration": duration}
        tmp_meta = directory / f"meta.{tag}.tmp.json"
        tmp_meta.write_text(json.dumps(meta), "utf-8")
        os.replace(tmp_meta, directory / "meta.json")
        log.info("generated demo stream %s (%s, %s)", sample.id, video_codecs, audio_codecs)
        return tracks

    async def _encode(self, sample: DemoSample, video: Path, audio: Path) -> tuple[str, str, float]:
        """Run FFmpeg; return the codec strings and the longer track's duration."""
        last_error = ""
        for with_label in (True, False):  # drawtext needs a font; retry without the label
            args = stream_generator_args(self.settings, sample, str(video), str(audio), with_label=with_label)
            try:
                result = await run_process(args, timeout=_TIMEOUT)
            except ExecutableNotFound as exc:
                raise AppError("dependency_missing", "ffmpeg is required to generate demo media.", status=500,
                               hint="Install FFmpeg and make sure it is on PATH.") from exc
            except ProcessTimeout as exc:
                raise AppError("processing_failed", "Generating demo media timed out.", status=500) from exc
            if result.returncode == 0:
                break
            last_error = result.stderr_tail
        else:
            log.warning("demo stream generation failed: %s", last_error[-4000:])
            raise AppError("processing_failed", "Generating demo media failed.", status=500,
                           hint="Check the backend log for the ffmpeg error.")
        try:
            if not (_has_dash_layout(video) and _has_dash_layout(audio)):
                raise ValueError("expected ftyp, moov, sidx, moof")
            duration = round(max(read_sidx(video).duration, read_sidx(audio).duration), 6)
            return codec_string(video), codec_string(audio), duration
        except (OSError, ValueError, IndexError, StopIteration, struct.error) as exc:
            log.warning("demo stream for %s has an unexpected layout: %s", sample.id, exc)
            raise AppError("processing_failed", "Generating demo media failed.", status=500,
                           hint="This FFmpeg build doesn't write the expected DASH layout.") from None

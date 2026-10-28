"""Probe inputs with ffprobe and produce a browser-compatible, faststart MP4.

Container extensions are not trusted: every stream is probed, and only H.264
(8-bit 4:2:0, common profiles) video and AAC audio are copied. Anything else
is transcoded to H.264/AAC within the configured limits.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import Settings
from ..errors import AppError, redact
from ..procs import ExecutableNotFound, ProcessTimeout, run_process
from .models import JobProgress
from .mp4 import is_faststart
from .provider import MediaInput, ProgressCallback

log = logging.getLogger(__name__)

_SAFE_H264_PROFILES = {"baseline", "constrained baseline", "main", "high", "extended"}
_SAFE_PIX_FMTS = {"yuv420p", "yuvj420p"}
_SAFE_AAC_PROFILES = {"lc", "he-aac", "he-aacv2", "he-aac v2"}


@dataclass
class StreamInfo:
    index: int
    codec_type: str
    codec_name: str | None
    profile: str | None
    pix_fmt: str | None
    width: int | None
    height: int | None
    channels: int | None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> StreamInfo:
        def as_int(key: str) -> int | None:
            value = data.get(key)
            return value if isinstance(value, int) else None

        return cls(
            index=int(data.get("index", 0)),
            codec_type=str(data.get("codec_type", "")),
            codec_name=data.get("codec_name"),
            profile=data.get("profile"),
            pix_fmt=data.get("pix_fmt"),
            width=as_int("width"),
            height=as_int("height"),
            channels=as_int("channels"),
        )


@dataclass
class ProbeResult:
    duration: float | None
    streams: list[StreamInfo]

    def first(self, codec_type: str) -> StreamInfo | None:
        return next((s for s in self.streams if s.codec_type == codec_type and s.codec_name), None)


def is_browser_safe_video(stream: StreamInfo, max_height: int) -> bool:
    if stream.codec_name != "h264":
        return False
    if stream.pix_fmt not in _SAFE_PIX_FMTS:
        return False
    if stream.profile and stream.profile.lower() not in _SAFE_H264_PROFILES:
        return False
    if stream.height and stream.height > max_height:
        return False
    return True


def is_browser_safe_audio(stream: StreamInfo) -> bool:
    if stream.codec_name != "aac":
        return False
    return not stream.profile or stream.profile.lower() in _SAFE_AAC_PROFILES


async def probe(settings: Settings, path: Path) -> ProbeResult:
    args = [
        settings.ffprobe_path,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "--",
        str(path),
    ]
    try:
        result = await run_process(args, timeout=60, max_stdout=4 * 1024 * 1024)
    except ExecutableNotFound as exc:
        raise AppError("dependency_missing", "ffprobe is required but was not found.", status=500,
                       hint="Install FFmpeg (which includes ffprobe).") from exc
    except ProcessTimeout as exc:
        raise AppError("processing_failed", "Inspecting the media took too long.", status=500) from exc
    if result.returncode != 0:
        log.warning("ffprobe failed for %s: %s", path.name, redact(result.stderr_tail[-4000:]))
        raise AppError("processing_failed", "The downloaded media could not be read.", status=500, retryable=True)
    data = json.loads(result.stdout or b"{}")
    duration = None
    try:
        duration = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        pass
    streams = [StreamInfo.from_json(s) for s in data.get("streams", []) if isinstance(s, dict)]
    return ProbeResult(duration=duration, streams=streams)


@dataclass
class ProcessingPlan:
    args: list[str]
    copy_video: bool
    copy_audio: bool
    has_audio: bool

    @property
    def mode(self) -> str:
        if self.copy_video and (self.copy_audio or not self.has_audio):
            return "remux"
        if self.copy_video:
            return "transcode_audio"
        if self.copy_audio or not self.has_audio:
            return "transcode_video"
        return "transcode"


def build_plan(
    settings: Settings,
    inputs: list[tuple[MediaInput, ProbeResult]],
    output: Path,
) -> ProcessingPlan:
    """Pick one video and (optionally) one audio stream and decide copy vs. transcode."""
    video_src: tuple[int, StreamInfo] | None = None
    audio_src: tuple[int, StreamInfo] | None = None
    for i, (media_input, probed) in enumerate(inputs):
        if media_input.role in ("video", "muxed") and video_src is None:
            stream = probed.first("video")
            if stream:
                video_src = (i, stream)
        if media_input.role in ("audio", "muxed") and audio_src is None:
            stream = probed.first("audio")
            if stream:
                audio_src = (i, stream)
    if video_src is None:
        raise AppError("processing_failed", "The downloaded media has no video track.", status=422)

    copy_video = is_browser_safe_video(video_src[1], settings.max_height)
    copy_audio = audio_src is not None and is_browser_safe_audio(audio_src[1])

    args = [settings.ffmpeg_path, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
            "-progress", "pipe:1", "-nostats"]
    for media_input, _ in inputs:
        args += ["-i", str(media_input.path)]
    args += ["-map", f"{video_src[0]}:{video_src[1].index}"]
    if audio_src is not None:
        args += ["-map", f"{audio_src[0]}:{audio_src[1].index}"]

    if copy_video:
        args += ["-c:v", "copy"]
    else:
        args += [
            "-c:v", "libx264",
            "-preset", settings.transcode_preset,
            "-crf", str(settings.transcode_crf),
            "-profile:v", "high",
            "-pix_fmt", "yuv420p",
            # Downscale only, keep aspect, force even dimensions for 4:2:0.
            "-vf", f"scale=-2:'min({settings.max_height},ih)':flags=bicubic,setsar=1",
            "-g", "60",
        ]
    if audio_src is not None:
        if copy_audio:
            args += ["-c:a", "copy"]
        else:
            args += ["-c:a", "aac", "-b:a", settings.transcode_audio_bitrate, "-ac", "2"]
    if settings.ffmpeg_threads:
        args += ["-threads", str(settings.ffmpeg_threads)]
    args += [
        "-sn", "-dn",
        "-map_metadata", "-1",
        "-max_muxing_queue_size", "1024",
        "-movflags", "+faststart",
        "-f", "mp4",
        str(output),
    ]
    return ProcessingPlan(args=args, copy_video=copy_video, copy_audio=copy_audio, has_audio=audio_src is not None)


@dataclass
class ProcessedMedia:
    path: Path
    mode: str
    probe: ProbeResult


def _progress_parser(duration: float | None, report: ProgressCallback, detail: str):
    def handle(line: str) -> None:
        key, _, value = line.partition("=")
        if key == "out_time_us" and duration:
            try:
                seconds = int(value) / 1_000_000
            except ValueError:
                return
            report(JobProgress(fraction=max(0.0, min(1.0, seconds / duration)), detail=detail))

    return handle


async def process_to_mp4(
    settings: Settings,
    inputs: list[MediaInput],
    output: Path,
    report: ProgressCallback,
    *,
    duration_hint: float | None = None,
) -> ProcessedMedia:
    probed = [(media_input, await probe(settings, media_input.path)) for media_input in inputs]
    plan = build_plan(settings, probed, output)
    duration = duration_hint or max((p.duration or 0 for _, p in probed), default=0) or None
    detail = {
        "remux": "Remuxing to MP4 (no re-encoding)",
        "transcode_audio": "Converting audio to AAC",
        "transcode_video": "Transcoding video to H.264",
        "transcode": "Transcoding to H.264/AAC",
    }[plan.mode]
    report(JobProgress(fraction=0.0 if duration else None, detail=detail))

    try:
        result = await run_process(
            plan.args,
            timeout=settings.process_timeout,
            on_stdout_line=_progress_parser(duration, report, detail),
        )
    except ExecutableNotFound as exc:
        raise AppError("dependency_missing", "ffmpeg is required but was not found.", status=500,
                       hint="Install FFmpeg and make sure it is on PATH.") from exc
    except ProcessTimeout as exc:
        raise AppError("processing_failed", "Processing took longer than the configured limit.", status=500,
                       hint="Raise YTC_PROCESS_TIMEOUT or lower YTC_MAX_HEIGHT.") from exc
    if result.returncode != 0:
        log.warning("ffmpeg failed (%s): %s", plan.mode, redact(result.stderr_tail[-4000:]))
        raise AppError("processing_failed", "Converting the media for browser playback failed.", status=500)

    final = await probe(settings, output)
    video = final.first("video")
    if video is None or video.codec_name != "h264":
        raise AppError("processing_failed", "The processed file has no H.264 video track.", status=500)
    if not is_faststart(output):
        raise AppError("processing_failed", "The processed file is not optimised for web playback.", status=500)
    report(JobProgress(fraction=1.0, detail=detail))
    return ProcessedMedia(path=output, mode=plan.mode, probe=final)

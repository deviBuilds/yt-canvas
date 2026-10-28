"""YouTube media acquisition with yt-dlp.

1. ``resolve``: one ``yt-dlp -J`` call returns metadata and every available
   format. Live/upcoming streams, restricted videos and over-long videos are
   rejected here, before anything is downloaded. The info JSON is kept so
   the download step can reuse it instead of extracting again.
2. ``acquire``: download the selected track(s) as separate files with
   ``--load-info-json``. Merging and any conversion happen afterwards in the
   shared FFmpeg step, in a single pass.

Extracted googlevideo URLs are signed, IP-bound and short-lived. They stay
inside yt-dlp and are never returned to clients or logged unredacted.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from ..config import Settings
from ..discovery.normalize import normalize_entry
from ..errors import AppError
from ..models import VideoSummary
from ..procs import ExecutableNotFound, ProcessTimeout, run_process
from ..validation import validate_video_id, watch_url
from ..ytdlp import base_args, classify_error, log_failure, run_json
from .formats import FormatChoice, select_formats
from .models import JobProgress, JobState
from .provider import AcquiredMedia, JobContext, MediaInput, ResolvedMedia

log = logging.getLogger(__name__)

_PROGRESS_PREFIX = "YTCP|"
_PROGRESS_TEMPLATE = (
    "download:" + _PROGRESS_PREFIX + "%(info.format_id)s|%(progress.status)s|%(progress.downloaded_bytes)s|"
    "%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s"
)
_IGNORED_SUFFIXES = {".part", ".ytdl", ".json", ".temp", ".tmp"}


class _TooLarge(Exception):
    pass


def _number(value: str) -> float | None:
    try:
        number = float(value)
    except ValueError:
        return None
    return number if number >= 0 else None


def check_playable(info: dict[str, Any], settings: Settings) -> None:
    """Reject media we deliberately don't support, with a clear reason."""
    live_status = info.get("live_status")
    if info.get("is_live") or live_status == "is_live":
        raise AppError("live_unsupported", "Live streams can't be prepared for playback.", status=422,
                       hint="Only public, non-live videos are supported. Try again after the stream ends.")
    if live_status == "is_upcoming":
        raise AppError("live_unsupported", "This live stream or premiere hasn't started yet.", status=422)
    if live_status == "post_live":
        raise AppError("live_unsupported", "This stream just ended and YouTube is still processing it.",
                       status=422, hint="Try again later.", retryable=True)
    availability = info.get("availability")
    if availability in {"needs_auth", "subscriber_only", "premium_only"}:
        raise AppError("restricted", "This video requires a signed-in or paying account.", status=403,
                       hint="Signed-in and restricted videos are not supported.")
    duration = info.get("duration")
    if isinstance(duration, (int, float)) and duration > settings.max_duration_seconds:
        limit_min = settings.max_duration_seconds // 60
        raise AppError("too_long", f"This video is longer than the {limit_min}-minute limit.", status=413,
                       hint="Raise YTC_MAX_DURATION_SECONDS to allow longer videos.")


class YouTubeMediaProvider:
    source = "youtube"
    supports_progressive = False

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def validate_ref(self, ref: str) -> str:
        return validate_video_id(ref)

    async def resolve(self, ref: str, ctx: JobContext) -> ResolvedMedia:
        video_id = self.validate_ref(ref)
        args = [*base_args(self.settings), "--no-playlist", "--dump-single-json", "--skip-download",
                "--", watch_url(video_id)]
        info = await run_json(self.settings, args, timeout=self.settings.resolve_timeout,
                              context=f"resolve {video_id}")
        if info.get("id") != video_id:
            raise AppError("extraction_failed", "yt-dlp returned metadata for a different video.", status=502)

        video = normalize_entry({**info, "ie_key": "Youtube"})
        if video is not None:
            ctx.set_video(video)
        check_playable(info, self.settings)

        duration = info.get("duration") if isinstance(info.get("duration"), (int, float)) else None
        try:
            choice = select_formats(
                info.get("formats"),
                max_height=self.settings.max_height,
                max_bytes=self.settings.max_download_bytes,
                duration=duration,
            )
        except ValueError:
            limit_mb = self.settings.max_download_bytes // (1024 * 1024)
            raise AppError("too_large", f"Even the smallest suitable version exceeds the {limit_mb} MB limit.",
                           status=413, hint="Raise YTC_MAX_DOWNLOAD_MB to allow larger downloads.") from None
        if choice is None:
            raise AppError("no_formats", "YouTube offered no formats this app can play or convert.", status=422,
                           hint="Updating yt-dlp may help.")

        info_path = ctx.workdir / "info.json"
        info_path.write_text(json.dumps(info), "utf-8")
        log.info("video %s: formats %s (%s, %sp, ~%s bytes)", video_id, "+".join(choice.format_ids),
                 choice.strategy, choice.height, choice.estimated_bytes)
        return ResolvedMedia(
            video=video or VideoSummary(source="youtube", id=video_id, title="YouTube video"),
            estimated_bytes=choice.estimated_bytes,
            details={"choice": choice, "info_path": info_path, "duration": duration},
        )

    async def acquire(self, resolved: ResolvedMedia, ctx: JobContext) -> AcquiredMedia:
        choice: FormatChoice = resolved.details["choice"]
        info_path: Path = resolved.details["info_path"]
        max_bytes = self.settings.max_download_bytes

        expected: dict[str, int | None] = {}
        for fmt in filter(None, (choice.video_format, choice.audio_format)):
            size = fmt.get("filesize") or fmt.get("filesize_approx")
            expected[str(fmt["format_id"])] = int(size) if isinstance(size, (int, float)) else None
        done: dict[str, int] = {}
        current: dict[str, int] = {}
        label = "Downloading video and audio tracks" if len(choice.format_ids) > 1 else "Downloading media"
        ctx.set_state(JobState.DOWNLOADING, label)

        def on_line(line: str) -> None:
            if not line.startswith(_PROGRESS_PREFIX):
                return
            parts = line[len(_PROGRESS_PREFIX):].split("|")
            if len(parts) != 7:
                return
            format_id, status, downloaded, total, estimate, speed, eta = parts
            got = _number(downloaded)
            size = _number(total) or _number(estimate)
            if size:
                expected[format_id] = int(size)
            if got is not None:
                current[format_id] = int(got)
            if status == "finished":
                done[format_id] = current.get(format_id) or expected.get(format_id) or 0
            received = sum({**current, **done}.values())
            if received > max_bytes:
                raise _TooLarge()
            totals = list(expected.values())
            total_bytes = sum(t for t in totals if t) if all(totals) else None
            ctx.set_progress(JobProgress(
                fraction=min(1.0, received / total_bytes) if total_bytes else None,
                downloaded_bytes=received,
                total_bytes=total_bytes,
                speed_bps=_number(speed),
                eta_seconds=_number(eta),
                detail=label,
            ))

        args = [
            *base_args(self.settings),
            "--load-info-json", str(info_path),
            "-f", ",".join(choice.format_ids),
            "-P", str(ctx.workdir),
            "-o", "%(format_id)s.%(ext)s",
            "--newline",
            "--progress-template", _PROGRESS_TEMPLATE,
            "--max-filesize", str(max_bytes),
            "--no-mtime",
            "--no-playlist",
            "--concurrent-fragments", "4",
            "--retries", "3",
            "--fragment-retries", "3",
        ]
        try:
            result = await run_process(args, timeout=self.settings.download_timeout, on_stdout_line=on_line)
        except _TooLarge:
            raise AppError("too_large", "The download exceeded the configured size limit.", status=413,
                           hint="Raise YTC_MAX_DOWNLOAD_MB to allow larger downloads.") from None
        except ExecutableNotFound as exc:
            raise AppError("dependency_missing", "yt-dlp is not installed.", status=500) from exc
        except ProcessTimeout as exc:
            log_failure("download", exc.stderr_tail)
            raise AppError("timeout", "Downloading took longer than the configured limit.", status=504,
                           hint="Raise YTC_DOWNLOAD_TIMEOUT or lower YTC_MAX_HEIGHT.", retryable=True) from exc

        if result.returncode != 0:
            log_failure("download", result)
            raise classify_error(result.stderr_tail, default_code="download_failed")
        if "larger than max-filesize" in result.stderr_tail:
            raise AppError("too_large", "The download exceeded the configured size limit.", status=413)

        files = self._find_outputs(ctx.workdir, choice.format_ids)
        if choice.muxed:
            inputs = [MediaInput(files[0], "muxed")]
        else:
            inputs = [MediaInput(files[0], "video"), MediaInput(files[1], "audio")]
        return AcquiredMedia(inputs=inputs, duration_hint=resolved.details.get("duration"))

    @staticmethod
    def _find_outputs(workdir: Path, format_ids: list[str]) -> list[Path]:
        found = []
        for format_id in format_ids:
            matches = [
                p for p in workdir.glob(f"{format_id}.*")
                if p.is_file() and p.suffix not in _IGNORED_SUFFIXES and p.stat().st_size > 0
            ]
            if not matches:
                raise AppError("download_failed", "yt-dlp finished without producing the media file.",
                               status=502, retryable=True)
            found.append(matches[0])
        return found


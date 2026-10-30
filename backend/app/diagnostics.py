"""The browser check (``/check``): its reports, speed-test payload and drive-lock probe video.

The check page measures what a browser can do for the player (WebCodecs codecs, decode
speed, the connection to this server) and posts the results here, so they can be read on
this computer even when the page ran somewhere else, such as a car's browser through a
tunnel. Reports hold capabilities and timings only: never a location or account data.
The newest ``KEPT_REPORTS`` stay in memory, and each is logged as one line.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
from collections import deque
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import AppError
from .procs import ExecutableNotFound, ProcessTimeout, run_process

log = logging.getLogger(__name__)

MAX_REPORT_BYTES = 64 * 1024
KEPT_REPORTS = 20
MIN_SPEED_BYTES = 1024
MAX_SPEED_BYTES = 32 * 1024 * 1024
_SPEED_CHUNK = 256 * 1024


def _get(data: Any, *path: str) -> Any:
    for key in path:
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data


def summary(report: dict[str, Any]) -> str:
    """One log line with what matters most; every field is optional."""
    supported = {item.get("name"): item.get("supported")
                 for item in [*(_get(report, "video") or []), *(_get(report, "audio") or [])]
                 if isinstance(item, dict)}
    parts = [
        f"chromium={_get(report, 'browser', 'chromium')}",
        f"tesla={_get(report, 'browser', 'tesla')}",
        f"webcodecs={_get(report, 'apis', 'webCodecs')}",
        *(f"{name}={'yes' if ok else 'no'}" for name, ok in supported.items() if name),
    ]
    fps = _get(report, "benchmark", "fps")
    if fps is not None:
        parts.append(f"bench={fps}fps dropped={_get(report, 'benchmark', 'dropped')}")
    mbps = _get(report, "speed", "mbps")
    if mbps is not None:
        parts.append(f"speed={mbps}Mbps")
    return " ".join(str(part) for part in parts)[:2000]


class BrowserReports:
    """The newest reports from ``/check``, in memory."""

    def __init__(self, keep: int = KEPT_REPORTS) -> None:
        self._reports: deque[dict[str, Any]] = deque(maxlen=keep)

    def add(self, body: bytes) -> dict[str, Any]:
        if len(body) > MAX_REPORT_BYTES:
            raise AppError("invalid_input", "The report is too large.", status=413)
        try:
            report = json.loads(body)
        except ValueError:  # includes UnicodeDecodeError
            raise AppError("invalid_input", "The report isn't valid JSON.") from None
        if not isinstance(report, dict):
            raise AppError("invalid_input", "The report must be a JSON object.")
        entry = {"id": secrets.token_hex(3), "received_at": time.time(), "report": report}
        self._reports.append(entry)
        log.info("browser check %s: %s", entry["id"], summary(report))
        return {"id": entry["id"], "received_at": entry["received_at"]}

    def all(self) -> list[dict[str, Any]]:
        """Newest first."""
        return list(reversed(self._reports))


def speed_payload(size: int) -> Iterator[bytes]:
    """``size`` random (so incompressible) bytes, generated as they are sent."""
    left = size
    while left > 0:
        chunk = min(left, _SPEED_CHUNK)
        yield os.urandom(chunk)
        left -= chunk


async def probe_video(settings: Settings) -> Path:
    """A tiny looping clip for the drive-lock probe, made once with FFmpeg."""
    path = settings.data_dir / "diagnostics" / "probe.mp4"
    if path.is_file() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"probe.{os.getpid()}.tmp.mp4")
    args = [
        settings.ffmpeg_path, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=4",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an",
        "-movflags", "+faststart", "-f", "mp4", str(tmp),
    ]
    try:
        result = await run_process(args, timeout=60)
    except ExecutableNotFound as exc:
        raise AppError("dependency_missing", "ffmpeg is required for the drive-lock probe.", status=500,
                       hint="Install FFmpeg and make sure it is on PATH.") from exc
    except ProcessTimeout as exc:
        raise AppError("processing_failed", "Making the probe video timed out.", status=500) from exc
    try:
        if result.returncode != 0:
            log.warning("probe video generation failed: %s", result.stderr_tail[-2000:])
            raise AppError("processing_failed", "Making the probe video failed.", status=500,
                           hint="Check the backend log for the ffmpeg error.")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return path

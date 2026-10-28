"""Safe subprocess execution.

* Commands are argument arrays; nothing is ever passed through a shell.
* Every run has a timeout. On timeout or task cancellation the whole process
  group is terminated (yt-dlp spawns ffmpeg and a JS runtime as children).
* Captured stdout is bounded; stderr keeps only a bounded tail for diagnostics.
"""

from __future__ import annotations

import asyncio
import collections
import logging
import os
import signal
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

DEFAULT_MAX_STDOUT = 64 * 1024 * 1024
STDERR_TAIL_BYTES = 64 * 1024
MAX_LINE_LENGTH = 16 * 1024
_KILL_GRACE_SECONDS = 3.0


class ProcessFailure(Exception):
    """Base class for subprocess problems. ``stderr_tail`` is for logs only."""

    def __init__(self, message: str, *, returncode: int | None = None, stderr_tail: str = "") -> None:
        super().__init__(message)
        self.returncode = returncode
        self.stderr_tail = stderr_tail


class ProcessTimeout(ProcessFailure):
    pass


class OutputLimitExceeded(ProcessFailure):
    pass


class ExecutableNotFound(ProcessFailure):
    pass


@dataclass
class ProcessResult:
    returncode: int
    stdout: bytes
    stderr_tail: str
    elapsed: float


LineCallback = Callable[[str], None]


class _StderrTail:
    def __init__(self, limit: int = STDERR_TAIL_BYTES) -> None:
        self._lines: collections.deque[str] = collections.deque()
        self._size = 0
        self._limit = limit

    def add(self, line: str) -> None:
        self._lines.append(line)
        self._size += len(line)
        while self._size > self._limit and len(self._lines) > 1:
            self._size -= len(self._lines.popleft())

    def text(self) -> str:
        return "\n".join(self._lines)


async def _read_lines(stream: asyncio.StreamReader, callback: LineCallback) -> None:
    """Split a stream into lines without asyncio's readline() length limit."""
    buffer = b""
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            break
        buffer += chunk
        # yt-dlp/ffmpeg progress may use \r; treat it as a line break too.
        buffer = buffer.replace(b"\r", b"\n")
        *lines, buffer = buffer.split(b"\n")
        for raw in lines:
            if raw:
                callback(raw[:MAX_LINE_LENGTH].decode("utf-8", "replace"))
        if len(buffer) > MAX_LINE_LENGTH:
            callback(buffer[:MAX_LINE_LENGTH].decode("utf-8", "replace"))
            buffer = b""
    if buffer:
        callback(buffer[:MAX_LINE_LENGTH].decode("utf-8", "replace"))


def _signal_group(proc: asyncio.subprocess.Process, sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


async def _terminate(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        # The leader exited; still make sure no children linger.
        _signal_group(proc, signal.SIGKILL)
        return
    _signal_group(proc, signal.SIGTERM)
    try:
        await asyncio.wait_for(proc.wait(), timeout=_KILL_GRACE_SECONDS)
    except asyncio.TimeoutError:
        _signal_group(proc, signal.SIGKILL)
        await proc.wait()
    _signal_group(proc, signal.SIGKILL)


async def run_process(
    args: Sequence[str],
    *,
    timeout: float,
    max_stdout: int = DEFAULT_MAX_STDOUT,
    on_stdout_line: LineCallback | None = None,
    on_stderr_line: LineCallback | None = None,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> ProcessResult:
    """Run ``args`` and return its result. Non-zero exit codes are *not* raised.

    If ``on_stdout_line`` is given, stdout is streamed line by line and not
    retained; otherwise up to ``max_stdout`` bytes are collected.
    """
    if isinstance(args, (str, bytes)) or not args or not all(isinstance(a, str) for a in args):
        raise TypeError("args must be a non-empty sequence of strings")

    started = time.monotonic()
    stderr_tail = _StderrTail()
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd) if cwd else None,
            env=env,
            start_new_session=True,
        )
    except FileNotFoundError as exc:
        raise ExecutableNotFound(f"executable not found: {args[0]}") from exc

    stdout_chunks: list[bytes] = []
    stdout_size = 0
    overflow = False

    async def collect_stdout() -> None:
        nonlocal stdout_size, overflow
        assert proc.stdout is not None
        if on_stdout_line is not None:
            await _read_lines(proc.stdout, on_stdout_line)
            return
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                return
            stdout_size += len(chunk)
            if stdout_size > max_stdout:
                overflow = True
                # Kill now: a blocked writer would otherwise keep stderr open.
                _signal_group(proc, signal.SIGKILL)
                return
            stdout_chunks.append(chunk)

    def handle_stderr(line: str) -> None:
        stderr_tail.add(line)
        if on_stderr_line is not None:
            on_stderr_line(line)

    async def collect_stderr() -> None:
        assert proc.stderr is not None
        await _read_lines(proc.stderr, handle_stderr)

    readers = asyncio.gather(collect_stdout(), collect_stderr())
    try:
        try:
            await asyncio.wait_for(asyncio.shield(readers), timeout=timeout)
            if overflow:
                raise OutputLimitExceeded(
                    f"{Path(args[0]).name} produced more than {max_stdout} bytes of output",
                    stderr_tail=stderr_tail.text(),
                )
            remaining = max(0.1, timeout - (time.monotonic() - started))
            await asyncio.wait_for(proc.wait(), timeout=remaining)
        except asyncio.TimeoutError as exc:
            raise ProcessTimeout(
                f"{Path(args[0]).name} timed out after {timeout:.0f}s", stderr_tail=stderr_tail.text()
            ) from exc
    finally:
        if proc.returncode is None or overflow:
            await _terminate(proc)
        readers.cancel()
        try:
            await readers
        except (asyncio.CancelledError, Exception):
            pass

    return ProcessResult(
        returncode=proc.returncode if proc.returncode is not None else -1,
        stdout=b"".join(stdout_chunks),
        stderr_tail=stderr_tail.text(),
        elapsed=time.monotonic() - started,
    )

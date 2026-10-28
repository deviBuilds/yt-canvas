"""HTTP byte-range delivery of prepared media (RFC 9110 §14).

Behaviour:

* No ``Range``                         -> 200 with the full body.
* ``bytes=a-b`` / ``bytes=a-`` / ``bytes=-n`` -> 206 with ``Content-Range``.
* Ranges past the end are clamped; a range starting at/after EOF, or a zero
  suffix, is unsatisfiable -> 416 with ``Content-Range: bytes */size``.
* Malformed ranges, other units, or multiple ranges are ignored -> 200 full
  body (permitted by RFC 9110; media elements only send single ranges).
* ``If-Range`` that doesn't match the current ETag -> 200 full body.

The file is opened and a storage lease taken before the response starts, so a
concurrent eviction can neither delete it mid-stream nor break the open handle.
"""

from __future__ import annotations

import os
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from email.utils import formatdate
from typing import BinaryIO

import anyio
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from .storage import Lease, StoredMedia

CHUNK_SIZE = 256 * 1024
_RANGE_RE = re.compile(r"^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class ByteRange:
    start: int
    end: int  # inclusive

    @property
    def length(self) -> int:
        return self.end - self.start + 1


class Unsatisfiable(Exception):
    pass


def parse_range(header: str | None, size: int) -> ByteRange | None:
    """Parse a single byte range. ``None`` means "serve the full body"."""
    if not header:
        return None
    if "," in header:
        return None  # multiple ranges: ignore and send the full representation
    match = _RANGE_RE.match(header)
    if not match:
        return None
    first, last = match.groups()
    if not first and not last:
        return None
    if not first:
        suffix = int(last)
        if suffix == 0 or size == 0:
            raise Unsatisfiable()
        return ByteRange(max(0, size - suffix), size - 1)
    start = int(first)
    end = int(last) if last else size - 1
    if last and end < start:
        return None  # invalid byte-range-spec: ignore the header
    if start >= size:
        raise Unsatisfiable()
    return ByteRange(start, min(end, size - 1))


def etag_for(stat: os.stat_result) -> str:
    return f'"{stat.st_size:x}-{stat.st_mtime_ns:x}"'


async def _iter_file(handle: BinaryIO, start: int, length: int, lease: Lease) -> AsyncIterator[bytes]:
    try:
        await anyio.to_thread.run_sync(handle.seek, start)
        remaining = length
        while remaining > 0:
            chunk = await anyio.to_thread.run_sync(handle.read, min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
    finally:
        handle.close()
        lease.release()


def media_response(request: Request, stored: StoredMedia, lease: Lease, content_type: str = "video/mp4") -> Response:
    """Build the response; takes ownership of ``lease`` and releases it when done."""
    try:
        handle = stored.path.open("rb")
    except OSError:
        lease.release()
        raise
    stat = os.fstat(handle.fileno())
    size = stat.st_size
    etag = etag_for(stat)
    headers = {
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Last-Modified": formatdate(stat.st_mtime, usegmt=True),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
    }

    def done() -> None:
        handle.close()
        lease.release()

    range_header = request.headers.get("range")
    if_range = request.headers.get("if-range")
    if range_header and if_range and if_range.strip() != etag:
        range_header = None

    try:
        byte_range = parse_range(range_header, size)
    except Unsatisfiable:
        done()
        return Response(
            status_code=416,
            headers={**headers, "Content-Range": f"bytes */{size}"},
        )

    if byte_range is None:
        status, start, length = 200, 0, size
    else:
        status, start, length = 206, byte_range.start, byte_range.length
        headers["Content-Range"] = f"bytes {byte_range.start}-{byte_range.end}/{size}"
    headers["Content-Length"] = str(length)

    if request.method == "HEAD":
        done()
        return Response(status_code=status, headers=headers, media_type=content_type)

    return StreamingResponse(
        _iter_file(handle, start, length, lease),
        status_code=status,
        headers=headers,
        media_type=content_type,
        # Runs even if the client disconnects before the body starts.
        background=BackgroundTask(done),
    )

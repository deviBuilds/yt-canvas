"""Minimal ISO-BMFF top-level box scanner used to verify web-friendly MP4s."""

from __future__ import annotations

import struct
from pathlib import Path


def top_level_boxes(path: Path, limit: int = 64) -> list[tuple[str, int, int]]:
    """Return ``(type, offset, size)`` for up to ``limit`` top-level boxes."""
    boxes: list[tuple[str, int, int]] = []
    file_size = path.stat().st_size
    with path.open("rb") as handle:
        offset = 0
        while offset + 8 <= file_size and len(boxes) < limit:
            handle.seek(offset)
            header = handle.read(8)
            if len(header) < 8:
                break
            size, box_type = struct.unpack(">I4s", header)
            if size == 1:
                large = handle.read(8)
                if len(large) < 8:
                    break
                size = struct.unpack(">Q", large)[0]
            elif size == 0:
                size = file_size - offset
            if size < 8:
                break
            boxes.append((box_type.decode("latin-1"), offset, size))
            offset += size
    return boxes


def is_faststart(path: Path) -> bool:
    """True if the ``moov`` index precedes ``mdat`` so playback can start before the end loads."""
    types = [box for box, _, _ in top_level_boxes(path)]
    if "moov" not in types or "mdat" not in types:
        return False
    return types.index("moov") < types.index("mdat")

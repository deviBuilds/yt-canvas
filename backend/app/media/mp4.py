"""Minimal ISO-BMFF top-level box scanner used to verify web-friendly MP4s."""

from __future__ import annotations

import struct
from dataclasses import dataclass
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


# -- in-memory box walking and codec strings (for MSE ``codecs=`` parameters) ----------

_CONTAINERS = {"moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "udta"}
# Bytes between a sample entry's box header and its child boxes (ISO/IEC 14496-12 §12.1.3/§12.2.3).
_SAMPLE_ENTRY_FIELDS = {"avc1": 78, "avc3": 78, "mp4a": 28}


def iter_boxes(data: bytes, start: int = 0, end: int | None = None):
    """Yield ``(type, payload_start, payload_end)`` for the boxes laid out in ``data[start:end]``."""
    end = len(data) if end is None else min(end, len(data))
    offset = start
    while offset + 8 <= end:
        size, box_type = struct.unpack_from(">I4s", data, offset)
        header = 8
        if size == 1:
            if offset + 16 > end:
                return
            size = struct.unpack_from(">Q", data, offset + 8)[0]
            header = 16
        elif size == 0:
            size = end - offset
        if size < header or offset + size > end:
            return
        yield box_type.decode("latin-1"), offset + header, offset + size
        offset += size


def find_box(data: bytes, path: list[str], start: int = 0, end: int | None = None) -> tuple[int, int] | None:
    """``(payload_start, payload_end)`` of the first box at ``path`` (e.g. ``["moov", "trak"]``)."""
    for box_type, payload_start, payload_end in iter_boxes(data, start, end):
        if box_type != path[0]:
            continue
        if len(path) == 1:
            return payload_start, payload_end
        if box_type in _CONTAINERS:
            found = find_box(data, path[1:], payload_start, payload_end)
            if found is not None:
                return found
    return None


def read_moov(path: Path) -> bytes:
    """The bytes of the top-level ``moov`` box (header included)."""
    for box_type, offset, size in top_level_boxes(path):
        if box_type == "moov":
            with path.open("rb") as handle:
                handle.seek(offset)
                return handle.read(size)
    raise ValueError("no moov box")


def _descriptor(data: bytes, offset: int) -> tuple[int, int, int]:
    """Parse an MPEG-4 descriptor header: ``(tag, payload_start, payload_end)``."""
    tag = data[offset]
    offset += 1
    size = 0
    for _ in range(4):
        byte = data[offset]
        offset += 1
        size = (size << 7) | (byte & 0x7F)
        if not byte & 0x80:
            break
    return tag, offset, offset + size


def _aac_codec(data: bytes, start: int, end: int) -> str:
    """``mp4a.OO.A`` from an ``esds`` payload: object type indication and audio object type."""
    tag, pos, _ = _descriptor(data, start + 4)  # skip version + flags
    if tag != 0x03:
        raise ValueError("esds has no ES_Descriptor")
    flags = data[pos + 2]
    pos += 3
    if flags & 0x80:  # streamDependenceFlag
        pos += 2
    if flags & 0x40:  # URL_Flag
        pos += 1 + data[pos]
    if flags & 0x20:  # OCRstreamFlag
        pos += 2
    tag, pos, _ = _descriptor(data, pos)
    if tag != 0x04:
        raise ValueError("esds has no DecoderConfigDescriptor")
    object_type = data[pos]
    tag, dsi, _ = _descriptor(data, pos + 13)
    if tag != 0x05:
        return f"mp4a.{object_type:02x}"
    audio_object_type = data[dsi] >> 3
    if audio_object_type == 31:
        audio_object_type = 32 + (((data[dsi] & 0x07) << 3) | (data[dsi + 1] >> 5))
    return f"mp4a.{object_type:02x}.{audio_object_type}"


def codec_string(path: Path) -> str:
    """RFC 6381 codec string of the first track, e.g. ``avc1.64001e`` or ``mp4a.40.2``.

    Read from the file's own ``avcC`` / ``esds`` boxes, so it always matches the encoder output.
    """
    moov = read_moov(path)
    stsd = find_box(moov, ["moov", "trak", "mdia", "minf", "stbl", "stsd"])
    if stsd is None:
        raise ValueError("no stsd box")
    entries = iter_boxes(moov, stsd[0] + 8, stsd[1])  # skip version/flags + entry_count
    entry_type, entry_start, entry_end = next(entries)
    fields = _SAMPLE_ENTRY_FIELDS.get(entry_type)
    if fields is None:
        raise ValueError(f"unsupported sample entry {entry_type!r}")
    children = entry_start + fields
    if entry_type in ("avc1", "avc3"):
        avcc = find_box(moov, ["avcC"], children, entry_end)
        if avcc is None:
            raise ValueError("no avcC box")
        profile, compatibility, level = moov[avcc[0] + 1:avcc[0] + 4]
        return f"{entry_type}.{profile:02x}{compatibility:02x}{level:02x}"
    esds = find_box(moov, ["esds"], children, entry_end)
    if esds is None:
        raise ValueError("no esds box")
    return _aac_codec(moov, *esds)


@dataclass(frozen=True)
class SidxReference:
    referenced_size: int
    subsegment_duration: int
    starts_with_sap: bool


@dataclass(frozen=True)
class Sidx:
    """A segment index (ISO/IEC 14496-12 §8.16.3); offsets are relative to the end of the box."""

    timescale: int
    earliest_presentation_time: int
    first_offset: int
    references: tuple[SidxReference, ...]

    @property
    def duration(self) -> float:
        return sum(r.subsegment_duration for r in self.references) / self.timescale if self.timescale else 0.0


def parse_sidx(payload: bytes) -> Sidx:
    """Parse a ``sidx`` box payload (the bytes after its 8-byte header)."""
    version = payload[0]
    timescale = struct.unpack_from(">I", payload, 8)[0]
    if version == 0:
        earliest, first_offset = struct.unpack_from(">II", payload, 12)
        pos = 20
    else:
        earliest, first_offset = struct.unpack_from(">QQ", payload, 12)
        pos = 28
    count = struct.unpack_from(">H", payload, pos + 2)[0]
    references = []
    for i in range(count):
        word, duration, sap = struct.unpack_from(">III", payload, pos + 4 + 12 * i)
        references.append(SidxReference(word & 0x7FFFFFFF, duration, bool(sap >> 31)))
    return Sidx(timescale, earliest, first_offset, tuple(references))


def read_sidx(path: Path) -> Sidx:
    """The first top-level ``sidx`` box of ``path``."""
    for box_type, offset, size in top_level_boxes(path, limit=8):
        if box_type == "sidx":
            with path.open("rb") as handle:
                handle.seek(offset + 8)
                return parse_sidx(handle.read(size - 8))
    raise ValueError("no top-level sidx box")

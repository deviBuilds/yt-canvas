"""Choose which YouTube formats to download for browser playback.

YouTube usually serves separate video-only and audio-only tracks (DASH/HLS),
and the container says little about the codec: an ``mp4`` may hold AV1 and a
``webm`` VP9. Selection therefore looks at codec strings, not extensions.

Preference order (each at the highest height <= ``max_height``):

1. H.264 video-only + AAC audio-only  -> remux, no re-encoding
2. H.264+AAC progressive (muxed)       -> remux
3. H.264 video + other audio           -> copy video, transcode audio
4. VP9/AV1/HEVC video + audio          -> transcode video (and audio if needed)
5. any other muxed format              -> transcode as needed

If the estimate exceeds ``max_bytes`` the next lower candidate is tried.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

_ALLOWED_PROTOCOLS = {"https", "http", "m3u8_native", "m3u8", "http_dash_segments"}


def video_family(vcodec: Any) -> str | None:
    if not isinstance(vcodec, str) or vcodec in ("", "none"):
        return None
    codec = vcodec.lower()
    if codec.startswith(("avc1", "avc3", "h264")):
        return "h264"
    if codec.startswith(("vp09", "vp9")):
        return "vp9"
    if codec.startswith("av01"):
        return "av1"
    if codec.startswith(("hev1", "hvc1", "h265", "hevc")):
        return "hevc"
    if codec.startswith(("vp8", "vp08")):
        return "vp8"
    return "other"


def audio_family(acodec: Any) -> str | None:
    if not isinstance(acodec, str) or acodec in ("", "none"):
        return None
    codec = acodec.lower()
    if codec.startswith(("mp4a", "aac")):
        return "aac"
    if codec.startswith("opus"):
        return "opus"
    if codec.startswith(("mp3", "mp4a.6b", "mp4a.69")):
        return "mp3"
    if codec.startswith("vorbis"):
        return "vorbis"
    if codec.startswith(("ac-3", "ec-3", "ac3", "eac3")):
        return "ac3"
    return "other"


def _is_none(value: Any) -> bool:
    return value == "none"


def _usable(fmt: dict[str, Any]) -> bool:
    if not isinstance(fmt, dict) or not fmt.get("format_id"):
        return False
    if fmt.get("has_drm") or fmt.get("ext") == "mhtml" or "storyboard" in str(fmt.get("format_note", "")):
        return False
    if fmt.get("protocol") not in _ALLOWED_PROTOCOLS:
        return False
    if not (fmt.get("url") or fmt.get("fragments") or fmt.get("manifest_url")):
        return False
    return True


def _size(fmt: dict[str, Any], duration: float | None) -> int | None:
    for key in ("filesize", "filesize_approx"):
        value = fmt.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return int(value)
    tbr = fmt.get("tbr")
    if isinstance(tbr, (int, float)) and tbr > 0 and duration:
        return int(tbr * 1000 / 8 * duration)
    return None


def _num(value: Any, default: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


@dataclass
class FormatChoice:
    format_ids: list[str]
    video_format: dict[str, Any]
    audio_format: dict[str, Any] | None
    muxed: bool
    copy_video: bool
    copy_audio: bool
    estimated_bytes: int | None
    height: int | None

    @property
    def strategy(self) -> str:
        if self.copy_video and self.copy_audio:
            return "remux"
        if self.copy_video:
            return "transcode_audio"
        return "transcode"


def _video_key(fmt: dict[str, Any]) -> tuple:
    hdr = str(fmt.get("dynamic_range") or "SDR").upper() != "SDR"
    return (
        _num(fmt.get("height")),
        not hdr,
        _num(fmt.get("fps"), 30.0),
        fmt.get("protocol") in ("https", "http"),
        _num(fmt.get("tbr")),
    )


def _audio_key(fmt: dict[str, Any]) -> tuple:
    format_id = str(fmt.get("format_id", ""))
    note = str(fmt.get("format_note", "")).lower()
    return (
        audio_family(fmt.get("acodec")) == "aac",
        "drc" not in format_id.lower() and "drc" not in note,
        _num(fmt.get("language_preference"), 0.0),
        "original" in note or "default" in note,
        # Stereo plays everywhere and is a fraction of the size of 5.1 tracks.
        _num(fmt.get("audio_channels"), 2.0) <= 2,
        fmt.get("protocol") in ("https", "http"),
        min(_num(fmt.get("abr")), 192.0),
        _num(fmt.get("asr")),
    )


def select_formats(
    formats: list[dict[str, Any]] | None,
    *,
    max_height: int = 720,
    max_bytes: int | None = None,
    duration: float | None = None,
) -> FormatChoice | None:
    """Return the best :class:`FormatChoice`, or ``None`` if nothing is usable.

    Raises ``ValueError("too_large")`` if usable formats exist but none fits
    ``max_bytes``.
    """
    usable = [f for f in (formats or []) if _usable(f)]
    video_only, audio_only, muxed = [], [], []
    for fmt in usable:
        vfam, afam = video_family(fmt.get("vcodec")), audio_family(fmt.get("acodec"))
        height = fmt.get("height")
        if vfam and _is_none(fmt.get("acodec")):
            if isinstance(height, (int, float)) and 0 < height <= max_height:
                video_only.append(fmt)
        elif afam and _is_none(fmt.get("vcodec")):
            audio_only.append(fmt)
        elif vfam and afam:
            if isinstance(height, (int, float)) and 0 < height <= max_height:
                muxed.append(fmt)

    video_only.sort(key=_video_key, reverse=True)
    muxed.sort(key=_video_key, reverse=True)
    audio_only.sort(key=_audio_key, reverse=True)
    best_audio = audio_only[0] if audio_only else None

    candidates: list[FormatChoice] = []

    def add_split(video: dict[str, Any]) -> None:
        if best_audio is None:
            return
        sizes = [_size(video, duration), _size(best_audio, duration)]
        candidates.append(
            FormatChoice(
                format_ids=[str(video["format_id"]), str(best_audio["format_id"])],
                video_format=video,
                audio_format=best_audio,
                muxed=False,
                copy_video=video_family(video.get("vcodec")) == "h264",
                copy_audio=audio_family(best_audio.get("acodec")) == "aac",
                estimated_bytes=sum(sizes) if all(s is not None for s in sizes) else None,  # type: ignore[arg-type]
                height=int(video["height"]),
            )
        )

    def add_muxed(fmt: dict[str, Any]) -> None:
        candidates.append(
            FormatChoice(
                format_ids=[str(fmt["format_id"])],
                video_format=fmt,
                audio_format=None,
                muxed=True,
                copy_video=video_family(fmt.get("vcodec")) == "h264",
                copy_audio=audio_family(fmt.get("acodec")) == "aac",
                estimated_bytes=_size(fmt, duration),
                height=int(fmt["height"]),
            )
        )

    h264_video = [f for f in video_only if video_family(f.get("vcodec")) == "h264"]
    other_video = [f for f in video_only if video_family(f.get("vcodec")) != "h264"]
    h264_muxed = [f for f in muxed if video_family(f.get("vcodec")) == "h264"]
    other_muxed = [f for f in muxed if video_family(f.get("vcodec")) != "h264"]

    if best_audio is not None and audio_family(best_audio.get("acodec")) == "aac":
        for fmt in h264_video:
            add_split(fmt)
    for fmt in h264_muxed:
        if audio_family(fmt.get("acodec")) == "aac":
            add_muxed(fmt)
    if best_audio is not None and audio_family(best_audio.get("acodec")) != "aac":
        for fmt in h264_video:
            add_split(fmt)
    for fmt in other_video:
        add_split(fmt)
    for fmt in h264_muxed + other_muxed:
        if not any(c.muxed and c.video_format is fmt for c in candidates):
            add_muxed(fmt)

    if not candidates:
        return None
    if max_bytes is None:
        return candidates[0]
    for choice in candidates:
        if choice.estimated_bytes is None or choice.estimated_bytes <= max_bytes:
            return choice
    raise ValueError("too_large")

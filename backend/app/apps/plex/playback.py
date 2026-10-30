"""Playing Plex movies and episodes, and telling Plex how far people got.

Direct play, when the browser can decode the file: the original is read through
``/sessions/<id>/file`` in byte ranges (at most 16 MiB per request, nothing stored).
Otherwise Plex's universal transcoder makes DASH (fragmented MP4 segments), copying the
video when the browser can decode it and converting what it can't (such as DTS audio);
the manifest and segments go through ``/sessions/<id>/dash/``. Either way the browser
never sees the server's address or a token.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel

from ...errors import AppError
from .client import PlexResponse, send
from .library import PlexMedia, media
from .service import PlexService

log = logging.getLogger(__name__)

DIRECT_CONTAINERS = {"mkv": "matroska", "webm": "matroska", "mp4": "mp4", "m4v": "mp4", "mov": "mp4"}
CODEC_NAMES = {"h264": "H.264", "hevc": "HEVC", "av1": "AV1", "vp9": "VP9", "mpeg2video": "MPEG-2", "vc1": "VC-1",
               "mpeg4": "MPEG-4", "aac": "AAC", "ac3": "AC-3", "eac3": "E-AC-3", "dca": "DTS", "dts": "DTS",
               "truehd": "TrueHD", "mp3": "MP3", "opus": "Opus", "flac": "FLAC", "vorbis": "Vorbis", "pcm": "PCM"}
MAX_RANGE_BYTES = 16 * 1024 * 1024
SESSION_TTL = 6 * 60 * 60
# A segment the transcoder hasn't written yet: Plex may answer 404 or 503 for a moment.
SEGMENT_WAIT_SECONDS = 30


class Capabilities(BaseModel):
    """What this browser decodes, in Plex's codec names (h264, hevc, av1, vp9; aac, mp3, opus, flac)."""

    video: list[str] = []
    audio: list[str] = []


class PlayRequest(BaseModel):
    key: str
    media_index: int = 0
    # A Plex stream id; otherwise the file's selected or default audio track.
    audio_stream: int | None = None
    # The quality menu's choice; None means Original.
    max_bitrate_kbps: int | None = None
    capabilities: Capabilities


class PlayResponse(BaseModel):
    session: str
    mode: Literal["direct", "transcode"]
    # The original file (direct) or the DASH manifest (transcode), on this server.
    url: str
    # Direct play: "matroska" or "mp4", and the audio track's number in the file.
    container: str | None = None
    audio_track: int | None = None
    duration_seconds: int | None = None
    view_offset_seconds: int | None = None
    # Why this mode, for the player's details.
    reason: str


@dataclass
class Session:
    id: str
    mode: str
    rating_key: str
    part_key: str | None = None
    plex_session: str | None = None
    manifest: bytes | None = None
    used: float = field(default_factory=time.time)


def _name(codec: str | None) -> str:
    return CODEC_NAMES.get((codec or "").lower(), (codec or "unknown").upper())


def chosen_audio(item: PlexMedia, stream_id: int | None):
    audios = [s for s in item.streams if s.kind == "audio"]
    if stream_id is not None:
        return next((s for s in audios if s.id == stream_id), None)
    return next((s for s in audios if s.selected), None) or next((s for s in audios if s.default), None) or (audios[0] if audios else None)


def decide(item: PlexMedia, request: PlayRequest) -> tuple[str, str]:
    """("direct" | "transcode", why) for this file in this browser."""
    container = (item.container or "").lower()
    video = (item.video_codec or "").lower()
    audio = chosen_audio(item, request.audio_stream)
    audio_codec = (audio.codec if audio else item.audio_codec or "").lower()
    caps = request.capabilities
    video_ok = video in caps.video
    if request.max_bitrate_kbps and item.bitrate_kbps and item.bitrate_kbps > request.max_bitrate_kbps:
        return "transcode", f"Plex converts it to stay under the {request.max_bitrate_kbps / 1000:g} Mbit/s you chose."
    if not video_ok:
        return "transcode", f"This browser can't decode {_name(video)} video, so Plex converts it."
    if audio_codec and audio_codec not in caps.audio:
        return "transcode", f"This browser can't decode {_name(audio_codec)} audio, so Plex converts the audio and copies the video."
    if container not in DIRECT_CONTAINERS:
        return "transcode", f"{container.upper() or 'This'} files go through Plex, which copies the video and audio into segments."
    return "direct", "Plays the original file."


def transcode_params(request: PlayRequest, plex_session: str) -> tuple[dict[str, Any], dict[str, str]]:
    """Query parameters and headers for Plex's universal transcoder, asking for DASH."""
    video_codecs = [c for c in ("h264", "hevc") if c in request.capabilities.video] or ["h264"]
    profile = "+".join([
        f"add-transcode-target(type=videoProfile&context=streaming&protocol=dash&container=mp4"
        f"&videoCodec={','.join(video_codecs)}&audioCodec=aac)",
        "add-transcode-target-audio-codec(type=videoProfile&context=streaming&protocol=dash&audioCodec=aac)",
    ])
    params: dict[str, Any] = {
        "path": f"/library/metadata/{request.key}",
        "mediaIndex": request.media_index,
        "partIndex": 0,
        "protocol": "dash",
        "fastSeek": 1,
        "directPlay": 0,
        "directStream": 1,
        "directStreamAudio": 1,
        "subtitleSize": 100,
        "audioBoost": 100,
        "location": "lan",
        "autoAdjustQuality": 0,
        "mediaBufferSize": 102400,
        "session": plex_session,
        "copyts": 1,
        "offset": 0,
        "videoQuality": 100,
    }
    if request.max_bitrate_kbps:
        kbps = request.max_bitrate_kbps
        params.update(videoBitrate=kbps, maxVideoBitrate=kbps,
                      videoResolution="1920x1080" if kbps >= 4000 else "1280x720" if kbps >= 2000 else "854x480")
    else:
        params.update(maxVideoBitrate=200000, videoResolution="3840x2160")
    headers = {"X-Plex-Session-Identifier": plex_session, "X-Plex-Client-Profile-Extra": profile,
               "Accept": "application/dash+xml,*/*"}
    return params, headers


def clean_manifest(manifest: bytes, server_uri: str) -> bytes:
    """Keep the manifest relative to our proxy: no server address, no token."""
    text = manifest.decode("utf-8", "replace")
    text = text.replace(server_uri.rstrip("/") + "/video/:/transcode/universal/", "")
    text = re.sub(r"([?&])X-Plex-Token=[^&\"'<\s]*&?", r"\1", text)
    return text.encode("utf-8")


def parse_range(header: str | None) -> tuple[int, int | None]:
    match = re.fullmatch(r"bytes=(\d+)-(\d*)", (header or "").strip())
    if not match:
        return 0, None
    return int(match.group(1)), int(match.group(2)) if match.group(2) else None


class PlexPlayback:
    def __init__(self, plex: PlexService) -> None:
        self.plex = plex
        self.sessions: dict[str, Session] = {}

    def session(self, session_id: str) -> Session:
        session = self.sessions.get(session_id)
        if session is None:
            raise AppError("stream_expired", "This Plex playback session ended.", status=410, hint="Play it again.")
        session.used = time.time()
        return session

    def _prune(self) -> None:
        cutoff = time.time() - SESSION_TTL
        for key in [key for key, session in self.sessions.items() if session.used < cutoff]:
            del self.sessions[key]

    async def play(self, request: PlayRequest) -> PlayResponse:
        found = (await self.plex.json(f"/library/metadata/{request.key}", what="item")).get("Metadata") or []
        if not found or found[0].get("type") not in ("movie", "episode"):
            raise AppError("not_found", "Only movies and episodes can be played.", status=404)
        raw = found[0]
        raw_media = raw.get("Media") or []
        if request.media_index >= len(raw_media):
            raise AppError("not_found", "That version of the item doesn't exist.", status=404)
        item = media(raw_media[request.media_index])
        mode, reason = decide(item, request)
        self._prune()
        session_id = secrets.token_urlsafe(9)
        base = dict(duration_seconds=round(raw["duration"] / 1000) if raw.get("duration") else None,
                    view_offset_seconds=round(raw["viewOffset"] / 1000) if raw.get("viewOffset") else None, reason=reason)

        if mode == "direct":
            part_key = (raw_media[request.media_index].get("Part") or [{}])[0].get("key")
            if not part_key:
                raise AppError("not_found", "Plex has no file for this item.", status=404)
            self.sessions[session_id] = Session(session_id, "direct", request.key, part_key=part_key)
            audio = chosen_audio(item, request.audio_stream)
            return PlayResponse(session=session_id, mode="direct", url=f"/api/apps/plex/sessions/{session_id}/file",
                                container=DIRECT_CONTAINERS[(item.container or "").lower()],
                                audio_track=audio.index + 1 if audio and audio.index is not None else None, **base)

        if request.audio_stream is not None and item.part_id is not None:
            # Plex's transcoder uses the part's selected audio track.
            response = await send("PUT", self.plex.server_url(f"/library/parts/{item.part_id}",
                                                              {"audioStreamID": request.audio_stream, "allParts": 1}),
                                  self.plex.server_headers())
            if response.status >= 400:
                log.warning("Plex didn't take the audio track choice (%s)", response.status)
        plex_session = str(uuid.uuid4())
        params, headers = transcode_params(request, plex_session)
        response = await self.plex.get("/video/:/transcode/universal/start.mpd", params, what="video", headers=headers,
                                       timeout=60)
        manifest = clean_manifest(response.body, self.plex.server_url(""))
        self.sessions[session_id] = Session(session_id, "transcode", request.key, plex_session=plex_session,
                                            manifest=manifest)
        log.info("Plex transcode session for item %s: %s", request.key, reason)
        return PlayResponse(session=session_id, mode="transcode",
                            url=f"/api/apps/plex/sessions/{session_id}/dash/start.mpd", **base)

    async def file_range(self, session_id: str, range_header: str | None) -> PlexResponse:
        session = self.session(session_id)
        if session.mode != "direct" or not session.part_key:
            raise AppError("not_found", "This session has no file.", status=404)
        start, end = parse_range(range_header)
        end = start + MAX_RANGE_BYTES - 1 if end is None else min(end, start + MAX_RANGE_BYTES - 1)
        response = await send("GET", self.plex.server_url(session.part_key),
                              self.plex.server_headers(Range=f"bytes={start}-{end}", Accept="*/*"), timeout=60)
        if response.status not in (200, 206, 416):
            raise AppError("plex_error", f"Plex couldn't send the file ({response.status}).", status=502, retryable=True)
        return response

    async def dash(self, session_id: str, path: str, query: str) -> tuple[bytes, str]:
        session = self.session(session_id)
        if session.mode != "transcode" or not session.plex_session:
            raise AppError("not_found", "This session isn't transcoded.", status=404)
        if path == "start.mpd":
            return session.manifest or b"", "application/dash+xml"
        if not path.startswith(f"session/{session.plex_session}/"):
            raise AppError("not_found", "Not part of this playback session.", status=404)
        url = self.plex.server_url(f"/video/:/transcode/universal/{path}") + (f"?{query}" if query else "")
        headers = self.plex.server_headers(Accept="*/*", **{"X-Plex-Session-Identifier": session.plex_session})
        deadline = time.time() + SEGMENT_WAIT_SECONDS
        while True:
            response = await send("GET", url, headers, timeout=60)
            if 200 <= response.status < 300:
                return response.body, response.header("Content-Type") or "video/mp4"
            if response.status in (404, 503) and time.time() < deadline:
                await asyncio.sleep(0.5)  # the transcoder is still writing it
                continue
            raise AppError("plex_error", f"Plex couldn't send a video segment ({response.status}).", status=502,
                           retryable=True)

    async def ping(self, session_id: str) -> None:
        session = self.session(session_id)
        if session.plex_session:
            await send("GET", self.plex.server_url("/video/:/transcode/universal/ping", {"session": session.plex_session}),
                       self.plex.server_headers())

    async def stop(self, session_id: str) -> None:
        session = self.sessions.pop(session_id, None)
        if session and session.plex_session:
            try:
                await send("GET", self.plex.server_url("/video/:/transcode/universal/stop",
                                                       {"session": session.plex_session}), self.plex.server_headers())
            except AppError:
                pass  # Plex ends idle transcodes on its own

    async def timeline(self, key: str, state: str, time_seconds: float, duration_seconds: float | None,
                       session_id: str | None) -> None:
        """Report progress, so Continue Watching and watched status follow (Plex marks watched near the end)."""
        session = self.sessions.get(session_id or "")
        headers = self.plex.server_headers(**({"X-Plex-Session-Identifier": session.plex_session}
                                              if session and session.plex_session else {}))
        params = {"ratingKey": key, "key": f"/library/metadata/{key}", "state": state,
                  "time": round(time_seconds * 1000), "identifier": "com.plexapp.plugins.library",
                  "duration": round(duration_seconds * 1000) if duration_seconds else None}
        response = await send("GET", self.plex.server_url("/:/timeline", params), headers)
        if response.status >= 400:
            log.warning("Plex didn't take the progress report (%s)", response.status)

    async def stop_all(self) -> None:
        for session_id in list(self.sessions):
            await self.stop(session_id)

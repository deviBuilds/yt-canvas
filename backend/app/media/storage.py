"""Local storage for prepared media: safe paths, limits, eviction and leases.

Layout under ``settings.data_dir``::

    media/<media_id>.mp4    prepared, web-ready file
    media/<media_id>.json   sidecar metadata (MediaInfo + VideoSummary)
    work/<job_id>/          per-job scratch space, removed when the job ends

A *lease* is held while a file is being delivered; leased files are never
evicted. Last access is recorded in the file's *atime* (set explicitly, so
``noatime`` mounts don't matter) so LRU order survives restarts, while the
mtime stays fixed at commit time and keeps ETag/Last-Modified stable.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import shutil
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

from ..config import Settings
from ..errors import AppError

log = logging.getLogger(__name__)

MEDIA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass
class StoredMedia:
    media_id: str
    path: Path
    size: int
    meta: dict


class Lease:
    def __init__(self, storage: MediaStorage, media_id: str) -> None:
        self._storage = storage
        self.media_id = media_id
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._storage._release(self.media_id)


class MediaStorage:
    def __init__(self, settings: Settings, clock: Callable[[], float] = time.time) -> None:
        self.settings = settings
        self.media_dir = settings.media_dir
        self.work_dir = settings.work_dir
        self._clock = clock
        self._leases: dict[str, int] = {}
        self._lock = threading.Lock()

    def init(self) -> None:
        for directory in (self.media_dir, self.work_dir, self.settings.ytdlp_cache_dir):
            directory.mkdir(parents=True, exist_ok=True)
        # Leftovers from a previous run are never valid.
        for child in self.work_dir.iterdir():
            shutil.rmtree(child, ignore_errors=True)
        for partial in self.media_dir.glob("*.tmp*"):
            partial.unlink(missing_ok=True)

    # -- paths -------------------------------------------------------------

    def _media_path(self, media_id: str, suffix: str) -> Path:
        if not MEDIA_ID_RE.match(media_id):
            raise AppError("not_found", "Unknown media.", status=404)
        path = (self.media_dir / f"{media_id}{suffix}").resolve()
        if path.parent != self.media_dir.resolve():
            raise AppError("not_found", "Unknown media.", status=404)
        return path

    def media_path(self, media_id: str) -> Path:
        return self._media_path(media_id, ".mp4")

    def create_workdir(self, job_id: str) -> Path:
        if not JOB_ID_RE.match(job_id):
            raise ValueError("invalid job id")
        path = self.work_dir / job_id
        path.mkdir(parents=True, exist_ok=False)
        return path

    def remove_workdir(self, path: Path | None) -> None:
        if path is None:
            return
        if path.resolve().parent != self.work_dir.resolve():
            log.error("refusing to remove unexpected path %s", path)
            return
        shutil.rmtree(path, ignore_errors=True)

    # -- lookup --------------------------------------------------------------

    def get(self, media_id: str) -> StoredMedia | None:
        try:
            path = self.media_path(media_id)
            meta_path = self._media_path(media_id, ".json")
        except AppError:
            return None
        try:
            size = path.stat().st_size
            meta = json.loads(meta_path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        return StoredMedia(media_id=media_id, path=path, size=size, meta=meta)

    def touch(self, media_id: str) -> None:
        """Record an access (atime only; mtime is the stable content version)."""
        with contextlib.suppress(OSError, AppError):
            path = self.media_path(media_id)
            mtime_ns = path.stat().st_mtime_ns
            os.utime(path, ns=(int(self._clock() * 1e9), mtime_ns))

    def commit(self, media_id: str, source: Path, meta: dict) -> StoredMedia:
        """Atomically move a finished file into the cache together with its metadata."""
        final = self.media_path(media_id)
        meta_path = self._media_path(media_id, ".json")
        tmp_meta = meta_path.with_suffix(".json.tmp")
        tmp_meta.write_text(json.dumps(meta), "utf-8")
        os.replace(source, final)
        os.replace(tmp_meta, meta_path)
        self.touch(media_id)
        return StoredMedia(media_id=media_id, path=final, size=final.stat().st_size, meta=meta)

    # -- leases --------------------------------------------------------------

    def lease(self, media_id: str) -> Lease:
        with self._lock:
            self._leases[media_id] = self._leases.get(media_id, 0) + 1
        self.touch(media_id)
        return Lease(self, media_id)

    def _release(self, media_id: str) -> None:
        with self._lock:
            count = self._leases.get(media_id, 0) - 1
            if count <= 0:
                self._leases.pop(media_id, None)
            else:
                self._leases[media_id] = count

    def is_leased(self, media_id: str) -> bool:
        with self._lock:
            return self._leases.get(media_id, 0) > 0

    @contextlib.contextmanager
    def leased(self, media_id: str) -> Iterator[Lease]:
        lease = self.lease(media_id)
        try:
            yield lease
        finally:
            lease.release()

    # -- limits & eviction ---------------------------------------------------

    def _entries(self) -> list[tuple[str, Path, int, float]]:
        entries = []
        for path in self.media_dir.glob("*.mp4"):
            try:
                stat = path.stat()
            except OSError:
                continue
            entries.append((path.stem, path, stat.st_size, stat.st_atime))
        return entries

    def usage_bytes(self) -> int:
        return sum(size for _, _, size, _ in self._entries())

    def _delete(self, media_id: str, path: Path) -> bool:
        if self.is_leased(media_id):
            return False
        path.unlink(missing_ok=True)
        path.with_suffix(".json").unlink(missing_ok=True)
        log.info("evicted cached media %s", media_id)
        return True

    def evict_expired(self) -> int:
        cutoff = self._clock() - self.settings.cache_ttl_seconds
        removed = 0
        for media_id, path, _, last_access in self._entries():
            if last_access < cutoff and self._delete(media_id, path):
                removed += 1
        # Sidecars without media are garbage.
        for meta in self.media_dir.glob("*.json"):
            if not meta.with_suffix(".mp4").exists():
                meta.unlink(missing_ok=True)
        return removed

    def ensure_capacity(self, needed_bytes: int, protect: set[str] | None = None) -> None:
        """Evict least-recently-used, unleased media until ``needed_bytes`` fits.

        Raises ``AppError('storage_full')`` if the cache or disk cannot make room.
        """
        protect = protect or set()
        limit = self.settings.cache_max_bytes
        if needed_bytes > limit:
            raise AppError(
                "too_large",
                "This video is larger than the configured cache size.",
                status=413,
                hint="Raise YTC_CACHE_MAX_MB or lower YTC_MAX_HEIGHT.",
            )
        entries = sorted(self._entries(), key=lambda e: e[3])
        usage = sum(e[2] for e in entries)
        for media_id, path, size, _ in entries:
            if usage + needed_bytes <= limit:
                break
            if media_id in protect:
                continue
            if self._delete(media_id, path):
                usage -= size
        if usage + needed_bytes > limit:
            raise AppError(
                "storage_full",
                "The media cache is full of videos that are currently playing.",
                status=507,
                hint="Try again when other playback has finished, or raise YTC_CACHE_MAX_MB.",
                retryable=True,
            )
        # Source files and the processed output coexist briefly: reserve twice the size.
        free = shutil.disk_usage(self.settings.data_dir).free
        if free - 2 * needed_bytes < self.settings.min_free_disk_bytes:
            raise AppError(
                "storage_full",
                "Not enough free disk space to prepare this video.",
                status=507,
                hint="Free up disk space or lower YTC_MIN_FREE_DISK_MB.",
                retryable=True,
            )

    def cleanup_workdirs(self, active_job_ids: set[str]) -> None:
        for child in self.work_dir.iterdir():
            if child.name not in active_job_ids:
                shutil.rmtree(child, ignore_errors=True)

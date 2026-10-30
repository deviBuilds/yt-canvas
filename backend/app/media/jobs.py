"""Background preparation jobs.

States: ``queued -> resolving -> downloading -> processing -> ready``, or
``failed`` from any state (including cancellation).

* Identical requests (same source, reference and profile) share one job.
* At most ``max_concurrent_jobs`` run at once; at most ``max_queued_jobs``
  wait. Further requests are rejected with ``busy``.
* A file already present in the cache yields an immediately ``ready`` job.
* A failed job is kept for inspection; submitting again starts a fresh one.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import ValidationError

from ..config import Settings
from ..errors import AppError
from ..models import VideoSummary
from ..session import session_tag
from .ffmpeg import ProcessedMedia, process_to_mp4
from .models import JobErrorInfo, JobProgress, JobState, JobView, MediaInfo
from .provider import MediaSourceProvider, ProgressCallback
from .storage import MediaStorage

log = logging.getLogger(__name__)

Processor = Callable[..., Awaitable[ProcessedMedia]]
_DEFAULT_ESTIMATE = 256 * 1024 * 1024
_FINISHED_JOB_RETENTION = 60 * 60


@dataclass
class Job:
    id: str
    key: str
    source: str
    ref: str
    media_id: str
    created_at: float
    updated_at: float
    state: JobState = JobState.QUEUED
    progress: JobProgress = field(default_factory=JobProgress)
    error: JobErrorInfo | None = None
    media: MediaInfo | None = None
    video: VideoSummary | None = None
    task: asyncio.Task | None = None
    workdir: Path | None = None


class _Context:
    """The :class:`JobContext` handed to source providers."""

    def __init__(self, manager: JobManager, job: Job, workdir: Path) -> None:
        self._manager = manager
        self._job = job
        self.workdir = workdir

    def set_state(self, state: JobState, detail: str | None = None) -> None:
        self._manager._set_state(self._job, state, detail)

    def set_progress(self, progress: JobProgress) -> None:
        self._job.progress = progress
        self._job.updated_at = self._manager._clock()

    def set_video(self, video: VideoSummary) -> None:
        self._job.video = video


def media_id_for(source: str, ref: str, profile: str) -> str:
    prefix = "yt" if source == "youtube" else source
    return f"{prefix}_{ref}_{profile}"


class JobManager:
    def __init__(
        self,
        settings: Settings,
        storage: MediaStorage,
        providers: dict[str, MediaSourceProvider],
        *,
        processor: Processor = process_to_mp4,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.settings = settings
        self.storage = storage
        self.providers = providers
        self.processor = processor
        self._clock = clock
        self._jobs: dict[str, Job] = {}
        self._by_key: dict[str, str] = {}
        self._semaphore = asyncio.Semaphore(settings.max_concurrent_jobs)

    # -- public API ------------------------------------------------------------

    def submit(self, source: str, ref: str) -> tuple[Job, bool]:
        """Return ``(job, created)``; reuses an equivalent pending or ready job."""
        provider = self.providers.get(source)
        if provider is None:
            raise AppError("invalid_input", f"Unknown media source {source!r}.")
        ref = provider.validate_ref(ref)
        # Media prepared with someone's YouTube cookies is kept apart and only served back to them.
        tag = session_tag()
        profile = f"{self.settings.profile}-{tag}" if tag else self.settings.profile
        key = f"{source}:{ref}:{profile}"
        media_id = media_id_for(source, ref, profile)

        existing = self._jobs.get(self._by_key.get(key, ""))
        if existing is not None and existing.state != JobState.FAILED:
            if existing.state != JobState.READY or self.storage.get(media_id) is not None:
                return existing, False

        cached = self._job_from_cache(key, source, ref, media_id)
        if cached is not None:
            return cached, True

        active = sum(1 for job in self._jobs.values() if not job.state.terminal)
        if active >= self.settings.max_concurrent_jobs + self.settings.max_queued_jobs:
            raise AppError("busy", "Too many videos are being prepared right now.", status=429,
                           hint="Wait for current preparations to finish and try again.", retryable=True)

        job = self._new_job(key, source, ref, media_id)
        job.task = asyncio.create_task(self._run(job, provider), name=f"prepare-{job.id}")
        return job, True

    def get(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise AppError("not_found", "Unknown preparation job.", status=404)
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        if not job.state.terminal and job.task is not None:
            job.task.cancel()
        return job

    def view(self, job: Job) -> JobView:
        position = None
        if job.state == JobState.QUEUED:
            queued = sorted((j for j in self._jobs.values() if j.state == JobState.QUEUED),
                            key=lambda j: j.created_at)
            position = next((i for i, j in enumerate(queued) if j.id == job.id), None)
        return JobView(
            id=job.id,
            source=job.source,  # type: ignore[arg-type]
            video_id=job.ref,
            state=job.state,
            progress=job.progress,
            error=job.error,
            media=job.media,
            video=job.video,
            demo=job.source == "demo",
            queue_position=position,
            created_at=job.created_at,
            updated_at=job.updated_at,
        )

    def active_job_ids(self) -> set[str]:
        return {job.id for job in self._jobs.values() if not job.state.terminal}

    def prune(self) -> None:
        cutoff = self._clock() - _FINISHED_JOB_RETENTION
        for job in list(self._jobs.values()):
            if job.state.terminal and job.updated_at < cutoff:
                self._jobs.pop(job.id, None)
                if self._by_key.get(job.key) == job.id:
                    self._by_key.pop(job.key, None)

    async def shutdown(self) -> None:
        tasks = [job.task for job in self._jobs.values() if job.task and not job.task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # -- internals ---------------------------------------------------------------

    def _new_job(self, key: str, source: str, ref: str, media_id: str) -> Job:
        now = self._clock()
        job = Job(id=secrets.token_urlsafe(12), key=key, source=source, ref=ref, media_id=media_id,
                  created_at=now, updated_at=now)
        self._jobs[job.id] = job
        self._by_key[key] = job.id
        return job

    def _job_from_cache(self, key: str, source: str, ref: str, media_id: str) -> Job | None:
        stored = self.storage.get(media_id)
        if stored is None:
            return None
        try:
            media = MediaInfo.model_validate(stored.meta["media"])
            video = VideoSummary.model_validate(stored.meta["video"]) if stored.meta.get("video") else None
        except (KeyError, ValidationError):
            log.warning("ignoring unreadable cache metadata for %s", media_id)
            return None
        job = self._new_job(key, source, ref, media_id)
        job.media = media.model_copy(update={"size_bytes": stored.size})
        job.video = video
        job.state = JobState.READY
        job.progress = JobProgress(fraction=1.0, detail="Loaded from cache")
        self.storage.touch(media_id)
        return job

    def _set_state(self, job: Job, state: JobState, detail: str | None = None) -> None:
        if job.state != state:
            log.info("job %s (%s): %s -> %s", job.id, job.key, job.state.value, state.value)
        job.state = state
        job.progress = JobProgress(fraction=1.0 if state == JobState.READY else None, detail=detail)
        job.updated_at = self._clock()

    def _fail(self, job: Job, error: AppError) -> None:
        job.error = JobErrorInfo(code=error.code, message=error.message, hint=error.hint,
                                 retryable=error.retryable)
        self._set_state(job, JobState.FAILED, error.message)

    async def _run(self, job: Job, provider: MediaSourceProvider) -> None:
        workdir: Path | None = None
        try:
            async with self._semaphore:
                workdir = self.storage.create_workdir(job.id)
                job.workdir = workdir
                ctx = _Context(self, job, workdir)

                self._set_state(job, JobState.RESOLVING, "Looking up the video and its formats")
                resolved = await provider.resolve(job.ref, ctx)
                job.video = resolved.video
                self.storage.ensure_capacity(resolved.estimated_bytes or _DEFAULT_ESTIMATE)

                if job.state != JobState.DOWNLOADING:
                    self._set_state(job, JobState.DOWNLOADING, "Downloading media")
                acquired = await provider.acquire(resolved, ctx)

                self._set_state(job, JobState.PROCESSING, "Preparing a browser-compatible MP4")
                output = workdir / "output.mp4"
                report: ProgressCallback = ctx.set_progress
                processed = await self.processor(
                    self.settings, acquired.inputs, output, report, duration_hint=acquired.duration_hint
                )
                job.media = self._commit(job, processed)
                self._set_state(job, JobState.READY, "Ready to play")
        except asyncio.CancelledError:
            self._fail(job, AppError("cancelled", "Preparation was cancelled.", retryable=True))
        except AppError as exc:
            log.info("job %s failed: %s (%s)", job.id, exc.code, exc.message)
            self._fail(job, exc)
        except Exception:
            log.exception("job %s crashed", job.id)
            self._fail(job, AppError("internal_error", "Something went wrong while preparing this video.",
                                     status=500, retryable=True))
        finally:
            self.storage.remove_workdir(workdir)
            job.workdir = None

    def _commit(self, job: Job, processed: ProcessedMedia) -> MediaInfo:
        video = processed.probe.first("video")
        audio = processed.probe.first("audio")
        size = processed.path.stat().st_size
        media = MediaInfo(
            media_id=job.media_id,
            url=f"/api/media/{job.media_id}",
            size_bytes=size,
            width=video.width if video else None,
            height=video.height if video else None,
            duration_seconds=processed.probe.duration,
            video_codec=video.codec_name if video else None,
            audio_codec=audio.codec_name if audio else None,
            processing=processed.mode,  # type: ignore[arg-type]
        )
        meta = {
            "media": media.model_dump(),
            "video": job.video.model_dump() if job.video else None,
            "created_at": self._clock(),
        }
        self.storage.commit(job.media_id, processed.path, meta)
        return media


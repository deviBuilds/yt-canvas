import asyncio

import pytest

from app.errors import AppError
from app.media.ffmpeg import ProbeResult, ProcessedMedia, StreamInfo
from app.media.jobs import JobManager
from app.media.models import JobProgress, JobState
from app.media.provider import AcquiredMedia, MediaInput, ResolvedMedia
from app.media.storage import MediaStorage
from app.models import VideoSummary

from .conftest import with_settings

pytestmark = pytest.mark.anyio

# Fakes register under a real source name because the API schema only allows real sources.
SRC = "youtube"


class Gate:
    """Lets a test hold a fake provider at a specific step."""

    def __init__(self) -> None:
        self.reached = asyncio.Event()
        self.release = asyncio.Event()

    async def wait(self) -> None:
        self.reached.set()
        await self.release.wait()


class FakeProvider:
    source = SRC
    supports_progressive = False

    def __init__(self, *, fail_on: str | None = None, gated: bool = False) -> None:
        self.fail_on = fail_on
        self.resolve_calls = 0
        self.gates = {"resolve": Gate(), "acquire": Gate()} if gated else None

    def validate_ref(self, ref: str) -> str:
        if not ref.isalnum():
            raise AppError("invalid_input", "bad ref")
        return ref

    async def resolve(self, ref, ctx):
        self.resolve_calls += 1
        if self.gates:
            await self.gates["resolve"].wait()
        if self.fail_on == "resolve":
            raise AppError("unavailable", "This video is unavailable.", status=404)
        return ResolvedMedia(video=VideoSummary(id=ref, title=f"Video {ref}"), estimated_bytes=1000)

    async def acquire(self, resolved, ctx):
        ctx.set_state(JobState.DOWNLOADING, "Downloading media")
        ctx.set_progress(JobProgress(fraction=0.5, downloaded_bytes=500, total_bytes=1000))
        if self.gates:
            await self.gates["acquire"].wait()
        if self.fail_on == "acquire":
            raise AppError("download_forbidden", "YouTube refused (HTTP 403).", status=502, retryable=True)
        source = ctx.workdir / "source.bin"
        source.write_bytes(b"x" * 100)
        return AcquiredMedia(inputs=[MediaInput(source, "muxed")], duration_hint=10.0)


async def fake_processor(settings, inputs, output, report, *, duration_hint=None):
    report(JobProgress(fraction=0.5, detail="Remuxing"))
    output.write_bytes(b"\x00" * 2048)
    probe = ProbeResult(duration=10.0, streams=[
        StreamInfo(0, "video", "h264", "High", "yuv420p", 640, 360, None),
        StreamInfo(1, "audio", "aac", "LC", None, None, None, 2),
    ])
    return ProcessedMedia(path=output, mode="remux", probe=probe)


async def failing_processor(settings, inputs, output, report, *, duration_hint=None):
    raise RuntimeError("unexpected crash")


def make_manager(settings, provider, processor=fake_processor):
    storage = MediaStorage(settings)
    storage.init()
    return JobManager(settings, storage, {SRC: provider}, processor=processor), storage


async def wait_for_state(manager, job_id, *states, timeout=5.0):
    async def poll():
        while manager.get(job_id).state not in states:
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)
    return manager.get(job_id)


async def test_happy_path_walks_through_every_state(settings):
    provider = FakeProvider(gated=True)
    manager, storage = make_manager(settings, provider)
    job, created = manager.submit(SRC, "abc")
    assert created and job.state == JobState.QUEUED

    await asyncio.wait_for(provider.gates["resolve"].reached.wait(), 5)
    assert manager.get(job.id).state == JobState.RESOLVING
    provider.gates["resolve"].release.set()

    await asyncio.wait_for(provider.gates["acquire"].reached.wait(), 5)
    view = manager.view(manager.get(job.id))
    assert view.state == JobState.DOWNLOADING
    assert view.progress.fraction == 0.5 and view.progress.total_bytes == 1000
    assert view.video.title == "Video abc"
    provider.gates["acquire"].release.set()

    done = await wait_for_state(manager, job.id, JobState.READY, JobState.FAILED)
    assert done.state == JobState.READY
    assert done.media.url == f"/api/media/{done.media_id}"
    assert done.media.processing == "remux" and done.media.width == 640
    assert storage.get(done.media_id) is not None
    assert done.workdir is None and not any(storage.work_dir.iterdir())


async def test_identical_requests_are_deduplicated(settings):
    provider = FakeProvider(gated=True)
    manager, _ = make_manager(settings, provider)
    first, created1 = manager.submit(SRC, "abc")
    second, created2 = manager.submit(SRC, "abc")
    assert first is second and created1 and not created2

    provider.gates["resolve"].release.set()
    provider.gates["acquire"].release.set()
    await wait_for_state(manager, first.id, JobState.READY)
    third, created3 = manager.submit(SRC, "abc")
    assert third is first and not created3
    assert provider.resolve_calls == 1


async def test_ready_media_is_reused_from_cache_after_restart(settings):
    provider = FakeProvider()
    manager, storage = make_manager(settings, provider)
    job, _ = manager.submit(SRC, "abc")
    await wait_for_state(manager, job.id, JobState.READY)

    restarted = JobManager(settings, storage, {SRC: provider}, processor=fake_processor)
    again, created = restarted.submit(SRC, "abc")
    assert created and again.state == JobState.READY
    assert again.media.media_id == job.media_id and again.video.title == "Video abc"
    assert provider.resolve_calls == 1


async def test_evicted_media_triggers_a_new_job(settings):
    provider = FakeProvider()
    manager, storage = make_manager(settings, provider)
    job, _ = manager.submit(SRC, "abc")
    await wait_for_state(manager, job.id, JobState.READY)
    storage.media_path(job.media_id).unlink()
    again, created = manager.submit(SRC, "abc")
    assert created and again.id != job.id
    await wait_for_state(manager, again.id, JobState.READY)
    assert provider.resolve_calls == 2


@pytest.mark.parametrize("step, code", [("resolve", "unavailable"), ("acquire", "download_forbidden")])
async def test_failures_are_reported_with_codes(settings, step, code):
    manager, storage = make_manager(settings, FakeProvider(fail_on=step))
    job, _ = manager.submit(SRC, "abc")
    failed = await wait_for_state(manager, job.id, JobState.FAILED)
    assert failed.error.code == code
    assert not any(storage.work_dir.iterdir())


async def test_unexpected_exceptions_become_internal_errors(settings):
    manager, _ = make_manager(settings, FakeProvider(), processor=failing_processor)
    job, _ = manager.submit(SRC, "abc")
    failed = await wait_for_state(manager, job.id, JobState.FAILED)
    assert failed.error.code == "internal_error"
    assert "crash" not in failed.error.message


async def test_failed_job_is_retried_with_a_new_job(settings):
    provider = FakeProvider(fail_on="acquire")
    manager, _ = make_manager(settings, provider)
    job, _ = manager.submit(SRC, "abc")
    await wait_for_state(manager, job.id, JobState.FAILED)
    provider.fail_on = None
    retry, created = manager.submit(SRC, "abc")
    assert created and retry.id != job.id
    assert (await wait_for_state(manager, retry.id, JobState.READY)).state == JobState.READY


async def test_concurrency_is_bounded_and_queue_positions_reported(settings):
    settings = with_settings(settings, max_concurrent_jobs=1, max_queued_jobs=1)
    provider = FakeProvider(gated=True)
    manager, _ = make_manager(settings, provider)
    first, _ = manager.submit(SRC, "one")
    second, _ = manager.submit(SRC, "two")
    await asyncio.wait_for(provider.gates["resolve"].reached.wait(), 5)
    await asyncio.sleep(0.05)
    assert manager.get(first.id).state == JobState.RESOLVING
    assert manager.get(second.id).state == JobState.QUEUED
    assert manager.view(manager.get(second.id)).queue_position == 0

    with pytest.raises(AppError) as exc:
        manager.submit(SRC, "three")
    assert exc.value.code == "busy" and exc.value.status == 429

    provider.gates["resolve"].release.set()
    provider.gates["acquire"].release.set()
    await wait_for_state(manager, first.id, JobState.READY)
    await wait_for_state(manager, second.id, JobState.READY)


async def test_cancellation_marks_job_failed_and_cleans_up(settings):
    provider = FakeProvider(gated=True)
    manager, storage = make_manager(settings, provider)
    job, _ = manager.submit(SRC, "abc")
    await asyncio.wait_for(provider.gates["resolve"].reached.wait(), 5)
    manager.cancel(job.id)
    failed = await wait_for_state(manager, job.id, JobState.FAILED)
    assert failed.error.code == "cancelled" and failed.error.retryable
    assert not any(storage.work_dir.iterdir())


async def test_invalid_references_and_sources(settings):
    manager, _ = make_manager(settings, FakeProvider())
    with pytest.raises(AppError):
        manager.submit(SRC, "../etc")
    with pytest.raises(AppError):
        manager.submit("nope", "abc")
    with pytest.raises(AppError) as exc:
        manager.get("missing")
    assert exc.value.status == 404


async def test_shutdown_cancels_running_jobs(settings):
    provider = FakeProvider(gated=True)
    manager, _ = make_manager(settings, provider)
    job, _ = manager.submit(SRC, "abc")
    await asyncio.wait_for(provider.gates["resolve"].reached.wait(), 5)
    await manager.shutdown()
    assert manager.get(job.id).state == JobState.FAILED

import os

import pytest

from app.errors import AppError
from app.media.storage import MediaStorage

from .conftest import with_settings


def put(storage: MediaStorage, media_id: str, size: int, mtime: float | None = None) -> None:
    source = storage.work_dir / f"{media_id}.incoming"
    source.write_bytes(b"\0" * size)
    storage.commit(media_id, source, {"media": {}})
    if mtime is not None:
        os.utime(storage.media_path(media_id), (mtime, mtime))


@pytest.fixture
def storage(settings):
    s = MediaStorage(with_settings(settings, cache_max_bytes=1000, cache_ttl_seconds=100), clock=lambda: 10_000.0)
    s.init()
    return s


def test_lru_eviction_makes_room(storage):
    put(storage, "old", 400, mtime=1000)
    put(storage, "mid", 400, mtime=2000)
    storage.ensure_capacity(500)
    assert storage.get("old") is None
    assert storage.get("mid") is not None


def test_leased_media_is_never_evicted(storage):
    put(storage, "old", 400, mtime=1000)
    put(storage, "mid", 400, mtime=2000)
    with storage.leased("old"):
        storage.ensure_capacity(500)
        assert storage.get("old") is not None
        assert storage.get("mid") is None
    with storage.leased("old"):
        with pytest.raises(AppError) as exc:
            storage.ensure_capacity(700)
        assert exc.value.code == "storage_full"


def test_oversized_requests_are_rejected(storage):
    with pytest.raises(AppError) as exc:
        storage.ensure_capacity(5000)
    assert exc.value.code == "too_large"


def test_ttl_expiry_respects_leases(storage):
    put(storage, "stale", 10, mtime=1000)
    put(storage, "busy", 10, mtime=1000)
    put(storage, "fresh", 10, mtime=9950)
    with storage.leased("busy"):
        storage.evict_expired()
    assert storage.get("stale") is None
    assert storage.get("busy") is not None
    assert storage.get("fresh") is not None


def test_access_refreshes_lru_position(storage):
    put(storage, "a", 400, mtime=1000)
    put(storage, "b", 400, mtime=2000)
    storage.touch("a")  # clock() == 10_000
    storage.ensure_capacity(500)
    assert storage.get("a") is not None and storage.get("b") is None


def test_lease_release_is_idempotent(storage):
    put(storage, "a", 10)
    lease = storage.lease("a")
    second = storage.lease("a")
    lease.release()
    lease.release()
    assert storage.is_leased("a")
    second.release()
    assert not storage.is_leased("a")


def test_paths_are_confined(storage):
    for bad in ("../x", "a/b", "", "x" * 97, "a.b"):
        with pytest.raises(AppError):
            storage.media_path(bad)
    assert storage.get("../../etc/passwd") is None


def test_init_removes_leftovers(storage):
    (storage.work_dir / "crashed-job").mkdir()
    (storage.media_dir / "x.json.tmp").write_text("{}")
    storage.init()
    assert not any(storage.work_dir.iterdir())
    assert not list(storage.media_dir.glob("*.tmp"))


def test_cleanup_workdirs_keeps_active_jobs(storage):
    storage.create_workdir("active")
    storage.create_workdir("orphan")
    storage.cleanup_workdirs({"active"})
    assert [p.name for p in storage.work_dir.iterdir()] == ["active"]

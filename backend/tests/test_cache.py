import asyncio

import pytest

from app.discovery.service import TTLCache
from app.models import Page

pytestmark = pytest.mark.anyio


def page(title: str) -> Page:
    return Page(kind="search", title=title, items=[], provider="test")


async def test_concurrent_misses_share_one_fetch():
    cache = TTLCache(ttl=60, max_entries=10)
    calls = 0
    release = asyncio.Event()

    async def fetch():
        nonlocal calls
        calls += 1
        await release.wait()
        return page("a")

    tasks = [asyncio.create_task(cache.get_or_fetch("k", fetch)) for _ in range(5)]
    await asyncio.sleep(0.01)
    release.set()
    results = await asyncio.gather(*tasks)
    assert calls == 1
    assert all(r.title == "a" for r in results)
    assert (await cache.get_or_fetch("k", fetch)).cached is True


async def test_entries_expire_and_lru_is_bounded():
    now = [0.0]
    cache = TTLCache(ttl=10, max_entries=2, clock=lambda: now[0])
    cache.put("a", page("a"))
    cache.put("b", page("b"))
    cache.get("a")
    cache.put("c", page("c"))  # evicts b, the least recently used
    assert cache.get("b") is None and cache.get("a") is not None
    now[0] = 11
    assert cache.get("a") is None


async def test_errors_are_shared_but_not_cached():
    cache = TTLCache(ttl=60, max_entries=10)

    async def boom():
        raise RuntimeError("down")

    with pytest.raises(RuntimeError):
        await cache.get_or_fetch("k", boom)

    async def ok():
        return page("ok")

    assert (await cache.get_or_fetch("k", ok)).title == "ok"


async def test_waiters_retry_when_the_leading_request_is_cancelled():
    cache = TTLCache(ttl=60, max_entries=10)
    started = asyncio.Event()

    async def slow():
        started.set()
        await asyncio.sleep(30)
        return page("slow")

    async def fast():
        return page("fast")

    leader = asyncio.create_task(cache.get_or_fetch("k", slow))
    await started.wait()
    waiter = asyncio.create_task(cache.get_or_fetch("k", fast))
    await asyncio.sleep(0.01)
    leader.cancel()
    assert (await waiter).title == "fast"

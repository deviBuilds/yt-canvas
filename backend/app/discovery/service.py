"""Discovery service: validation, bounds, and a short-lived metadata cache."""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable

from ..config import Settings
from ..errors import AppError
from ..models import Page
from ..validation import clean_query, validate_channel_ref, validate_playlist_id
from .provider import DiscoveryProvider


class TTLCache:
    """A small LRU cache with per-entry expiry that also coalesces concurrent misses."""

    def __init__(self, ttl: float, max_entries: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl = ttl
        self.max_entries = max_entries
        self._clock = clock
        self._data: OrderedDict[Hashable, tuple[float, Page]] = OrderedDict()
        self._inflight: dict[Hashable, asyncio.Future[Page]] = {}

    def get(self, key: Hashable) -> Page | None:
        hit = self._data.get(key)
        if hit is None:
            return None
        expires, value = hit
        if expires < self._clock():
            del self._data[key]
            return None
        self._data.move_to_end(key)
        return value

    def put(self, key: Hashable, value: Page) -> None:
        if self.ttl <= 0:
            return
        self._data[key] = (self._clock() + self.ttl, value)
        self._data.move_to_end(key)
        while len(self._data) > self.max_entries:
            self._data.popitem(last=False)

    async def get_or_fetch(self, key: Hashable, fetch: Callable[[], Awaitable[Page]]) -> Page:
        cached = self.get(key)
        if cached is not None:
            return cached.model_copy(update={"cached": True})
        pending = self._inflight.get(key)
        if pending is not None:
            try:
                return await asyncio.shield(pending)
            except asyncio.CancelledError:
                if pending.cancelled():  # the leading request went away: fetch ourselves
                    return await self.get_or_fetch(key, fetch)
                raise
        future: asyncio.Future[Page] = asyncio.get_running_loop().create_future()
        self._inflight[key] = future
        try:
            value = await fetch()
        except asyncio.CancelledError:
            future.cancel()
            raise
        except Exception as exc:
            future.set_exception(exc)
            future.exception()  # mark retrieved when nobody else is waiting
            raise
        else:
            self.put(key, value)
            future.set_result(value)
            return value
        finally:
            self._inflight.pop(key, None)


class DiscoveryService:
    def __init__(self, settings: Settings, provider: DiscoveryProvider) -> None:
        self.settings = settings
        self.provider = provider
        self.cache = TTLCache(settings.metadata_cache_ttl, settings.metadata_cache_entries)

    def _bounds(self, offset: int, cap: int) -> int:
        if offset < 0:
            raise AppError("invalid_input", "offset must not be negative.")
        if offset >= cap:
            raise AppError("invalid_input", f"Results are limited to the first {cap} items.")
        if offset % self.settings.page_size:
            raise AppError("invalid_input", "offset must be a multiple of the page size.")
        return offset

    async def search(self, query: str, offset: int = 0) -> Page:
        query = clean_query(query)
        offset = self._bounds(offset, self.settings.max_search_results)
        limit = self.settings.page_size
        key = ("search", self.provider.name, query.lower(), offset, limit)
        return await self.cache.get_or_fetch(key, lambda: self.provider.search(query, offset=offset, limit=limit))

    async def channel(self, ref: str, offset: int = 0) -> Page:
        ref = validate_channel_ref(ref)
        offset = self._bounds(offset, self.settings.max_list_results)
        limit = self.settings.page_size
        key = ("channel", self.provider.name, ref, offset, limit)
        return await self.cache.get_or_fetch(key, lambda: self.provider.channel(ref, offset=offset, limit=limit))

    async def playlist(self, playlist_id: str, offset: int = 0) -> Page:
        playlist_id = validate_playlist_id(playlist_id)
        offset = self._bounds(offset, self.settings.max_list_results)
        limit = self.settings.page_size
        key = ("playlist", self.provider.name, playlist_id, offset, limit)
        return await self.cache.get_or_fetch(
            key, lambda: self.provider.playlist(playlist_id, offset=offset, limit=limit)
        )

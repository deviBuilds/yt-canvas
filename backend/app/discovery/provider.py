"""The replaceable discovery-provider interface.

A provider turns validated identifiers into normalized :class:`Page` objects.
Providers must not resolve media streams or download anything: discovery is
metadata only. Pagination is offset-based; a provider sets ``next_offset`` only
when it really fetched evidence of a further page.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from ..models import Page


@runtime_checkable
class DiscoveryProvider(Protocol):
    name: str

    async def search(self, query: str, *, offset: int, limit: int) -> Page:
        """Keyword search. ``query`` is already cleaned by :func:`validation.clean_query`."""
        ...

    async def channel(self, ref: str, *, offset: int, limit: int) -> Page:
        """Uploads of a channel. ``ref`` is a validated channel reference."""
        ...

    async def playlist(self, playlist_id: str, *, offset: int, limit: int) -> Page:
        """Entries of a playlist. ``playlist_id`` is validated."""
        ...

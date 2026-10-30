"""Discovery via yt-dlp flat extraction (``--flat-playlist -J``).

Flat extraction lists entries without resolving any streams, which keeps
search fast and avoids touching media URLs. Pagination uses yt-dlp's
``--playlist-items`` so each page is fetched from YouTube for real; we request
one extra item to learn whether another page exists.
"""

from __future__ import annotations

from typing import Any

from ..config import Settings
from ..models import ChannelInfo, Page
from ..validation import channel_url, playlist_url
from ..ytdlp import base_args, run_json
from .normalize import channel_from, clean_channel_title, normalize_entries


class YtDlpDiscoveryProvider:
    name = "yt-dlp"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def _flat(self, target: str, *, offset: int, limit: int, context: str) -> dict[str, Any]:
        # Items are 1-based and the range is inclusive; fetch limit + 1 to probe for more.
        items = f"{offset + 1}:{offset + limit + 1}"
        args = [
            # Listings are shared between people, so they use the settings this provider was made
            # with: the server's, or one person's for their own feeds (discovery/account.py).
            *base_args(self.settings, personal=False),
            "--flat-playlist",
            "--dump-single-json",
            "--no-warnings",
            "--playlist-items",
            items,
            "--",
            target,
        ]
        return await run_json(self.settings, args, timeout=self.settings.discovery_timeout, context=context)

    @staticmethod
    def _paginate(items: list, offset: int, limit: int, cap: int) -> tuple[list, int | None]:
        has_more = len(items) > limit
        items = items[:limit]
        next_offset = offset + limit if has_more and offset + limit < cap else None
        return items, next_offset

    async def search(self, query: str, *, offset: int, limit: int) -> Page:
        cap = self.settings.max_search_results
        total = min(offset + limit + 1, cap + 1)
        data = await self._flat(f"ytsearch{total}:{query}", offset=offset, limit=limit, context="search")
        entries = normalize_entries(data.get("entries"), signed_in=self.settings.signed_in_configured)
        items, next_offset = self._paginate(entries, offset, limit, cap)
        return Page(
            kind="search",
            title=query,
            items=items,
            offset=offset,
            next_offset=next_offset,
            provider=self.name,
        )

    async def channel(self, ref: str, *, offset: int, limit: int) -> Page:
        data = await self._flat(channel_url(ref, "videos"), offset=offset, limit=limit, context="channel")
        channel = channel_from(data) or ChannelInfo(ref=ref)
        if channel.ref is None:
            channel = channel.model_copy(update={"ref": ref})
        name = channel.name or clean_channel_title(data.get("title"))
        channel = channel.model_copy(update={"name": name})
        entries = normalize_entries(data.get("entries"), channel_fallback=channel,
                                    signed_in=self.settings.signed_in_configured)
        items, next_offset = self._paginate(entries, offset, limit, self.settings.max_list_results)
        return Page(
            kind="channel",
            title=name or ref,
            subtitle=channel.handle,
            channel=channel,
            items=items,
            offset=offset,
            next_offset=next_offset,
            provider=self.name,
        )

    async def playlist(self, playlist_id: str, *, offset: int, limit: int) -> Page:
        data = await self._flat(playlist_url(playlist_id), offset=offset, limit=limit, context="playlist")
        owner = channel_from(data)
        entries = normalize_entries(data.get("entries"), signed_in=self.settings.signed_in_configured)
        items, next_offset = self._paginate(entries, offset, limit, self.settings.max_list_results)
        count = data.get("playlist_count")
        return Page(
            kind="playlist",
            title=clean_channel_title(data.get("title")) or "Playlist",
            subtitle=owner.name if owner else None,
            channel=owner,
            playlist_id=playlist_id,
            total_count=count if isinstance(count, int) and count >= 0 else None,
            items=items,
            offset=offset,
            next_offset=next_offset,
            provider=self.name,
        )

    async def feed(self, target: str, *, title: str, offset: int, limit: int) -> Page:
        """A signed-in account feed (``:ytrec``, ``:ytsubs``, ...). ``target`` is a fixed keyword/URL."""
        data = await self._flat(target, offset=offset, limit=limit, context=f"feed {title}")
        entries = normalize_entries(data.get("entries"), signed_in=True)
        items, next_offset = self._paginate(entries, offset, limit, self.settings.max_list_results)
        count = data.get("playlist_count")
        return Page(
            kind="feed",
            title=title,
            total_count=count if isinstance(count, int) and count >= 0 else None,
            items=items,
            offset=offset,
            next_offset=next_offset,
            provider=self.name,
        )

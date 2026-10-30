"""The Plex app: a Plex Media Server's movies and shows, streamed into the canvas player.

- Sign-in: Plex's PIN flow (``service.py``); the token stays in ``<config dir>/plex.json``.
- Browsing: libraries, home rows, items, search and posters (``library.py``).
- Playback: direct play in byte ranges when the browser can decode the file, Plex's
  transcoder as DASH otherwise, and progress reported to Plex (``playback.py``).
"""

from __future__ import annotations

from ...config import Settings
from ..registry import AppSpec
from .library import PlexLibraryService
from .playback import PlexPlayback
from .router import plex_router
from .service import PlexService


def plex_app(settings: Settings) -> AppSpec:
    plex = PlexService(settings)
    playback = PlexPlayback(plex)
    return AppSpec(
        id="plex",
        name="Plex",
        description="Browse your Plex Media Server and play its movies and shows in the canvas player, "
                    "streamed (never downloaded first).",
        router=plex_router(plex, PlexLibraryService(plex), playback),
        holds_private_data=True,
        connected=lambda: plex.store.connected,
    )

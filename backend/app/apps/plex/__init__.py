"""The Plex app: a Plex Media Server's movies and shows, streamed into the canvas player.

- Sign-in: Plex's PIN flow (``service.py``); the token never reaches the browser (``store.py``).
- Browsing: libraries, home rows, items, search and posters (``library.py``).
- Playback: direct play in byte ranges when the browser can decode the file, Plex's
  transcoder as DASH otherwise, and progress reported to Plex (``playback.py``).
- Whose Plex: the server's in no-login mode, each person's own with accounts (``users.py``).
"""

from __future__ import annotations

from ...accounts.users import Accounts
from ...config import Settings
from ..registry import AppSpec
from .router import plex_router
from .users import PlexUsers


def plex_app(settings: Settings, accounts: Accounts | None = None) -> AppSpec:
    users = PlexUsers(settings, accounts)
    return AppSpec(
        id="plex",
        name="Plex",
        description="Browse your Plex Media Server and play its movies and shows in the canvas player, "
                    "streamed (never downloaded first).",
        router=plex_router(users),
        holds_private_data=True,
        connected=users.connected,
    )

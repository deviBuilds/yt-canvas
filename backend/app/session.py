"""The YouTube session of the request being served.

In no-login mode there is one session: the server's own settings (and its optional cookies).
With accounts on, the auth guard sets the signed-in person's session for each request: the
server's settings with *their* uploaded cookies, or with none. yt-dlp calls, restricted-video
checks and per-user cache keys read it through :func:`youtube_settings` and
:func:`session_tag`. Background tasks started by a request (preparation jobs) inherit it,
because asyncio copies context variables into new tasks.
"""

from __future__ import annotations

import hashlib
from contextvars import ContextVar
from dataclasses import dataclass

from .config import Settings


@dataclass(frozen=True)
class YouTubeSession:
    user_id: str
    # The server's settings with this person's cookies file (or none).
    settings: Settings


_current: ContextVar[YouTubeSession | None] = ContextVar("ytc_youtube_session", default=None)


def use_session(session: YouTubeSession | None) -> object:
    """Make ``session`` current; returns a token for :func:`reset_session`."""
    return _current.set(session)


def reset_session(token: object) -> None:
    _current.reset(token)  # type: ignore[arg-type]


def current_session() -> YouTubeSession | None:
    return _current.get()


def youtube_settings(settings: Settings) -> Settings:
    """``settings`` with the current person's YouTube cookies, when someone is signed in."""
    session = _current.get()
    return session.settings if session is not None else settings


def session_tag() -> str | None:
    """A short, stable tag for the current person while their cookies are in use, else None.

    Keys anything fetched with someone's cookies (prepared media, stream sessions, personalized
    pages), so it is only ever served back to them.
    """
    session = _current.get()
    if session is None or not session.settings.signed_in_configured:
        return None
    return hashlib.sha256(f"ytc-user:{session.user_id}".encode()).hexdigest()[:12]

"""Renewing someone's YouTube cookies, the way any signed-in visit does.

Loading youtube.com with a session's cookies answers with refreshed ones (Set-Cookie), as
every yt-dlp run does; keeping them is what keeps a copy of the session usable. This does
that on purpose, with an ordinary page load (no special rotation call), so cookies stay
fresh while nobody is watching, and it reads the page's ``"LOGGED_IN"`` flag to tell whether
YouTube still treats them as signed in. Cookie values are never logged; only their names are.
"""

from __future__ import annotations

import io
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from http.cookiejar import CookieJar
from urllib.parse import urlsplit

from ..cookies import netscape_text, youtube_lines
from ..discovery.youtube_pages import build_request

PAGE_URL = "https://www.youtube.com/"
TIMEOUT = 20
MAX_PAGE_BYTES = 8 * 1024 * 1024
_LOGGED_IN_RE = re.compile(r'"LOGGED_IN"\s*:\s*(true|false)')


class SessionEnded(Exception):
    """YouTube treats these cookies as signed out: the session is over."""


class RenewFailed(Exception):
    """YouTube couldn't be asked, or showed an unexpected page (the message is safe to log)."""


@dataclass(frozen=True)
class Renewal:
    lines: list[str]  # the cookies.txt lines, with what YouTube set
    refreshed: list[str]  # names of the cookies YouTube sent new values for


def _get(request: urllib.request.Request, jar: CookieJar) -> tuple[str, str]:
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    with opener.open(request, timeout=TIMEOUT) as response:  # noqa: S310 - a fixed https URL
        return response.geturl(), response.read(MAX_PAGE_BYTES).decode("utf-8", "replace")


def refresh(lines: list[str], get: Callable[[urllib.request.Request, CookieJar], tuple[str, str]] = _get) -> Renewal:
    """Load youtube.com with the session in ``lines`` and keep what it sets (blocking; worker thread only)."""
    from yt_dlp.cookies import YoutubeDLCookieJar

    jar = YoutubeDLCookieJar()
    jar.load(io.StringIO(netscape_text(lines)))
    before = {(c.domain, c.path, c.name): c.value for c in jar}
    try:
        final_url, html = get(build_request(PAGE_URL), jar)
    except urllib.error.HTTPError as exc:
        raise RenewFailed(f"YouTube answered {exc.code}") from None
    except (OSError, TimeoutError) as exc:
        raise RenewFailed(type(exc).__name__) from None
    host = (urlsplit(final_url).hostname or "").lower()
    if host not in ("www.youtube.com", "youtube.com", "m.youtube.com"):
        raise RenewFailed(f"YouTube sent this server to {host or 'another page'}")
    match = _LOGGED_IN_RE.search(html)
    if match is None:
        raise RenewFailed("YouTube's page didn't say whether it's signed in")
    if match.group(1) != "true":
        raise SessionEnded()
    refreshed = sorted({c.name for c in jar if before.get((c.domain, c.path, c.name)) != c.value})
    out = io.StringIO()
    jar.save(out)
    return Renewal(lines=youtube_lines(out.getvalue()), refreshed=refreshed)


def _key(line: str) -> tuple[str, str, str]:
    fields = line.split("\t")
    return fields[0].removeprefix("#HttpOnly_"), fields[2], fields[5]


def _expires(line: str) -> float:
    return float(line.split("\t")[4] or 0)


def newest(stored: list[str], written: list[str]) -> list[str]:
    """``written`` (yt-dlp's rewrite of the file), except where ``stored`` holds a cookie that
    expires later: a renewal that a yt-dlp run started before, and wrote back over, didn't see."""
    later = {_key(line): line for line in stored}
    merged = []
    for line in written:
        kept = later.get(_key(line))
        merged.append(kept if kept is not None and 0 < _expires(line) < _expires(kept) else line)
    return merged

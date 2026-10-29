"""The signed-in YouTube session's cookies, for pages this server fetches itself.

yt-dlp subprocesses read the account's cookies on their own (``ytdlp.base_args``
passes ``--cookies-from-browser`` or ``--cookies``). The few YouTube pages this
server fetches directly (``/api/me``, personalized related videos) need them
in-process too, so :class:`CookieLoader`:

* loads them in a worker thread with yt-dlp's own cookie code
  (``yt_dlp.cookies.extract_cookies_from_browser``) or, for a cookies.txt file,
  yt-dlp's Netscape parser (``YoutubeDLCookieJar``);
* keeps only cookies whose domain is youtube.com or a subdomain of it;
* caches that jar in memory for ten minutes and never writes it anywhere.

Cookie names and values are never logged: yt-dlp's debug output (which can
quote raw cookie data) is dropped, and failures are logged by type only.
"""

from __future__ import annotations

import asyncio
import copy
import http.cookiejar
import io
import logging
import os
import re
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .config import BrowserSpec, Settings
from .errors import AppError

log = logging.getLogger(__name__)

JAR_TTL = 10 * 60
FAILURE_TTL = 30
# Generous: on macOS the first read of a Chromium browser's cookies waits for the user
# to answer a Keychain prompt.
LOAD_TIMEOUT = 120

_CHROMIUM = {"brave", "chrome", "chromium", "edge", "opera", "vivaldi", "whale"}
_DISPLAY_NAMES = {"brave": "Brave", "chrome": "Chrome", "chromium": "Chromium", "edge": "Edge",
                  "firefox": "Firefox", "opera": "Opera", "safari": "Safari", "vivaldi": "Vivaldi",
                  "whale": "Whale"}
_HTTPONLY_PREFIX = "#HttpOnly_"
_EXPIRES_RE = re.compile(r"[0-9]+(?:\.[0-9]+)?")


def is_youtube_domain(domain: str) -> bool:
    """True for ``youtube.com`` and its subdomains (``.youtube.com``, ``www.youtube.com``, ...)."""
    host = domain.strip().lstrip(".").lower()
    return host == "youtube.com" or host.endswith(".youtube.com")


def youtube_only(jar: Any) -> http.cookiejar.CookieJar:
    """A new in-memory jar holding only the youtube.com cookies of ``jar``."""
    kept = http.cookiejar.CookieJar()
    for cookie in jar:
        if is_youtube_domain(cookie.domain):
            kept.set_cookie(cookie)
    return kept


def copy_jar(jar: http.cookiejar.CookieJar) -> http.cookiejar.CookieJar:
    """A per-request copy, so Set-Cookie responses never change the cached jar."""
    fresh = http.cookiejar.CookieJar()
    for cookie in jar:
        fresh.set_cookie(copy.copy(cookie))
    return fresh


def browser_display_name(browser: str) -> str:
    return _DISPLAY_NAMES.get(browser, browser)


class NoYouTubeCookies(Exception):
    """The source was read but held no youtube.com cookies."""


class NotNetscapeFormat(Exception):
    """The cookies file is JSON or otherwise not a Netscape cookies.txt."""


class _CookieLogger:
    """yt-dlp's logger interface for cookie extraction.

    Debug messages are dropped (the Safari parser can quote raw cookie bytes there);
    info and warnings carry only counts and fixed texts. Keychain trouble is noted so
    the error hint can say what to do about it.
    """

    def __init__(self) -> None:
        self.keychain_failed = False

    def debug(self, message: str, *args: Any, **kwargs: Any) -> None:
        pass

    def info(self, message: str, *args: Any, **kwargs: Any) -> None:
        log.debug("yt-dlp cookies: %s", message)

    def warning(self, message: str, *args: Any, **kwargs: Any) -> None:
        if "find-generic-password" in message or "no key found" in message:
            self.keychain_failed = True
        log.warning("yt-dlp cookies: %s", message)

    def error(self, message: str, *args: Any, **kwargs: Any) -> None:
        log.warning("yt-dlp cookies: %s", message)


def browser_jar(spec: BrowserSpec, logger: _CookieLogger) -> Any:
    """Read every cookie of a browser profile with yt-dlp (blocking; worker thread only)."""
    from yt_dlp import cookies as ytc

    parse = getattr(ytc, "_parse_browser_specification", None)
    browser, profile, keyring, container = (
        parse(spec.browser, spec.profile, spec.keyring, spec.container) if parse else spec
    )
    return ytc.extract_cookies_from_browser(browser, profile, logger, keyring=keyring, container=container)


def file_jar(path: Path) -> http.cookiejar.CookieJar:
    """Parse the youtube.com lines of a Netscape cookies.txt (blocking; worker thread only).

    Lines for other domains and malformed lines are dropped before parsing, so yt-dlp's
    parser never warns about (and prints) a line.
    """
    from yt_dlp.cookies import YoutubeDLCookieJar

    text = path.read_text("utf-8", errors="replace")
    if text.lstrip().startswith(("[", "{")):
        raise NotNetscapeFormat()
    kept = ["# Netscape HTTP Cookie File\n"]
    for line in text.splitlines():
        entry = line[len(_HTTPONLY_PREFIX):] if line.startswith(_HTTPONLY_PREFIX) else line
        if not entry.strip() or entry.startswith("#"):
            continue
        fields = entry.split("\t")
        if len(fields) != 7 or not is_youtube_domain(fields[0]):
            continue
        if fields[4] and not _EXPIRES_RE.fullmatch(fields[4]):
            continue
        kept.append(line + "\n")
    jar = YoutubeDLCookieJar()
    jar.load(io.StringIO("".join(kept)))
    return youtube_only(jar)


class CookieLoader:
    """Loads, filters and caches the configured session's youtube.com cookies."""

    def __init__(self, settings: Settings, clock: Callable[[], float] = time.monotonic) -> None:
        self.settings = settings
        self._clock = clock
        self._jar: http.cookiejar.CookieJar | None = None
        self._failure: AppError | None = None
        self._expires = 0.0
        self._task: asyncio.Task[http.cookiejar.CookieJar] | None = None

    @property
    def configured(self) -> bool:
        return self.settings.signed_in_configured

    @property
    def source_label(self) -> str:
        """Where the cookies come from, for messages: ``"Chrome"`` or ``"the cookies file"``."""
        spec = self.settings.browser_spec
        return browser_display_name(spec.browser) if spec else "the cookies file"

    def invalidate(self) -> None:
        """Forget the cached jar (e.g. YouTube said it's signed out) so the next call reloads it."""
        self._jar = None
        self._failure = None
        self._expires = 0.0

    async def jar(self) -> http.cookiejar.CookieJar | None:
        """The youtube.com cookie jar, or ``None`` when sign-in isn't configured.

        Raises ``AppError("signin_failed")`` when the cookies can't be read. Failures are
        remembered for 30 seconds; concurrent callers share one load.
        """
        if not self.configured:
            return None
        if self._clock() < self._expires:
            if self._jar is not None:
                return self._jar
            if self._failure is not None:
                raise self._failure.clone()
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._load())
            self._task.add_done_callback(_consume_exception)
        try:
            return await asyncio.wait_for(asyncio.shield(self._task), LOAD_TIMEOUT)
        except TimeoutError:
            raise self._error(TimeoutError()) from None

    async def _load(self) -> http.cookiejar.CookieJar:
        logger = _CookieLogger()
        try:
            jar = await asyncio.to_thread(self._load_blocking, logger)
        except Exception as exc:  # noqa: BLE001 - every failure becomes one actionable error
            log.warning("couldn't load YouTube cookies from %s (%s)", self.source_label, type(exc).__name__)
            error = self._error(exc, keychain_failed=logger.keychain_failed)
            self._jar, self._failure, self._expires = None, error, self._clock() + FAILURE_TTL
            raise error from None
        else:
            log.info("loaded %d youtube.com cookies from %s", len(jar), self.source_label)
            self._jar, self._failure, self._expires = jar, None, self._clock() + JAR_TTL
            return jar
        finally:
            self._task = None

    def _load_blocking(self, logger: _CookieLogger) -> http.cookiejar.CookieJar:
        spec = self.settings.browser_spec
        if spec is not None:
            jar = youtube_only(browser_jar(spec, logger))
        else:
            assert self.settings.cookies_file is not None
            jar = file_jar(self.settings.cookies_file)
        if len(jar) == 0:
            raise NoYouTubeCookies()
        return jar

    def _error(self, exc: BaseException, *, keychain_failed: bool = False) -> AppError:
        message = f"Couldn't read your YouTube cookies from {self.source_label}."
        spec = self.settings.browser_spec
        if spec is None:
            hint = _file_hint(exc)
        else:
            hint = _browser_hint(spec.browser, exc, keychain_failed=keychain_failed, profile=spec.profile)
        return AppError("signin_failed", message, status=503, hint=hint, retryable=True)


def _consume_exception(task: asyncio.Task[Any]) -> None:
    if not task.cancelled():
        task.exception()  # mark retrieved even when every waiter timed out


# Where each browser keeps its profiles on macOS, under ~/Library/Application Support.
_MAC_BROWSER_DIRS = {
    "brave": "BraveSoftware/Brave-Browser",
    "chrome": "Google/Chrome",
    "chromium": "Chromium",
    "edge": "Microsoft Edge",
    "firefox": "Firefox",
    "opera": "com.operasoftware.Opera",
    "vivaldi": "Vivaldi",
    "whale": "Naver/Whale",
}


def macos_privacy_blocked(browser: str, profile: str | None) -> bool:
    """True when macOS privacy protection hides the browser's profile folder from this process.

    yt-dlp finds the cookie database by walking that folder, and a walk swallows the
    PermissionError, so the failure surfaces as "not found" although the files exist.
    """
    if sys.platform != "darwin" or browser not in _MAC_BROWSER_DIRS:
        return False
    root = Path.home() / "Library" / "Application Support" / _MAC_BROWSER_DIRS[browser]
    candidates = [Path(profile)] if profile and os.path.isabs(profile) else [root / profile] if profile else []
    for folder in [*candidates, root]:
        if folder.is_dir():
            try:
                os.listdir(folder)
            except PermissionError:
                return True
    return False


def _browser_hint(browser: str, exc: BaseException, *, keychain_failed: bool, profile: str | None = None) -> str:
    name = browser_display_name(browser)
    keychain = browser in _CHROMIUM and sys.platform == "darwin"
    if isinstance(exc, TimeoutError):
        return (f"Reading {name}'s cookies is taking too long. If macOS is asking for Keychain access, "
                "click Always Allow, then try again." if keychain else
                f"Reading {name}'s cookies is taking too long. Try again.")
    if isinstance(exc, NoYouTubeCookies):
        if keychain_failed:
            return (f"macOS didn't let yt-dlp unlock {name}'s cookies. Try again and click Always Allow when "
                    f"macOS asks for Keychain access to \"{name} Safe Storage\".")
        return (f"No YouTube cookies were found. Sign in to YouTube in {name}"
                + (" and allow Keychain access when macOS asks." if keychain else "."))
    if isinstance(exc, PermissionError) and browser == "safari":
        return ("macOS blocks access to Safari's cookies. Give the app that runs the server (e.g. Terminal) "
                "Full Disk Access in System Settings > Privacy & Security, then restart it.")
    if isinstance(exc, FileNotFoundError) and macos_privacy_blocked(browser, profile):
        return (f"macOS is blocking the app that runs the server from reading {name}'s profile folder. Run "
                "make dev from Terminal or iTerm and allow access if macOS asks, or give that app Full Disk "
                "Access in System Settings > Privacy & Security and restart it. Or export a cookies.txt and "
                "set YTC_YTDLP_COOKIES_FILE instead.")
    if isinstance(exc, FileNotFoundError):
        return (f"yt-dlp couldn't find {name}'s cookies. Check that {name} is installed and that the profile "
                "in YTC_YTDLP_COOKIES_FROM_BROWSER exists.")
    if isinstance(exc, PermissionError):
        return f"The server isn't allowed to read {name}'s cookie database. Check its file permissions."
    return (f"Make sure you're signed in to YouTube in {name}"
            + (" and allow Keychain access when macOS asks." if keychain else "."))


def _file_hint(exc: BaseException) -> str:
    if isinstance(exc, FileNotFoundError):
        return "Check that YTC_YTDLP_COOKIES_FILE points to your cookies.txt: there's no file at that path."
    if isinstance(exc, PermissionError):
        return "The server can't read the cookies file. Check its permissions."
    if isinstance(exc, NotNetscapeFormat):
        return "The file must be a Netscape-format cookies.txt (not JSON). Export it again."
    if isinstance(exc, NoYouTubeCookies):
        return "The file has no youtube.com cookies. Export it from a browser that's signed in to YouTube."
    return "Export a fresh Netscape-format cookies.txt while signed in to YouTube."

"""Application settings, read from environment variables (prefix ``YTC_``).

A ``.env`` file at the repository root is loaded if present; real environment
variables always win over values from the file.
"""

from __future__ import annotations

import os
import re
import shlex
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    env_file = REPO_ROOT / ".env"
    # Test runs set this so a developer's .env (which may turn on sign-in) never leaks in.
    if os.environ.get("YTC_IGNORE_DOTENV") == "1" or not env_file.is_file():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - python-dotenv is a pinned dependency
        return
    load_dotenv(env_file, override=False)


def _str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value.strip() if value is not None and value.strip() else default


def _int(name: str, default: int, minimum: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")
    return value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# Mirrors yt-dlp's own parsing of --cookies-from-browser (yt_dlp/__init__.py):
# BROWSER[+KEYRING][:PROFILE][::CONTAINER]
_BROWSER_SPEC_RE = re.compile(r"""(?x)
    (?P<name>[^+:]+)
    (?:\s*\+\s*(?P<keyring>[^:]+))?
    (?:\s*:\s*(?!:)(?P<profile>.+?))?
    (?:\s*::\s*(?P<container>.+))?
""")
# Copies of yt_dlp.cookies.SUPPORTED_BROWSERS / SUPPORTED_KEYRINGS, used only if yt-dlp
# can't be imported in-process (e.g. YTC_YTDLP_COMMAND points at a separate install).
_FALLBACK_BROWSERS = frozenset({"brave", "chrome", "chromium", "edge", "opera", "vivaldi", "whale",
                                "firefox", "safari"})
_FALLBACK_KEYRINGS = frozenset({"KWALLET", "KWALLET5", "KWALLET6", "GNOMEKEYRING", "BASICTEXT"})


class BrowserSpec(NamedTuple):
    browser: str
    keyring: str | None = None
    profile: str | None = None
    container: str | None = None

    def to_arg(self) -> str:
        """Canonical ``--cookies-from-browser`` value (one argv element, never shell-parsed)."""
        arg = self.browser
        if self.keyring:
            arg += f"+{self.keyring}"
        if self.profile:
            arg += f":{self.profile}"
        if self.container:
            arg += f"::{self.container}"
        return arg


def _supported_browsers_and_keyrings() -> tuple[frozenset[str], frozenset[str]]:
    try:
        from yt_dlp.cookies import SUPPORTED_BROWSERS, SUPPORTED_KEYRINGS
    except ImportError:  # pragma: no cover - yt-dlp is a pinned dependency
        return _FALLBACK_BROWSERS, _FALLBACK_KEYRINGS
    return frozenset(SUPPORTED_BROWSERS), frozenset(SUPPORTED_KEYRINGS)


def parse_browser_spec(spec: str) -> BrowserSpec:
    """Parse ``BROWSER[+KEYRING][:PROFILE][::CONTAINER]`` exactly as yt-dlp does.

    Raises :class:`ValueError` (naming the environment variable) when malformed.
    """
    name = "YTC_YTDLP_COOKIES_FROM_BROWSER"
    match = _BROWSER_SPEC_RE.fullmatch(spec.strip())
    if match is None:
        raise ValueError(f"{name} is not valid: {spec!r}. Use BROWSER[+KEYRING][:PROFILE][::CONTAINER], "
                         "e.g. chrome, safari, firefox or \"chrome:Profile 1\".")
    browser, keyring, profile, container = match.group("name", "keyring", "profile", "container")
    browser = browser.strip().lower()
    browsers, keyrings = _supported_browsers_and_keyrings()
    if browser not in browsers:
        raise ValueError(f"{name} names an unsupported browser: {browser!r}. "
                         f"Supported browsers are: {', '.join(sorted(browsers))}.")
    if keyring is not None:
        keyring = keyring.strip().upper()
        if keyring not in keyrings:
            raise ValueError(f"{name} names an unsupported keyring: {keyring!r}. "
                             f"Supported keyrings are: {', '.join(sorted(keyrings))}.")
    return BrowserSpec(browser, keyring, profile, container)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    # Discovery
    page_size: int = 20
    max_search_results: int = 100
    max_list_results: int = 500
    metadata_cache_ttl: int = 600
    metadata_cache_entries: int = 256
    discovery_timeout: int = 45
    # Media preparation
    max_height: int = 720
    max_concurrent_jobs: int = 2
    max_queued_jobs: int = 16
    max_download_bytes: int = 1024 * 1024 * 1024
    max_duration_seconds: int = 2 * 60 * 60
    resolve_timeout: int = 60
    download_timeout: int = 30 * 60
    process_timeout: int = 30 * 60
    # Transcoding limits (only used when remuxing is not possible)
    transcode_preset: str = "veryfast"
    transcode_crf: int = 23
    transcode_audio_bitrate: str = "128k"
    ffmpeg_threads: int = 2
    # Cache
    cache_max_bytes: int = 4 * 1024 * 1024 * 1024
    cache_ttl_seconds: int = 6 * 60 * 60
    min_free_disk_bytes: int = 1024 * 1024 * 1024
    cleanup_interval_seconds: int = 300
    # External tools
    ytdlp_command: tuple[str, ...] = field(default_factory=lambda: (sys.executable, "-m", "yt_dlp"))
    ytdlp_js_runtimes: tuple[str, ...] = ()
    # A bgutil PO token server (bgutil-ytdlp-pot-provider), which yt-dlp asks for tokens when
    # YouTube wants them (as it does from datacenter IPs).
    pot_provider_url: str | None = None
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    # Features
    enable_demo: bool = True
    demo_readrate: int = 0  # cap demo generation at N× real time; 0 = as fast as possible
    enable_feeds: bool = True  # curated public YouTube pages (Music, News, ...) and related videos
    # Streaming playback: YouTube's DASH tracks proxied in byte ranges into Media Source Extensions.
    enable_streaming: bool = True
    stream_max_height: int = 2160
    stream_max_range_bytes: int = 16 * 1024 * 1024
    frontend_dist: Path | None = None
    log_level: str = "INFO"
    # Opt-in YouTube sign-in: yt-dlp reads the account's cookies from a browser profile
    # (BROWSER[+KEYRING][:PROFILE][::CONTAINER]) or from a Netscape cookies.txt file.
    cookies_from_browser: str | None = None
    cookies_file: Path | None = None
    mark_watched: bool = False  # add prepared videos to the account's watch history
    # Add-on apps (Plex, ...): which are on, and later their sign-ins. Kept apart from the
    # media cache, which the OS may clear. None means <data dir>/config, as in tests.
    config_dir: Path | None = None
    enable_apps: bool = True
    # Plex sign-in: plex.tv's API and the page where people approve a sign-in (overridable for tests).
    plex_tv_url: str = "https://plex.tv"
    plex_auth_url: str = "https://app.plex.tv/auth"
    # Accounts (Clerk sign-in, data in Convex). Off unless a Clerk publishable key is set: without
    # one, yt-canvas runs in no-login mode (one implicit user, this computer and paired devices).
    clerk_publishable_key: str | None = None
    clerk_secret_key: str | None = None
    clerk_api_url: str = "https://api.clerk.com"
    # Clerk's PEM public key (CLERK_JWT_KEY): verifies session tokens without fetching the JWKS.
    clerk_jwt_key: str | None = None
    convex_site_url: str | None = None  # https://<deployment>.convex.site
    convex_secret: str | None = None  # shared with the /backend HTTP action
    secrets_key: str | None = None  # AES-256-GCM key (urlsafe base64) for secrets kept in Convex
    admin_emails: tuple[str, ...] = ()
    # Origins whose session tokens are accepted (the token's azp). Empty: the request's own origin.
    allowed_origins: tuple[str, ...] = ()
    # The server-wide YouTube cookies were configured but are ignored because accounts are on.
    ignored_server_cookies: bool = False

    def __post_init__(self) -> None:
        if self.cookies_from_browser is not None:
            parse_browser_spec(self.cookies_from_browser)
        if self.cookies_from_browser and self.cookies_file:
            raise ValueError("Set only one of YTC_YTDLP_COOKIES_FROM_BROWSER and YTC_YTDLP_COOKIES_FILE.")
        if self.accounts_enabled:
            missing = [name for name, value in (("CLERK_SECRET_KEY", self.clerk_secret_key),
                                                ("CONVEX_SITE_URL", self.convex_site_url),
                                                ("YTC_CONVEX_SECRET", self.convex_secret),
                                                ("YTC_SECRETS_KEY", self.secrets_key)) if not value]
            if missing:
                raise ValueError(f"Accounts are on (a Clerk publishable key is set), so these must be set too: "
                                 f"{', '.join(missing)}. Or set YTC_ACCOUNTS=off for no-login mode.")

    @property
    def accounts_enabled(self) -> bool:
        return bool(self.clerk_publishable_key)

    @property
    def signed_in_configured(self) -> bool:
        """True when yt-dlp and page fetches should use the account's cookies."""
        return bool(self.cookies_from_browser or self.cookies_file)

    @property
    def browser_spec(self) -> BrowserSpec | None:
        return parse_browser_spec(self.cookies_from_browser) if self.cookies_from_browser else None

    @property
    def signin_source(self) -> str | None:
        """Short human name of where the cookies come from: ``"chrome"``, ``"cookies file"``."""
        spec = self.browser_spec
        if spec is not None:
            return spec.browser
        return "cookies file" if self.cookies_file else None

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def work_dir(self) -> Path:
        return self.data_dir / "work"

    @property
    def ytdlp_cache_dir(self) -> Path:
        return self.data_dir / "ytdlp-cache"

    @property
    def streams_dir(self) -> Path:
        """Locally generated demo streaming tracks (YouTube streams never touch the disk)."""
        return self.data_dir / "streams"

    @property
    def app_config_dir(self) -> Path:
        return self.config_dir or self.data_dir / "config"

    @property
    def profile(self) -> str:
        """Identifies the preparation profile; part of cache keys."""
        return f"{self.max_height}p"


def _first(*names: str) -> str | None:
    """The first of these environment variables that is set (Clerk and Convex have several spellings)."""
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return None


def load_settings() -> Settings:
    _load_dotenv()
    accounts = _str("YTC_ACCOUNTS", "auto").lower() != "off"
    publishable = _first("YTC_CLERK_PUBLISHABLE_KEY", "CLERK_PUBLISHABLE_KEY", "VITE_CLERK_PUBLISHABLE_KEY",
                         "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") if accounts else None
    data_dir = Path(_str("YTC_DATA_DIR", str(Path(tempfile.gettempdir()) / "yt-canvas"))).expanduser()

    ytdlp_cmd_raw = os.environ.get("YTC_YTDLP_COMMAND", "").strip()
    ytdlp_command = tuple(shlex.split(ytdlp_cmd_raw)) if ytdlp_cmd_raw else (sys.executable, "-m", "yt_dlp")

    runtimes_raw = os.environ.get("YTC_YTDLP_JS_RUNTIMES", "").strip()
    js_runtimes = tuple(part.strip() for part in runtimes_raw.split(",") if part.strip())

    pot_url = os.environ.get("YTC_POT_PROVIDER_URL", "").strip().rstrip("/")
    if pot_url and not re.fullmatch(r"https?://[^\s;,]+", pot_url):
        raise ValueError(f"YTC_POT_PROVIDER_URL must be an http:// or https:// address, got {pot_url!r}")

    browser_raw = os.environ.get("YTC_YTDLP_COOKIES_FROM_BROWSER", "").strip()
    cookies_raw = os.environ.get("YTC_YTDLP_COOKIES_FILE", "").strip()
    # With accounts on, everyone brings their own cookies; the server-wide ones are left alone.
    ignored_server_cookies = bool(publishable and (browser_raw or cookies_raw))
    if publishable:
        browser_raw = cookies_raw = ""
    cookies_file = None
    if cookies_raw:
        cookies_file = Path(cookies_raw).expanduser().absolute()
        if cookies_file.is_dir():
            raise ValueError(f"YTC_YTDLP_COOKIES_FILE must be a cookies.txt file, not a directory: {cookies_raw!r}")

    dist_raw = os.environ.get("YTC_FRONTEND_DIST", "").strip()
    frontend_dist = Path(dist_raw).expanduser() if dist_raw else REPO_ROOT / "frontend" / "dist"

    mb = 1024 * 1024
    return Settings(
        data_dir=data_dir,
        page_size=_int("YTC_PAGE_SIZE", 20, minimum=1),
        max_search_results=_int("YTC_MAX_SEARCH_RESULTS", 100, minimum=1),
        max_list_results=_int("YTC_MAX_LIST_RESULTS", 500, minimum=1),
        metadata_cache_ttl=_int("YTC_METADATA_CACHE_TTL", 600, minimum=0),
        discovery_timeout=_int("YTC_DISCOVERY_TIMEOUT", 45, minimum=5),
        max_height=_int("YTC_MAX_HEIGHT", 720, minimum=144),
        max_concurrent_jobs=_int("YTC_MAX_CONCURRENT_JOBS", 2, minimum=1),
        max_queued_jobs=_int("YTC_MAX_QUEUED_JOBS", 16, minimum=1),
        max_download_bytes=_int("YTC_MAX_DOWNLOAD_MB", 1024, minimum=1) * mb,
        max_duration_seconds=_int("YTC_MAX_DURATION_SECONDS", 7200, minimum=1),
        resolve_timeout=_int("YTC_RESOLVE_TIMEOUT", 60, minimum=5),
        download_timeout=_int("YTC_DOWNLOAD_TIMEOUT", 1800, minimum=10),
        process_timeout=_int("YTC_PROCESS_TIMEOUT", 1800, minimum=10),
        transcode_preset=_str("YTC_TRANSCODE_PRESET", "veryfast"),
        transcode_crf=_int("YTC_TRANSCODE_CRF", 23, minimum=0),
        transcode_audio_bitrate=_str("YTC_TRANSCODE_AUDIO_BITRATE", "128k"),
        ffmpeg_threads=_int("YTC_FFMPEG_THREADS", 2, minimum=0),
        cache_max_bytes=_int("YTC_CACHE_MAX_MB", 4096, minimum=1) * mb,
        cache_ttl_seconds=_int("YTC_CACHE_TTL_HOURS", 6, minimum=1) * 3600,
        min_free_disk_bytes=_int("YTC_MIN_FREE_DISK_MB", 1024, minimum=0) * mb,
        cleanup_interval_seconds=_int("YTC_CLEANUP_INTERVAL_SECONDS", 300, minimum=10),
        ytdlp_command=ytdlp_command,
        ytdlp_js_runtimes=js_runtimes,
        pot_provider_url=pot_url or None,
        ffmpeg_path=_str("YTC_FFMPEG_PATH", "ffmpeg"),
        ffprobe_path=_str("YTC_FFPROBE_PATH", "ffprobe"),
        enable_demo=_bool("YTC_ENABLE_DEMO", True),
        demo_readrate=_int("YTC_DEMO_READRATE", 0, minimum=0),
        enable_feeds=_bool("YTC_ENABLE_FEEDS", True),
        enable_streaming=_bool("YTC_ENABLE_STREAMING", True),
        stream_max_height=_int("YTC_STREAM_MAX_HEIGHT", 2160, minimum=144),
        stream_max_range_bytes=_int("YTC_STREAM_MAX_RANGE_MB", 16, minimum=1) * mb,
        frontend_dist=frontend_dist,
        log_level=_str("YTC_LOG_LEVEL", "INFO").upper(),
        cookies_from_browser=browser_raw or None,
        cookies_file=cookies_file,
        mark_watched=_bool("YTC_MARK_WATCHED", False),
        config_dir=Path(_str("YTC_CONFIG_DIR", str(Path.home() / ".config" / "yt-canvas"))).expanduser(),
        enable_apps=_bool("YTC_ENABLE_APPS", True),
        plex_tv_url=_str("YTC_PLEX_TV_URL", "https://plex.tv").rstrip("/"),
        plex_auth_url=_str("YTC_PLEX_AUTH_URL", "https://app.plex.tv/auth"),
        clerk_publishable_key=publishable,
        clerk_secret_key=_first("CLERK_SECRET_KEY"),
        clerk_api_url=_str("YTC_CLERK_API_URL", "https://api.clerk.com").rstrip("/"),
        clerk_jwt_key=_first("CLERK_JWT_KEY"),
        convex_site_url=(_first("CONVEX_SITE_URL", "CONVEX_ENDPOINT") or "").rstrip("/") or None,
        convex_secret=_first("YTC_CONVEX_SECRET"),
        secrets_key=_first("YTC_SECRETS_KEY"),
        admin_emails=tuple(e.strip().lower() for e in _str("YTC_ADMIN_EMAILS", "").split(",") if e.strip()),
        allowed_origins=tuple(o.strip().rstrip("/") for o in _str("YTC_ALLOWED_ORIGINS", "").split(",") if o.strip()),
        ignored_server_cookies=ignored_server_cookies,
    )

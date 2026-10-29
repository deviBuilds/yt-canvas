"""Shared yt-dlp invocation helpers: base arguments and error classification.

Discovery and media preparation both call yt-dlp, but only through argument
arrays built here. User input never becomes an option: every URL is rebuilt
from validated IDs and placed after a ``--`` separator.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from .config import Settings
from .errors import AppError, redact
from .procs import ExecutableNotFound, OutputLimitExceeded, ProcessResult, ProcessTimeout, run_process

log = logging.getLogger(__name__)


def base_args(settings: Settings) -> list[str]:
    args = [
        *settings.ytdlp_command,
        "--ignore-config",
        "--color",
        "never",
        "--socket-timeout",
        "20",
        "--extractor-retries",
        "2",
        "--cache-dir",
        str(settings.ytdlp_cache_dir),
    ]
    for runtime in settings.ytdlp_js_runtimes:
        args += ["--js-runtimes", runtime]
    # Opt-in sign-in. yt-dlp reads the cookies itself on every run; with --cookies it also
    # writes the (possibly refreshed) jar back to that file when it exits.
    spec = settings.browser_spec
    if spec is not None:
        args += ["--cookies-from-browser", spec.to_arg()]
    elif settings.cookies_file is not None:
        args += ["--cookies", str(settings.cookies_file)]
    return args


SIGNIN_HINT = "This video needs a signed-in account; see Signing in in the README."


# (pattern, code, http status, user message, hint, retryable)
_ERROR_RULES: list[tuple[re.Pattern[str], str, int, str, str | None, bool]] = [
    (
        re.compile(r"Private video", re.I),
        "unavailable",
        404,
        "This video is private.",
        None,
        False,
    ),
    (
        re.compile(r"live event will begin|Premieres in|scheduled to start|is_upcoming", re.I),
        "live_unsupported",
        422,
        "This is an upcoming live stream or premiere, which can't be played yet.",
        "Only public, non-live videos are supported in this version.",
        False,
    ),
    (
        re.compile(r"Sign in to confirm your age|age[- ]restricted|inappropriate for some users", re.I),
        "restricted",
        403,
        "This video is age-restricted and requires a signed-in account.",
        "Age-restricted videos need a signed-in, age-verified account; see Signing in in the README.",
        False,
    ),
    (
        re.compile(r"members[- ]only|Join this channel|requires payment|purchase", re.I),
        "restricted",
        403,
        "This video is limited to members or paying viewers.",
        "It needs a signed-in account with access to it; see Signing in in the README.",
        False,
    ),
    (
        re.compile(r"confirm you.re not a bot|bot detection", re.I),
        "youtube_blocked",
        503,
        "YouTube is asking this server to prove it isn't a bot.",
        "YouTube is rate-limiting or blocking this server's network. Try again later or from another network.",
        True,
    ),
    (
        re.compile(r"could not find \w+ cookies database|failed to load cookies|"
                   r"unsupported browser specified for cookies|Netscape format(ted)? cookies file|"
                   r"Cookies file must be Netscape", re.I),
        "signin_failed",
        503,
        "yt-dlp couldn't read the YouTube cookies.",
        "Check YTC_YTDLP_COOKIES_FROM_BROWSER or YTC_YTDLP_COOKIES_FILE; see Signing in in the README.",
        True,
    ),
    (
        re.compile(r"Login details are needed|only available for registered users|"
                   r"cookies are no longer valid", re.I),
        "signed_out",
        401,
        "YouTube needs a signed-in account for this.",
        "If sign-in is set up, YouTube didn't accept the cookies (signed out or expired): sign in to "
        "YouTube in that browser again, or export a fresh cookies file. See Signing in in the README.",
        False,
    ),
    (
        re.compile(r"Requested format is not available|No video formats found", re.I),
        "no_formats",
        422,
        "YouTube offered no playable formats for this video.",
        "Updating yt-dlp may help.",
        True,
    ),
    (
        re.compile(r"Video unavailable|video is (no longer )?unavailable|has been removed|"
                   r"account associated with this video has been terminated|is not available|"
                   r"copyright claim|blocked it in your country|not made this video available", re.I),
        "unavailable",
        404,
        "This video is unavailable.",
        "It may have been removed, made private, or blocked in this region.",
        False,
    ),
    (
        re.compile(r"HTTP Error 403", re.I),
        "download_forbidden",
        502,
        "YouTube refused to send the media data (HTTP 403).",
        "YouTube sometimes rejects downloads from servers or networks it restricts. "
        "Updating yt-dlp often helps; otherwise try again later or from another network.",
        True,
    ),
    (
        re.compile(r"HTTP Error 429|Too Many Requests", re.I),
        "rate_limited",
        503,
        "YouTube is rate-limiting requests from this server.",
        "Wait a few minutes and try again.",
        True,
    ),
    (
        re.compile(r"No supported JavaScript runtime|JS runtime|challenge solving failed|"
                   r"Signature extraction failed|n challenge", re.I),
        "js_runtime_problem",
        503,
        "yt-dlp could not solve YouTube's JavaScript challenge.",
        "Install Deno >= 2.3 (or set YTC_YTDLP_JS_RUNTIMES=node with Node >= 22) and keep "
        "yt-dlp and yt-dlp-ejs up to date.",
        True,
    ),
    (
        re.compile(r"ffmpeg (is )?not (found|installed)|ffprobe .*not found", re.I),
        "dependency_missing",
        500,
        "FFmpeg is required but was not found.",
        "Install ffmpeg and ffprobe and make sure they are on PATH.",
        False,
    ),
    (
        re.compile(r"(channel|playlist) does not exist|This channel does not have|"
                   r"The playlist does not exist|HTTP Error 404|Unable to recognize tab", re.I),
        "not_found",
        404,
        "YouTube could not find that channel or playlist.",
        None,
        False,
    ),
    (
        re.compile(r"Unsupported URL|Incomplete YouTube ID|Invalid video ID", re.I),
        "invalid_input",
        400,
        "yt-dlp did not recognise that YouTube address.",
        None,
        False,
    ),
    (
        re.compile(r"Unable to download (webpage|API page|JSON)|Failed to resolve|Name or service not known|"
                   r"timed out|Connection (refused|reset)|Network is unreachable|Temporary failure", re.I),
        "network_error",
        502,
        "Could not reach YouTube.",
        "Check the server's internet connection and try again.",
        True,
    ),
]


def classify_error(stderr: str, *, default_code: str = "extraction_failed") -> AppError:
    """Turn yt-dlp's stderr into an actionable :class:`AppError`.

    ERROR lines are checked first so that warnings don't mask the real cause.
    """
    error_lines = "\n".join(line for line in stderr.splitlines() if line.startswith("ERROR"))
    for haystack in (error_lines, stderr):
        if not haystack:
            continue
        for pattern, code, status, message, hint, retryable in _ERROR_RULES:
            if pattern.search(haystack):
                return AppError(code, message, status=status, hint=hint, retryable=retryable)
    if default_code == "download_failed":
        return AppError("download_failed", "Downloading the media failed.", status=502, retryable=True)
    return AppError(
        default_code,
        "yt-dlp could not extract information from YouTube.",
        status=502,
        hint="Updating yt-dlp often fixes extraction problems.",
        retryable=True,
    )


# yt-dlp quotes the offending line (cookie name and value) when it can't parse a cookies.txt entry.
_COOKIE_LINE_RE = re.compile(r"cookie file entry|Netscape format cookies file", re.I)


def _without_cookie_lines(text: str) -> str:
    return "\n".join("<line about the cookies file removed>" if _COOKIE_LINE_RE.search(line) else line
                     for line in text.splitlines())


def log_failure(context: str, result_or_tail: ProcessResult | str) -> None:
    tail = result_or_tail.stderr_tail if isinstance(result_or_tail, ProcessResult) else result_or_tail
    log.warning("%s failed; yt-dlp stderr (redacted):\n%s", context, redact(_without_cookie_lines(tail[-8000:])))


async def run_json(settings: Settings, args: list[str], *, timeout: float, context: str) -> dict[str, Any]:
    """Run yt-dlp with ``-J`` style output and parse the JSON document."""
    try:
        result = await run_process(args, timeout=timeout, max_stdout=48 * 1024 * 1024)
    except ExecutableNotFound as exc:
        raise AppError(
            "dependency_missing",
            "yt-dlp is not installed.",
            status=500,
            hint="Install the backend requirements (pip install -r backend/requirements.txt).",
        ) from exc
    except ProcessTimeout as exc:
        log_failure(context, exc.stderr_tail)
        raise AppError("timeout", "YouTube took too long to respond.", status=504, retryable=True) from exc
    except OutputLimitExceeded as exc:
        raise AppError("extraction_failed", "YouTube returned an unexpectedly large response.", status=502) from exc

    if result.returncode != 0:
        log_failure(context, result)
        raise classify_error(result.stderr_tail)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        log_failure(context, result)
        raise AppError("extraction_failed", "yt-dlp returned unreadable output.", status=502, retryable=True) from exc
    if not isinstance(data, dict):
        raise AppError("extraction_failed", "yt-dlp returned unexpected output.", status=502)
    return data

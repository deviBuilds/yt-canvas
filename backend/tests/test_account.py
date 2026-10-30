"""Opt-in YouTube sign-in: settings, yt-dlp options, cookies, /api/me, personal feeds, loopback guard.

No test reads cookies from a real browser: ``app.cookies.browser_jar`` is replaced
for every test (and fails loudly if a test forgets to stub it). File-mode tests use
small cookies.txt files with obviously fake values. No network: page fetches and
yt-dlp listings are monkeypatched.
"""

import http.cookiejar
import json
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import config as config_module
from app import cookies as cookies_module
from app.config import Settings, load_settings, parse_browser_spec
from app.cookies import CookieLoader, file_jar, is_youtube_domain
from app.discovery import youtube_pages as yp
from app.discovery.account import parse_chips, parse_home
from app.discovery.normalize import normalize_entry
from app.discovery.ytdlp_provider import YtDlpDiscoveryProvider
from app.errors import AppError
from app.main import create_app
from app.media.youtube import YouTubeMediaProvider, check_playable
from app.ytdlp import base_args, classify_error

from .conftest import with_settings

AVATAR_88 = "https://yt3.ggpht.com/me-avatar=s88-c-k-c0x00ffffff-no-rj"
AVATAR_176 = "https://yt3.ggpht.com/me-avatar=s176-c-k-c0x00ffffff-no-rj"
FAKE_VALUE = "fake-value-must-never-be-logged"

DUMMY_COOKIES = "\n".join([
    "# Netscape HTTP Cookie File",
    "# obviously fake values for tests",
    f".youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\t{FAKE_VALUE}",
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2000000000\tLOGIN_INFO\tfake-login",
    "www.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tf6=8",
    ".google.com\tTRUE\t/\tTRUE\t2000000000\tSID\tfake-google",
    ".notyoutube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tfake-other",
    "this line is not a cookie",
    "",
])


@pytest.fixture(autouse=True)
def no_real_browser(monkeypatch):
    def refuse(spec, logger):
        raise AssertionError("tests must never read cookies from a real browser")

    monkeypatch.setattr(cookies_module, "browser_jar", refuse)


def cookie(domain: str, name: str = "SID", value: str = FAKE_VALUE) -> http.cookiejar.Cookie:
    return http.cookiejar.Cookie(
        version=0, name=name, value=value, port=None, port_specified=False, domain=domain,
        domain_specified=True, domain_initial_dot=domain.startswith("."), path="/", path_specified=True,
        secure=True, expires=2_000_000_000, discard=False, comment=None, comment_url=None, rest={},
    )


def fake_browser(*domains: str, warn: str | None = None, calls: list | None = None):
    def load(spec, logger):
        if calls is not None:
            calls.append(spec)
        if warn:
            logger.warning(warn)
        jar = http.cookiejar.CookieJar()
        for domain in domains:
            jar.set_cookie(cookie(domain))
        return jar

    return load


@pytest.fixture
def cookies_file(tmp_path: Path) -> Path:
    path = tmp_path / "cookies.txt"
    path.write_text(DUMMY_COOKIES, "utf-8")
    return path


@pytest.fixture
def browser_settings(settings):
    return with_settings(settings, cookies_from_browser="chrome")


@pytest.fixture
def file_settings(settings, cookies_file):
    return with_settings(settings, cookies_file=cookies_file)


def local_client(app, host: str = "127.0.0.1") -> TestClient:
    return TestClient(app, client=(host, 50000), base_url="http://localhost:8000")


# --- Settings -----------------------------------------------------------------

_ENV = ("YTC_YTDLP_COOKIES_FROM_BROWSER", "YTC_YTDLP_COOKIES_FILE", "YTC_MARK_WATCHED")


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setattr(config_module, "_load_dotenv", lambda: None)
    monkeypatch.setenv("YTC_DATA_DIR", str(tmp_path / "data"))
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_sign_in_is_off_by_default(env):
    settings = load_settings()
    assert settings.signed_in_configured is False and settings.signin_source is None
    assert settings.cookies_from_browser is None and settings.cookies_file is None
    assert settings.mark_watched is False


@pytest.mark.parametrize("spec, browser", [
    ("chrome", "chrome"), ("Safari", "safari"), ("firefox", "firefox"), ("chrome:Profile 1", "chrome"),
    ("firefox::Work", "firefox"), ("chrome+gnomekeyring:Default", "chrome"),
])
def test_cookies_from_browser(env, spec, browser):
    env.setenv("YTC_YTDLP_COOKIES_FROM_BROWSER", spec)
    settings = load_settings()
    assert settings.signed_in_configured is True
    assert settings.signin_source == browser
    assert settings.cookies_from_browser == spec


@pytest.mark.parametrize("spec", ["netscape", "chrome:", ":Profile 1", "chrome+bogus", "chrome+:Default"])
def test_malformed_browser_spec_fails_startup(env, spec):
    env.setenv("YTC_YTDLP_COOKIES_FROM_BROWSER", spec)
    with pytest.raises(ValueError, match="YTC_YTDLP_COOKIES_FROM_BROWSER"):
        load_settings()


def test_browser_spec_is_parsed_like_ytdlp():
    assert parse_browser_spec("Chrome + basictext : Profile 2::Personal") == (
        "chrome", "BASICTEXT", "Profile 2", "Personal")
    assert parse_browser_spec("chrome + basictext : Profile 2").to_arg() == "chrome+BASICTEXT:Profile 2"


def test_cookies_file_expands_home(env, monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    env.setenv("YTC_YTDLP_COOKIES_FILE", "~/yt/cookies.txt")
    settings = load_settings()
    assert settings.cookies_file == tmp_path / "yt" / "cookies.txt"
    assert settings.signed_in_configured is True and settings.signin_source == "cookies file"


def test_cookies_file_must_not_be_a_directory(env, tmp_path):
    env.setenv("YTC_YTDLP_COOKIES_FILE", str(tmp_path))
    with pytest.raises(ValueError, match="YTC_YTDLP_COOKIES_FILE"):
        load_settings()


def test_both_cookie_sources_fail_startup(env, cookies_file):
    env.setenv("YTC_YTDLP_COOKIES_FROM_BROWSER", "chrome")
    env.setenv("YTC_YTDLP_COOKIES_FILE", str(cookies_file))
    with pytest.raises(ValueError, match="only one"):
        load_settings()
    with pytest.raises(ValueError):
        Settings(data_dir=cookies_file.parent, cookies_from_browser="chrome", cookies_file=cookies_file)


@pytest.mark.parametrize("raw, expected", [("true", True), ("1", True), ("false", False), ("", False)])
def test_mark_watched_setting(env, raw, expected):
    env.setenv("YTC_MARK_WATCHED", raw)
    assert load_settings().mark_watched is expected


# --- yt-dlp options -----------------------------------------------------------

def test_base_args_without_sign_in(settings):
    args = base_args(settings)
    assert not {"--cookies", "--cookies-from-browser", "--mark-watched"} & set(args)


def test_base_args_with_browser_cookies(settings):
    args = base_args(with_settings(settings, cookies_from_browser="Chrome + basictext:Profile 1"))
    assert args[args.index("--cookies-from-browser") + 1] == "chrome+BASICTEXT:Profile 1"
    assert "--cookies" not in args and "--mark-watched" not in args


def test_base_args_with_cookies_file(file_settings, cookies_file):
    args = base_args(file_settings)
    assert args[args.index("--cookies") + 1] == str(cookies_file)
    assert "--cookies-from-browser" not in args


class _Stop(Exception):
    pass


async def _resolve_args(monkeypatch, settings) -> list[str]:
    captured: list[list[str]] = []

    async def fake_run_json(settings, args, *, timeout, context):
        captured.append(args)
        raise _Stop()

    monkeypatch.setattr("app.media.youtube.run_json", fake_run_json)
    with pytest.raises(_Stop):
        await YouTubeMediaProvider(settings).resolve("aqz-KE-bpKQ", None)
    return captured[0]


async def _discovery_args(monkeypatch, settings) -> list[list[str]]:
    captured: list[list[str]] = []

    async def fake_run_json(settings, args, *, timeout, context):
        captured.append(args)
        return {"entries": []}

    monkeypatch.setattr("app.discovery.ytdlp_provider.run_json", fake_run_json)
    provider = YtDlpDiscoveryProvider(settings)
    await provider.search("cats", offset=0, limit=20)
    await provider.channel("@BlenderOfficial", offset=0, limit=20)
    await provider.feed(":ytrec", title="Recommended", offset=0, limit=20)
    return captured


@pytest.mark.anyio
async def test_mark_watched_only_on_media_preparation(monkeypatch, file_settings):
    settings = with_settings(file_settings, mark_watched=True)
    resolve = await _resolve_args(monkeypatch, settings)
    assert "--mark-watched" in resolve and "--cookies" in resolve
    assert resolve.index("--mark-watched") < resolve.index("--")
    for args in await _discovery_args(monkeypatch, settings):
        assert "--mark-watched" not in args and "--cookies" in args


@pytest.mark.anyio
@pytest.mark.parametrize("signed_in, mark", [(True, False), (False, True), (False, False)])
async def test_no_mark_watched_unless_enabled_and_signed_in(monkeypatch, settings, cookies_file, signed_in, mark):
    settings = with_settings(settings, mark_watched=mark, cookies_file=cookies_file if signed_in else None)
    assert "--mark-watched" not in await _resolve_args(monkeypatch, settings)


# --- Restricted videos --------------------------------------------------------

@pytest.mark.parametrize("availability", ["needs_auth", "subscriber_only", "premium_only"])
def test_restricted_videos_not_prerejected_when_signed_in(settings, browser_settings, availability):
    check_playable({"availability": availability, "duration": 60}, browser_settings)
    with pytest.raises(AppError) as info:
        check_playable({"availability": availability, "duration": 60}, settings)
    assert info.value.code == "restricted" and "Signing in" in info.value.hint


def test_restricted_entries_stay_listed_as_available_when_signed_in():
    entry = {"id": "aqz-KE-bpKQ", "title": "Members video", "availability": "subscriber_only"}
    assert normalize_entry(entry).available is False
    assert normalize_entry(entry, signed_in=True).available is True
    private = {"id": "aqz-KE-bpKQ", "title": "[Private video]", "availability": "private"}
    assert normalize_entry(private, signed_in=True).available is False


@pytest.mark.parametrize("stderr, code, status", [
    ("ERROR: [youtube:tab] :ytsubs: Login details are needed to download this content. Use --cookies",
     "signed_out", 401),
    ("ERROR: [youtube] abc: This video is only available for registered users", "signed_out", 401),
    ('ERROR: could not find chrome cookies database in "/Users/x/Library"', "signin_failed", 503),
    ("ERROR: [youtube] abc: Sign in to confirm your age. Use --cookies-from-browser or --cookies",
     "restricted", 403),
])
def test_signin_errors_are_classified(stderr, code, status):
    error = classify_error(stderr)
    assert (error.code, error.status) == (code, status)
    assert "not supported" not in (error.hint or "")


def test_ytdlp_cookie_file_warnings_are_not_logged(caplog):
    from app.ytdlp import log_failure

    log_failure("feed", f"WARNING: skipping cookie file entry due to invalid length 3: 'SID\\t{FAKE_VALUE}'\n"
                        "ERROR: [youtube:tab] WL: YouTube said: The playlist does not exist.")
    assert FAKE_VALUE not in caplog.text and "The playlist does not exist" in caplog.text


# --- Cookie loading -----------------------------------------------------------

def test_youtube_domain_filter():
    assert all(map(is_youtube_domain, ["youtube.com", ".youtube.com", "www.youtube.com", "M.YouTube.com"]))
    assert not any(map(is_youtube_domain, ["google.com", ".notyoutube.com", "youtube.com.evil", "yt.be"]))


def test_cookies_file_keeps_only_youtube_cookies(cookies_file):
    jar = file_jar(cookies_file)
    assert sorted((c.domain, c.name) for c in jar) == [
        (".youtube.com", "LOGIN_INFO"), (".youtube.com", "SID"), ("www.youtube.com", "PREF")]


def test_page_requests_send_the_cookies_only_to_youtube(cookies_file):
    import urllib.request

    from app.cookies import copy_jar

    processor = urllib.request.HTTPCookieProcessor(copy_jar(file_jar(cookies_file)))
    youtube = processor.http_request(yp.build_request("https://www.youtube.com/"))
    assert {"SID", "LOGIN_INFO", "PREF"} == {part.split("=")[0] for part in youtube.get_header("Cookie").split("; ")}
    for url in ("https://www.google.com/", "https://accounts.google.com/", "https://notyoutube.com/"):
        assert processor.http_request(yp.build_request(url)).get_header("Cookie") is None


@pytest.mark.anyio
async def test_browser_cookies_are_filtered_and_cached(monkeypatch, browser_settings):
    calls: list = []
    monkeypatch.setattr(cookies_module, "browser_jar",
                        fake_browser(".youtube.com", "www.youtube.com", ".google.com", calls=calls))
    now = [1000.0]
    loader = CookieLoader(browser_settings, clock=lambda: now[0])
    jar = await loader.jar()
    assert sorted(c.domain for c in jar) == [".youtube.com", "www.youtube.com"]
    assert calls[0].browser == "chrome"
    assert await loader.jar() is jar and len(calls) == 1
    now[0] += 601  # cached for ten minutes
    assert await loader.jar() is not jar and len(calls) == 2


@pytest.mark.anyio
async def test_not_configured_loader_reads_nothing(settings):
    assert await CookieLoader(settings).jar() is None


@pytest.mark.anyio
@pytest.mark.parametrize("error, hint_part", [
    (FileNotFoundError("could not find chrome cookies database"), "profile"),
    (PermissionError(13, "denied"), "permissions"),
    (RuntimeError("boom"), "signed in to YouTube in Chrome"),
])
async def test_browser_failures_become_signin_failed(monkeypatch, browser_settings, error, hint_part):
    def fail(spec, logger):
        raise error

    monkeypatch.setattr(cookies_module, "browser_jar", fail)
    with pytest.raises(AppError) as info:
        await CookieLoader(browser_settings).jar()
    assert info.value.code == "signin_failed" and info.value.status == 503 and info.value.retryable
    assert info.value.message == "Couldn't read your YouTube cookies from Chrome."
    assert hint_part in info.value.hint


@pytest.mark.anyio
async def test_keychain_denial_gets_a_keychain_hint(monkeypatch, browser_settings):
    monkeypatch.setattr(cookies_module, "browser_jar",
                        fake_browser(".google.com", warn="cannot decrypt v10 cookies: no key found"))
    with pytest.raises(AppError) as info:
        await CookieLoader(browser_settings).jar()
    assert "Keychain" in info.value.hint and "Always Allow" in info.value.hint


@pytest.mark.anyio
async def test_failures_are_remembered_for_30_seconds(monkeypatch, browser_settings):
    calls: list = []

    def fail(spec, logger):
        calls.append(spec)
        raise FileNotFoundError()

    monkeypatch.setattr(cookies_module, "browser_jar", fail)
    now = [0.0]
    loader = CookieLoader(browser_settings, clock=lambda: now[0])
    for _ in range(3):
        with pytest.raises(AppError):
            await loader.jar()
    assert len(calls) == 1
    now[0] += 31
    with pytest.raises(AppError):
        await loader.jar()
    assert len(calls) == 2


@pytest.mark.anyio
@pytest.mark.parametrize("content, hint_part", [
    (None, "no file at that path"),
    ('[{"domain": ".youtube.com", "name": "SID", "value": "fake"}]', "Netscape"),
    (".google.com\tTRUE\t/\tTRUE\t2000000000\tSID\tfake\n", "no youtube.com cookies"),
])
async def test_cookies_file_failures(settings, tmp_path, content, hint_part):
    path = tmp_path / "exported.txt"
    if content is not None:
        path.write_text(content, "utf-8")
    with pytest.raises(AppError) as info:
        await CookieLoader(with_settings(settings, cookies_file=path)).jar()
    assert info.value.code == "signin_failed"
    assert info.value.message == "Couldn't read your YouTube cookies from the cookies file."
    assert hint_part in info.value.hint


@pytest.mark.anyio
async def test_cookie_names_and_values_are_never_logged(monkeypatch, caplog, browser_settings, file_settings):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(cookies_module, "browser_jar", fake_browser(".youtube.com", ".google.com"))
    await CookieLoader(browser_settings).jar()
    await CookieLoader(file_settings).jar()
    assert caplog.text  # something was logged...
    for secret in (FAKE_VALUE, "fake-login", "LOGIN_INFO", "fake-google"):
        assert secret not in caplog.text  # ...but no cookie names or values


# --- /api/me ------------------------------------------------------------------

def topbar(*thumbnails):
    return {"desktopTopbarRenderer": {"topbarButtons": [
        {"topbarMenuButtonRenderer": {"icon": {"iconType": "VIDEO_CALL"}}},
        {"notificationTopbarButtonRenderer": {"icon": {"iconType": "NOTIFICATIONS"}}},
        {"topbarMenuButtonRenderer": {"avatar": {"thumbnails": list(thumbnails)},
                                      "menuRequest": {"signalServiceEndpoint": {}}}},
    ]}}


def home_page(chip_bar=None, *, avatar=True):
    grid = {"contents": [{"richSectionRenderer": {"content": {"chipCloudRenderer": {"chips": [
        {"chipCloudChipRenderer": {"text": {"simpleText": "Not the feed bar"}}}]}}}}]}
    if chip_bar is not None:
        grid["header"] = chip_bar
    data = {"contents": {"twoColumnBrowseResultsRenderer": {"tabs": [
        {"tabRenderer": {"selected": True, "content": {"richGridRenderer": grid}}}]}}}
    if avatar:
        data["topbar"] = topbar(
            {"url": AVATAR_88, "width": 88, "height": 88},
            {"url": "https://avatars.example.com/me.png", "width": 800, "height": 800},  # not a YouTube host
            {"url": AVATAR_176, "width": 176, "height": 176},
            {"url": "https://yt3.ggpht.com/me-avatar=s32", "width": 32, "height": 32},
        )
    return data


CLASSIC_CHIPS = {"feedFilterChipBarRenderer": {"contents": [
    {"chipCloudChipRenderer": {"text": {"runs": [{"text": "All"}]}, "isSelected": True}},
    {"chipCloudChipRenderer": {"text": {"simpleText": "Music"}}},
    {"chipCloudChipRenderer": {"text": {"runs": [{"text": "Podcasts"}]}}},
    {"chipCloudChipRenderer": {"text": {"simpleText": "Music"}}},
    {"chipCloudChipRenderer": {"text": {"simpleText": "Recently uploaded"}}},
]}}
VIEW_MODEL_CHIPS = {"chipBarViewModel": {"chips": [
    {"chipViewModel": {"text": "All", "selected": True}},
    {"chipViewModel": {"text": "Gaming", "selected": False}},
    {"chipViewModel": {"text": "Live", "selected": False}},
]}}


def home_html(logged_in: bool | None, data) -> str:
    cfg = "" if logged_in is None else f'ytcfg.set({{"INNERTUBE_API_KEY": "k", "LOGGED_IN":{json.dumps(logged_in)}}});'
    return (f"<!DOCTYPE html><html><head><script>{cfg}</script><script>var ytInitialData = "
            f"{json.dumps(data)};</script></head></html>")


def test_parse_home():
    state = parse_home(home_html(True, home_page(CLASSIC_CHIPS)))
    assert state.logged_in is True and state.avatar_url == AVATAR_176
    assert state.chips == ("Music", "Podcasts", "Recently uploaded")
    assert parse_home(home_html(False, home_page(CLASSIC_CHIPS))).logged_in is False
    assert parse_home(home_html(None, home_page())).logged_in is None


def test_parse_chips_view_model_and_fallbacks():
    assert parse_chips(home_page(VIEW_MODEL_CHIPS)) == ["Gaming", "Live"]
    # Without a header bar, another chip bar on the page is used.
    assert parse_chips(home_page(None)) == ["Not the feed bar"]
    assert parse_chips({}) == []


def test_avatar_needs_a_youtube_image_host():
    data = home_page(avatar=False)
    data["topbar"] = topbar({"url": "https://avatars.example.com/me.png", "width": 88})
    assert parse_home(home_html(True, data)).avatar_url is None


class FakeFetch:
    """Stands in for ``youtube_pages.fetch_html``; records whether cookies were sent."""

    def __init__(self, html: str | Exception) -> None:
        self.html = html
        self.calls: list[tuple[str, list[tuple[str, str]] | None]] = []

    async def __call__(self, url: str, *, timeout: float, cookies=None) -> str:
        self.calls.append((url, None if cookies is None else sorted((c.domain, c.name) for c in cookies)))
        if isinstance(self.html, Exception):
            raise self.html
        return self.html


def use_fetch(monkeypatch, html) -> FakeFetch:
    fake = FakeFetch(html)
    monkeypatch.setattr(yp, "fetch_html", fake)
    return fake


def test_me_not_configured_makes_no_network_calls(monkeypatch, settings):
    fetch = use_fetch(monkeypatch, AssertionError("no network"))
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/me").json() == {
            "configured": False, "signed_in": False, "source": None, "avatar_url": None, "chips": [],
            "detail": None, "uploads": False, "uploaded_at": None, "cookie_count": None, "renewed_at": None, "renew_error": None,
        }
        assert client.get("/api/health").json()["signed_in_configured"] is False
    assert fetch.calls == []


def test_me_cookie_failure(monkeypatch, browser_settings):
    def fail(spec, logger):
        raise FileNotFoundError()

    monkeypatch.setattr(cookies_module, "browser_jar", fail)
    fetch = use_fetch(monkeypatch, AssertionError("no fetch without cookies"))
    with local_client(create_app(browser_settings)) as client:
        body = client.get("/api/me").json()
        assert client.get("/api/health").json()["signed_in_configured"] is True
    assert body["configured"] is True and body["signed_in"] is False
    assert body["source"] == "chrome" and body["avatar_url"] is None and body["chips"] == []
    assert body["detail"].startswith("Couldn't read your YouTube cookies from Chrome.")
    assert fetch.calls == []


def test_me_logged_out_page(monkeypatch, file_settings):
    fetch = use_fetch(monkeypatch, home_html(False, home_page()))
    with local_client(create_app(file_settings)) as client:
        body = client.get("/api/me").json()
    assert body == {
        "configured": True, "signed_in": False, "source": "cookies file", "avatar_url": None, "chips": [],
        "detail": "YouTube didn't accept the cookies from the cookies file: they're signed out or expired. "
                  "Export a fresh cookies.txt while signed in to YouTube, then reload.",
        "uploads": False, "uploaded_at": None, "cookie_count": None, "renewed_at": None, "renew_error": None,
    }
    # Only the file's youtube.com cookies were sent.
    assert fetch.calls == [("https://www.youtube.com/", [
        (".youtube.com", "LOGIN_INFO"), (".youtube.com", "SID"), ("www.youtube.com", "PREF")])]


def test_me_logged_in_page_is_cached(monkeypatch, browser_settings):
    monkeypatch.setattr(cookies_module, "browser_jar", fake_browser(".youtube.com", ".google.com"))
    fetch = use_fetch(monkeypatch, home_html(True, home_page(CLASSIC_CHIPS)))
    with local_client(create_app(browser_settings)) as client:
        first = client.get("/api/me").json()
        second = client.get("/api/me").json()
    assert first == {
        "configured": True, "signed_in": True, "source": "chrome", "avatar_url": AVATAR_176,
        "chips": ["Music", "Podcasts", "Recently uploaded"], "detail": None,
        "uploads": False, "uploaded_at": None, "cookie_count": None, "renewed_at": None, "renew_error": None,
    }
    assert second == first
    assert fetch.calls == [("https://www.youtube.com/", [(".youtube.com", "SID")])]


def test_me_network_failure_is_retried_soon(monkeypatch, browser_settings):
    monkeypatch.setattr(cookies_module, "browser_jar", fake_browser(".youtube.com"))
    fetch = use_fetch(monkeypatch, AppError("network_error", "Could not reach YouTube.", status=502, retryable=True))
    now = [0.0]
    app = create_app(browser_settings)
    app.state.account._clock = lambda: now[0]
    with local_client(app) as client:
        assert client.get("/api/me").json()["detail"] == "Could not reach YouTube."
        client.get("/api/me")
        assert len(fetch.calls) == 1
        now[0] += 31
        client.get("/api/me")
        assert len(fetch.calls) == 2


# --- /api/me/feed -------------------------------------------------------------

class FakeFlat:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, int]] = []

    async def __call__(self, provider, target, *, offset, limit, context):
        self.calls.append((target, offset, limit))
        entries = [{"_type": "url", "ie_key": "Youtube", "id": f"vid{offset + i:08d}", "title": f"Video {i}",
                    "availability": "subscriber_only" if i == 0 else None} for i in range(limit + 1)]
        return {"entries": entries, "playlist_count": 57}


@pytest.fixture
def flat(monkeypatch):
    fake = FakeFlat()

    async def flat_method(self, target, *, offset, limit, context):
        return await fake(self, target, offset=offset, limit=limit, context=context)

    monkeypatch.setattr(YtDlpDiscoveryProvider, "_flat", flat_method)
    return fake


def test_feed_needs_sign_in(flat, settings):
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/me/feed/recommended")
    assert response.status_code == 401
    assert response.json()["error"] == {
        "code": "signed_out", "message": "YouTube sign-in isn't set up.",
        "hint": "Set YTC_YTDLP_COOKIES_FROM_BROWSER (see Signing in in the README).", "retryable": False,
    }
    assert flat.calls == []


def test_unknown_feed_is_not_found(flat, settings, browser_settings):
    for app_settings, make_client in ((settings, TestClient), (browser_settings, local_client)):
        with make_client(create_app(app_settings)) as client:
            response = client.get("/api/me/feed/trending")
            assert response.status_code == 404 and response.json()["error"]["code"] == "not_found"
    assert flat.calls == []


@pytest.mark.parametrize("feed_id, target, title", [
    ("recommended", ":ytrec", "Recommended"),
    ("subscriptions", ":ytsubs", "Subscriptions"),
    ("history", ":ythis", "History"),
    ("watch_later", ":ytwatchlater", "Watch later"),
    ("liked", "https://www.youtube.com/playlist?list=LL", "Liked videos"),
])
def test_feed_signed_in(monkeypatch, flat, browser_settings, feed_id, target, title):
    monkeypatch.setattr(cookies_module, "browser_jar", fake_browser(".youtube.com"))
    use_fetch(monkeypatch, home_html(True, home_page()))
    with local_client(create_app(browser_settings)) as client:
        first = client.get(f"/api/me/feed/{feed_id}").json()
        again = client.get(f"/api/me/feed/{feed_id}").json()
        second = client.get(f"/api/me/feed/{feed_id}", params={"offset": 20}).json()
        assert client.get(f"/api/me/feed/{feed_id}", params={"offset": 7}).status_code == 400
    assert first["kind"] == "feed" and first["title"] == title and first["provider"] == "yt-dlp"
    assert len(first["items"]) == 20 and first["next_offset"] == 20 and first["total_count"] == 57
    assert first["items"][0]["available"] is True  # members-only stays playable when signed in
    assert first["cached"] is False and again["cached"] is True
    assert second["offset"] == 20 and second["items"][0]["id"] == "vid00000020"
    assert flat.calls == [(target, 0, 20), (target, 20, 20)]


def test_feed_when_youtube_says_signed_out(monkeypatch, flat, browser_settings):
    monkeypatch.setattr(cookies_module, "browser_jar", fake_browser(".youtube.com"))
    use_fetch(monkeypatch, home_html(False, home_page()))
    with local_client(create_app(browser_settings)) as client:
        response = client.get("/api/me/feed/subscriptions")
    assert response.status_code == 401
    error = response.json()["error"]
    assert error["code"] == "signed_out" and "signed out or expired" in error["message"]
    assert error["hint"] == "Sign in to YouTube in Chrome, then reload."
    assert flat.calls == []


@pytest.mark.parametrize("ytdlp_error", [
    AppError("signed_out", "YouTube needs a signed-in account for this.", status=401),
    AppError("not_found", "YouTube could not find that channel or playlist.", status=404),
])
def test_feed_when_the_session_expired_since_the_check(monkeypatch, browser_settings, ytdlp_error):
    calls = []

    async def expired(self, target, *, offset, limit, context):
        calls.append(target)
        raise ytdlp_error

    monkeypatch.setattr(YtDlpDiscoveryProvider, "_flat", expired)
    monkeypatch.setattr(cookies_module, "browser_jar", fake_browser(".youtube.com"))
    fetch = use_fetch(monkeypatch, home_html(True, home_page()))
    with local_client(create_app(browser_settings)) as client:
        response = client.get("/api/me/feed/watch_later")
        assert response.status_code == 401 and response.json()["error"]["code"] == "signed_out"
        assert response.json()["error"]["hint"] == "Sign in to YouTube in Chrome, then reload."
        client.get("/api/me")
    assert calls == [":ytwatchlater"] and len(fetch.calls) == 2  # the session is checked again


def test_feed_when_cookies_cannot_be_read(monkeypatch, flat, browser_settings):
    def fail(spec, logger):
        raise PermissionError(13, "denied")

    monkeypatch.setattr(cookies_module, "browser_jar", fail)
    use_fetch(monkeypatch, AssertionError("no fetch without cookies"))
    with local_client(create_app(browser_settings)) as client:
        response = client.get("/api/me/feed/history")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "signin_failed" and response.json()["error"]["retryable"] is True
    assert flat.calls == []


# --- Related videos -----------------------------------------------------------

def test_related_uses_the_session_and_falls_back(monkeypatch, browser_settings):
    from .test_youtube_pages import WATCH_PAGE, html

    fetch = use_fetch(monkeypatch, html(WATCH_PAGE))
    monkeypatch.setattr(cookies_module, "browser_jar", fake_browser(".youtube.com", ".google.com"))
    with local_client(create_app(browser_settings)) as client:
        assert client.get("/api/related/aqz-KE-bpKQ").status_code == 200
        assert client.get("/api/feeds/live").status_code == 200
    assert fetch.calls[0] == ("https://www.youtube.com/watch?v=aqz-KE-bpKQ", [(".youtube.com", "SID")])
    assert fetch.calls[1][1] is None  # public feeds never get cookies

    def fail(spec, logger):
        raise FileNotFoundError()

    monkeypatch.setattr(cookies_module, "browser_jar", fail)
    fetch.calls.clear()
    with local_client(create_app(browser_settings)) as client:
        assert client.get("/api/related/aqz-KE-bpKQ").status_code == 200
    assert fetch.calls == [("https://www.youtube.com/watch?v=aqz-KE-bpKQ", None)]


# --- Loopback guard -----------------------------------------------------------

def test_guard_rejects_other_computers_when_signed_in(file_settings):
    with TestClient(create_app(file_settings)) as client:  # client host "testclient"
        response = client.get("/api/health")
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"
        assert response.json()["error"]["message"] == (
            "This server is using a signed-in YouTube session, so it only answers requests from this computer.")
        assert client.get("/api/me").status_code == 403
        assert client.get("/not-api").status_code == 404  # only /api is guarded
    with local_client(create_app(file_settings), host="192.168.1.20") as client:
        assert client.get("/api/health").status_code == 403


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
def test_guard_allows_loopback(file_settings, host):
    with local_client(create_app(file_settings), host=host) as client:
        response = client.get("/api/health")
        assert response.status_code == 200 and response.json()["signed_in_configured"] is True


@pytest.mark.parametrize("host_header, status", [
    ("localhost:5173", 200), ("127.0.0.1:8000", 200), ("[::1]:8000", 200), ("app.localhost", 200),
    ("attacker.example:8000", 403), ("192.168.1.20:8000", 403),
])
def test_guard_checks_the_host_header(file_settings, host_header, status):
    with local_client(create_app(file_settings)) as client:
        assert client.get("/api/health", headers={"host": host_header}).status_code == status


def test_guard_is_off_without_sign_in(settings):
    with TestClient(create_app(settings)) as client:  # client host "testclient"
        assert client.get("/api/health").status_code == 200


def test_macos_privacy_block_gets_its_own_hint(monkeypatch):
    # yt-dlp reports "not found" when macOS hides the profile folder; say what's really wrong.
    monkeypatch.setattr(cookies_module, "macos_privacy_blocked", lambda browser, profile: True)
    hint = cookies_module._browser_hint("chrome", FileNotFoundError("could not find chrome cookies database"),
                                        keychain_failed=False, profile=None)
    assert "macOS is blocking" in hint and "Full Disk Access" in hint and "YTC_YTDLP_COOKIES_FILE" in hint
    monkeypatch.setattr(cookies_module, "macos_privacy_blocked", lambda browser, profile: False)
    hint = cookies_module._browser_hint("chrome", FileNotFoundError("x"), keychain_failed=False, profile=None)
    assert "couldn't find Chrome's cookies" in hint


def test_macos_privacy_blocked_only_checks_known_browsers_on_macos(monkeypatch, tmp_path):
    monkeypatch.setattr(cookies_module.sys, "platform", "linux")
    assert cookies_module.macos_privacy_blocked("chrome", None) is False
    monkeypatch.setattr(cookies_module.sys, "platform", "darwin")
    assert cookies_module.macos_privacy_blocked("safari", None) is False
    monkeypatch.setattr(cookies_module.Path, "home", staticmethod(lambda: tmp_path))
    (tmp_path / "Library" / "Application Support" / "Google" / "Chrome" / "Default").mkdir(parents=True)
    assert cookies_module.macos_privacy_blocked("chrome", "Default") is False


def test_home_videos_fill_in_what_the_flat_listing_lacks():
    from app.discovery.account import enrich, parse_chips, parse_home_videos
    from app.models import ChannelInfo, Page, VideoSummary

    renderer = {
        "videoId": "abcdefghijk",
        "title": {"runs": [{"text": "A video"}]},
        "lengthText": {"simpleText": "3:39"},
        "viewCountText": {"simpleText": "7,812 views"},
        "publishedTimeText": {"simpleText": "58 minutes ago"},
        "ownerText": {"runs": [{"text": "Channel", "navigationEndpoint": {"browseEndpoint": {"browseId": "UC" + "x" * 22}}}]},
        "channelThumbnailSupportedRenderers": {"channelThumbnailWithLinkRenderer": {"thumbnail": {"thumbnails": [
            {"url": "https://yt3.ggpht.com/avatar=s68", "width": 68, "height": 68}]}}},
    }
    data = {"contents": {"richGridRenderer": {
        "header": {"feedFilterChipBarRenderer": {"contents": [
            {"chipCloudChipRenderer": {"text": {"runs": [{"text": "All"}]}}},
            {"chipCloudChipRenderer": {"text": {"runs": [{"text": "Custom feed"}]}}},
            {"chipCloudChipRenderer": {"text": {"runs": [{"text": "Podcasts"}]}}},
        ]}},
        "contents": [{"richItemRenderer": {"content": {"videoRenderer": renderer}}}],
    }}}
    assert parse_chips(data) == ["Podcasts"]
    videos = parse_home_videos(data)
    assert [v.id for v in videos] == ["abcdefghijk"]

    flat = VideoSummary(id="abcdefghijk", title="A video", channel=ChannelInfo(ref="UC" + "x" * 22, name="Channel"))
    other = VideoSummary(id="zzzzzzzzzzz", title="Other")
    page = Page(kind="feed", items=[flat, other], provider="yt-dlp")
    enriched = enrich(page, tuple(videos)).items
    assert enriched[0].view_count == videos[0].view_count and enriched[0].view_count is not None
    assert enriched[0].published_text == "58 minutes ago"
    assert enriched[0].channel.avatar_url == videos[0].channel.avatar_url
    assert enriched[1] == other

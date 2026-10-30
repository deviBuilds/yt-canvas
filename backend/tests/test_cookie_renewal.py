"""Renewing someone's YouTube cookies: a youtube.com visit in the background, with jitter, or now."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import urllib.error
from http.cookiejar import CookieJar

import pytest

from app.accounts import youtube as user_youtube_module
from app.accounts.renew import PAGE_URL, Renewal, RenewFailed, SessionEnded, newest, refresh
from app.cookies import netscape_text

from .test_accounts import auth, client, code, convex, account_settings, no_youtube, token  # noqa: F401

NOW = 1_800_000_000.0
HOURS = 3600
OLD_CC = f".youtube.com\tTRUE\t/\tTRUE\t{int(NOW) + 3600}\t__Secure-1PSIDCC\told-cc-secret"
COOKIES = netscape_text([
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tsid-value-secret",
    OLD_CC,
    ".youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tysc-value-secret",
])
SIGNED_IN = '<script>ytcfg.set({"LOGGED_IN":true,"INNERTUBE_API_KEY":"x"})</script>'
SIGNED_OUT = '<script>ytcfg.set({"LOGGED_IN":false})</script>'


def refreshed_cc(value: str = "new-cc-secret", expires: int = int(NOW) + 365 * 86400) -> str:
    return f".youtube.com\tTRUE\t/\tTRUE\t{expires}\t__Secure-1PSIDCC\t{value}"


def fake_youtube(value: str = "new-cc-secret"):
    """A refresher that sends a new __Secure-1PSIDCC, as youtube.com does, and counts its calls."""
    calls = []

    def refresher(lines: list[str]) -> Renewal:
        calls.append(lines)
        return Renewal(lines=[refreshed_cc(value) if "__Secure-1PSIDCC" in line else line for line in lines],
                       refreshed=["__Secure-1PSIDCC"])

    refresher.calls = calls
    return refresher


@pytest.fixture
def clock():
    return {"t": NOW}


@pytest.fixture
def renewer(client, clock):
    youtube = client.app.state.user_youtube
    youtube._now = lambda: clock["t"]
    youtube._jitter = lambda low, high: 0.0
    youtube._refresh = fake_youtube()
    return youtube


def me(client, headers) -> dict:
    return client.get("/api/me", headers=headers).json()


def stored_meta(convex) -> dict:
    (secret,) = [s for (uid, kind), s in convex.secrets.items() if kind == "youtube_cookies"]
    return secret["meta"]


def cookie_file(client) -> str:
    accounts = client.app.state.accounts
    user = client.portal.call(accounts.from_session, token("user_admin"), "testserver")
    session = client.portal.call(client.app.state.user_youtube.session, user)
    return session.settings.cookies_file.read_text()


def upload(client, headers=None) -> None:
    assert client.put("/api/me/cookies", content=COOKIES.encode(), headers=headers or auth("user_admin")).status_code == 200


# -- the visit to youtube.com -----------------------------------------------------------------


def youtube_page(html: str = SIGNED_IN, url: str = PAGE_URL, seen: dict | None = None):
    def get(request, jar: CookieJar):
        jar.add_cookie_header(request)
        if seen is not None:
            seen.update(url=request.full_url, method=request.get_method(),
                        cookies=sorted(c.split("=")[0] for c in request.get_header("Cookie").split("; ")))
        for cookie in jar:
            if cookie.name == "__Secure-1PSIDCC":
                cookie.value, cookie.expires = "new-cc-secret", int(NOW) + 365 * 86400
        return url, html

    return get


def test_refresh_loads_youtube_signed_in_and_keeps_what_it_sets():
    seen = {}
    renewal = refresh(COOKIES.splitlines()[1:], youtube_page(seen=seen))
    assert seen == {"url": PAGE_URL, "method": "GET", "cookies": ["SID", "YSC", "__Secure-1PSIDCC"]}
    assert renewal.refreshed == ["__Secure-1PSIDCC"]
    assert refreshed_cc() in renewal.lines and not any("old-cc-secret" in line for line in renewal.lines)
    assert any(line.endswith("\tYSC\tysc-value-secret") for line in renewal.lines)  # session cookies stay


def test_a_signed_out_page_means_the_session_ended():
    with pytest.raises(SessionEnded):
        refresh(COOKIES.splitlines()[1:], youtube_page(SIGNED_OUT))


@pytest.mark.parametrize("html, url, message", [
    ("<html>no flag</html>", PAGE_URL, "didn't say"),
    (SIGNED_IN, "https://consent.youtube.com/m?continue=x", "consent.youtube.com"),
])
def test_unexpected_pages_are_failures_not_sign_outs(html, url, message):
    with pytest.raises(RenewFailed, match=message):
        refresh(COOKIES.splitlines()[1:], youtube_page(html, url))


@pytest.mark.parametrize("error", [urllib.error.HTTPError(PAGE_URL, 503, "no", {}, io.BytesIO()),
                                   urllib.error.URLError("down")])
def test_youtube_unreachable_is_a_failure(error):
    def get(request, jar):
        raise error

    with pytest.raises(RenewFailed):
        refresh(COOKIES.splitlines()[1:], get)


def test_newest_keeps_a_renewal_that_ytdlp_wrote_back_over():
    stored = [refreshed_cc(), ".youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tysc-1", ".youtube.com\tTRUE\t/\tTRUE\t5\tGONE\tx"]
    written = [OLD_CC, ".youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tysc-2", ".youtube.com\tTRUE\t/\tTRUE\t9\tNEW\ty"]
    assert newest(stored, written) == [refreshed_cc(), ".youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tysc-2",
                                       ".youtube.com\tTRUE\t/\tTRUE\t9\tNEW\ty"]


# -- Renew now --------------------------------------------------------------------------------


def test_renew_needs_cookies(client, renewer):
    assert client.post("/api/me/cookies/renew", headers=auth("user_admin")).status_code == 409


def test_renew_now_stores_the_refreshed_cookies(client, renewer, convex, clock):
    a = auth("user_admin")
    upload(client)
    status = me(client, a)
    assert (status["renewed_at"], status["renew_error"]) == (None, None)
    assert stored_meta(convex)["next_renew_at"] == NOW + 3 * HOURS  # renewed in the background from the start

    assert client.post("/api/me/cookies/renew", headers=a).json() == {
        "ok": True, "renewed_at": NOW, "refreshed": ["__Secure-1PSIDCC"]}
    assert "new-cc-secret" in cookie_file(client) and "old-cc-secret" not in cookie_file(client)
    assert "new-cc-secret" not in json.dumps(list(convex.secrets.values()))  # still ciphertext only
    assert (stored_meta(convex)["renewed_at"], stored_meta(convex)["next_renew_at"]) == (NOW, NOW + 3 * HOURS)
    assert me(client, a)["renewed_at"] == NOW

    # At most once a minute.
    again = client.post("/api/me/cookies/renew", headers=a)
    assert (again.status_code, code(again)) == (429, "rate_limited")
    clock["t"] += 61
    assert client.post("/api/me/cookies/renew", headers=a).status_code == 200


def test_signed_out_cookies_stop_renewal_until_new_ones_come(client, renewer, convex, clock):
    a = auth("user_admin")
    upload(client)

    def ended(lines):
        raise SessionEnded()

    renewer._refresh = ended
    response = client.post("/api/me/cookies/renew", headers=a)
    assert (response.status_code, code(response)) == (409, "signin_failed")
    assert "private window" in response.json()["error"]["hint"]
    assert me(client, a)["renew_error"] == "session_ended"
    assert "old-cc-secret" in cookie_file(client)  # the cookies themselves are left as they were
    clock["t"] += 4 * HOURS
    assert client.portal.call(renewer.renew_due) == 0

    renewer._refresh = fake_youtube()
    upload(client)
    assert me(client, a)["renew_error"] is None
    clock["t"] += 4 * HOURS
    assert client.portal.call(renewer.renew_due) == 1


def test_youtube_unreachable_changes_nothing(client, renewer, convex):
    upload(client)

    def down(lines):
        raise RenewFailed("YouTube answered 503")

    renewer._refresh = down
    response = client.post("/api/me/cookies/renew", headers=auth("user_admin"))
    assert (response.status_code, response.json()["error"]["retryable"]) == (502, True)
    assert "renewed_at" not in stored_meta(convex) and "renew_error" not in stored_meta(convex)


# -- in the background ------------------------------------------------------------------------


def test_background_renewal_follows_each_persons_jittered_schedule(client, renewer, convex, clock):
    jitters = iter([1200.0, -900.0])
    renewer._jitter = lambda low, high: next(jitters)
    upload(client)
    run = lambda: client.portal.call(renewer.renew_due)  # noqa: E731
    assert stored_meta(convex)["next_renew_at"] == NOW + 3 * HOURS + 1200

    clock["t"] = NOW + 3 * HOURS + 1199
    assert run() == 0
    clock["t"] += 1
    renewer._refresh = fake_youtube("newer-cc-secret")
    assert run() == 1
    assert "newer-cc-secret" in cookie_file(client)
    assert stored_meta(convex)["next_renew_at"] == clock["t"] + 3 * HOURS - 900
    assert run() == 0


def test_jitter_stays_within_half_an_hour(client, convex):
    youtube = client.app.state.user_youtube
    seen = set()
    for _ in range(200):
        seen.add(round(youtube._next_renewal() - youtube._now()))
    assert min(seen) >= 3 * HOURS - 1800 and max(seen) <= 3 * HOURS + 1800 and len(seen) > 50


def test_people_are_renewed_one_after_another_with_a_pause(client, renewer, convex, clock, monkeypatch):
    upload(client)
    client.post("/api/admin/allowlist", json={"emails": ["bea@example.com"]}, headers=auth("user_admin"))
    upload(client, auth("user_bea"))
    pauses = []
    real_sleep = asyncio.sleep

    async def sleep(seconds):
        pauses.append(seconds)
        await real_sleep(0)

    renewer._jitter = lambda low, high: high if (low, high) == user_youtube_module.RENEW_SPACING else 0.0
    clock["t"] += 4 * HOURS
    monkeypatch.setattr(asyncio, "sleep", sleep)
    assert client.portal.call(renewer.renew_due) == 2
    monkeypatch.undo()
    assert pauses == [5.0]


def test_a_failed_background_renewal_waits_before_trying_again(client, renewer, convex, clock):
    upload(client)
    calls = []

    def down(lines):
        calls.append(1)
        raise RenewFailed("YouTube answered 503")

    renewer._refresh = down
    clock["t"] = NOW + 3 * HOURS
    assert client.portal.call(renewer.renew_due) == 0
    clock["t"] += 10 * 60
    client.portal.call(renewer.renew_due)
    assert len(calls) == 1  # backed off
    clock["t"] += 10 * 60
    client.portal.call(renewer.renew_due)
    assert len(calls) == 2


def test_a_ytdlp_run_writing_old_cookies_back_doesnt_undo_a_renewal(client, renewer, convex, monkeypatch):
    a = auth("user_admin")
    upload(client)
    client.post("/api/me/cookies/renew", headers=a)
    youtube = client.app.state.user_youtube
    (entry,) = youtube._entries.values()
    # A yt-dlp run that started before the renewal saves its jar when it exits.
    entry.settings.cookies_file.write_text(COOKIES)
    monkeypatch.setattr(user_youtube_module, "SYNC_EVERY", 0)
    entry.mtime = 0
    me(client, a)  # a request notices the change and syncs it

    async def settle():
        await asyncio.gather(*youtube._tasks)

    client.portal.call(settle)
    assert "new-cc-secret" in cookie_file(client) and "old-cc-secret" not in cookie_file(client)


def test_renewal_never_logs_cookie_values(client, renewer, caplog):
    caplog.set_level(logging.DEBUG)
    upload(client)
    client.post("/api/me/cookies/renew", headers=auth("user_admin"))
    assert "renewed a person's YouTube cookies (YouTube refreshed __Secure-1PSIDCC)" in caplog.text
    for value in ("sid-value-secret", "old-cc-secret", "new-cc-secret", "ysc-value-secret"):
        assert value not in caplog.text

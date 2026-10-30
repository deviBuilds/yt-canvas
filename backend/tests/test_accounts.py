"""Accounts: Clerk session tokens, the allowlist, and each person's own data (no network).

Tokens are signed here with a test RSA key whose JWKS the verifier is given; Convex is the
in-memory FakeConvex; Clerk's Backend API is a dict of profiles.
"""

from __future__ import annotations

import base64
import json
import os
import stat
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.accounts.clerk import ClerkVerifier, InvalidSession, Profile, frontend_api
from app.accounts.crypto import Sealer, new_key
from app.main import create_app
from app.session import reset_session, session_tag, use_session
from app.ytdlp import base_args

from app.apps.plex import client as plex_client

from .conftest import with_settings
from .fakeconvex import FakeConvex
from .test_plex import FakePlex, connect

FAPI = "clerk.test.example"
PUBLISHABLE = "pk_test_" + base64.b64encode(f"{FAPI}$".encode()).decode().rstrip("=")
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ADMIN = "admin@example.com"

COOKIES = (
    "# Netscape HTTP Cookie File\n"
    ".youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tsid-value-secret\n"
    ".youtube.com\tTRUE\t/\tTRUE\t1999999999\tLOGIN_INFO\tlogin-value-secret\n"
    ".google.com\tTRUE\t/\tTRUE\t1999999999\tNID\tgoogle-only-secret\n"
)


def jwks() -> dict:
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key()))
    return {"keys": [{**public, "kid": "test-key", "use": "sig", "alg": "RS256"}]}


def token(sub: str, *, key=KEY, kid: str = "test-key", iss: str = f"https://{FAPI}", azp: str | None = "http://testserver",
          exp: float | None = None) -> str:
    now = time.time()
    claims = {"sub": sub, "iss": iss, "iat": int(now) - 5, "nbf": int(now) - 5, "exp": int(exp or now + 60), "sid": "sess"}
    if azp:
        claims["azp"] = azp
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


class FakeClerk:
    def __init__(self) -> None:
        self.profiles = {
            "user_admin": Profile(ADMIN, "Admin", None),
            "user_bea": Profile("bea@example.com", "Bea", None),
            "user_cal": Profile("cal@example.com", "Cal", None),
        }

    async def profile(self, clerk_id: str) -> Profile | None:
        return self.profiles.get(clerk_id)


@pytest.fixture(autouse=True)
def no_youtube(monkeypatch):
    """Signed-in /api/me would fetch YouTube's home page; these tests never leave the machine."""
    from app.discovery import youtube_pages
    from app.errors import AppError

    async def offline(url, **kwargs):
        raise AppError("youtube_blocked", "offline in tests", status=503)

    monkeypatch.setattr(youtube_pages, "fetch_html", offline)


@pytest.fixture
def convex() -> FakeConvex:
    return FakeConvex()


@pytest.fixture
def account_settings(settings):
    return with_settings(settings, clerk_publishable_key=PUBLISHABLE, clerk_secret_key="sk_test_x",
                         convex_site_url="https://fake.convex.site", convex_secret="shared", secrets_key=new_key(),
                         admin_emails=(ADMIN,))


def make_app(account_settings, convex):
    return create_app(account_settings, account_store=convex, clerk_api=FakeClerk(),
                      clerk_verifier=ClerkVerifier(PUBLISHABLE, fetch=lambda url: jwks()))


@pytest.fixture
def client(account_settings, convex):
    with TestClient(make_app(account_settings, convex)) as c:
        yield c


def auth(sub: str, **kw) -> dict:
    return {"Authorization": f"Bearer {token(sub, **kw)}"}


def code(response) -> str:
    return response.json()["error"]["code"]


# -- configuration ------------------------------------------------------------------------------


def test_the_publishable_key_names_the_clerk_instance():
    assert frontend_api(PUBLISHABLE) == FAPI
    with pytest.raises(ValueError):
        frontend_api("sk_test_nope")


def test_accounts_need_every_key(settings):
    with pytest.raises(ValueError, match="YTC_SECRETS_KEY"):
        with_settings(settings, clerk_publishable_key=PUBLISHABLE, clerk_secret_key="sk", convex_site_url="https://x",
                      convex_secret="s")


def test_no_login_mode_has_no_accounts(settings):
    with TestClient(create_app(settings)) as c:
        assert c.get("/api/auth/config").json() == {"accounts": False}
        assert c.get("/api/library").status_code == 404
        assert c.get("/api/search?q=x").status_code != 401


def test_config_is_public_and_names_the_key(client):
    assert client.get("/api/auth/config").json() == {"accounts": True, "clerk_publishable_key": PUBLISHABLE,
                                                     "clerk_frontend_api": FAPI}


# -- signing in ---------------------------------------------------------------------------------


def test_everything_else_needs_signing_in(client):
    for path in ("/api/search?q=cats", "/api/apps", "/api/health", "/api/library", "/api/auth/me", "/api/me"):
        response = client.get(path)
        assert response.status_code == 401, path
        assert code(response) == "auth_required"


def test_an_admin_signs_in_and_is_on_the_allowlist(client, convex):
    assert ADMIN in convex.allowlist  # added at startup
    me = client.get("/api/auth/me", headers=auth("user_admin")).json()
    assert me == {"email": ADMIN, "name": "Admin", "image_url": None, "admin": True, "via": "clerk", "device": None}


def test_the_session_cookie_works_too(client):
    client.cookies.set("__session", token("user_admin"))
    assert client.get("/api/auth/me").json()["email"] == ADMIN


def test_people_not_on_the_allowlist_are_refused(client):
    response = client.get("/api/auth/me", headers=auth("user_bea"))
    assert response.status_code == 403
    assert code(response) == "not_invited"
    assert "bea@example.com" in response.json()["error"]["message"]


@pytest.mark.parametrize("bad", [
    {"exp": time.time() - 60},
    {"iss": "https://someone-else.clerk.accounts.dev"},
    {"azp": "https://evil.example"},
    {"key": OTHER_KEY},
    {"kid": "unknown"},
])
def test_bad_tokens_are_refused(client, bad):
    response = client.get("/api/auth/me", headers=auth("user_admin", **bad))
    assert response.status_code == 401


def test_allowed_origins_replace_the_same_host_rule(account_settings, convex):
    settings = with_settings(account_settings, allowed_origins=("https://ytc.example",))
    with TestClient(make_app(settings, convex)) as c:
        assert c.get("/api/auth/me", headers=auth("user_admin", azp="https://ytc.example")).status_code == 200
        assert c.get("/api/auth/me", headers=auth("user_admin")).status_code == 401


def test_cookie_signed_writes_need_our_own_origin(client):
    client.cookies.set("__session", token("user_admin"))
    entry = {"entries": [{"key": "youtube:abc", "data": {"x": 1}, "updatedAt": 1}]}
    assert client.put("/api/library/favorites", json=entry, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.put("/api/library/favorites", json=entry, headers={"Origin": "http://testserver"}).status_code == 200


def test_the_account_database_being_down_is_a_503(client, convex):
    convex.down = True
    response = client.get("/api/auth/me", headers=auth("user_admin"))
    assert response.status_code == 503
    assert code(response) == "accounts_unavailable"


# -- the allowlist --------------------------------------------------------------------------------


def test_admins_manage_the_allowlist(client):
    admin = auth("user_admin")
    assert client.post("/api/admin/allowlist", json={"emails": ["Bea@Example.com"]}, headers=admin).json() == {"added": 1}
    assert client.get("/api/auth/me", headers=auth("user_bea")).json()["email"] == "bea@example.com"
    entries = client.get("/api/admin/allowlist", headers=admin).json()["entries"]
    assert [(e["email"], e["admin"]) for e in entries] == [(ADMIN, True), ("bea@example.com", False)]
    # Not an admin: can't change it.
    assert client.post("/api/admin/allowlist", json={"emails": ["cal@example.com"]}, headers=auth("user_bea")).status_code == 403
    assert client.delete(f"/api/admin/allowlist/{ADMIN}", headers=admin).status_code == 400
    assert client.post("/api/admin/allowlist", json={"emails": ["not an email"]}, headers=admin).status_code == 400
    assert client.delete("/api/admin/allowlist/bea@example.com", headers=admin).json() == {"ok": True}
    assert client.get("/api/auth/me", headers=auth("user_bea")).status_code == 403


# -- each person's own things -------------------------------------------------------------------


@pytest.fixture
def two(client):
    client.post("/api/admin/allowlist", json={"emails": ["bea@example.com"]}, headers=auth("user_admin"))
    return auth("user_admin"), auth("user_bea")


def test_library_is_per_person(client, two):
    a, b = two
    favorite = {"video": {"source": "youtube", "id": "abc", "title": "A"}, "addedAt": 5}
    history = [{"key": f"youtube:v{i}", "data": {"video": {"id": f"v{i}"}, "position": i, "updatedAt": i}, "updatedAt": i}
               for i in range(105)]
    assert client.put("/api/library/favorites", json={"entries": [{"key": "youtube:abc", "data": favorite, "updatedAt": 5}]},
                      headers=a).status_code == 200
    for start in (0, 100):
        client.put("/api/library/history", json={"entries": history[start:start + 100]}, headers=a)
    mine = client.get("/api/library", headers=a).json()
    assert mine["favorites"] == [favorite]
    assert len(mine["history"]) == 100 and mine["history"][0]["position"] == 104  # newest first, trimmed
    assert client.get("/api/library", headers=b).json() == {"favorites": [], "history": [], "searches": []}
    client.delete("/api/library/favorites/youtube:abc", headers=a)
    client.delete("/api/library/history", headers=a)
    assert client.get("/api/library", headers=a).json() == {"favorites": [], "history": [], "searches": []}


def test_apps_are_per_person(client, two):
    a, b = two
    assert client.put("/api/apps/plex", json={"enabled": True}, headers=a).json()["enabled"] is True
    assert {app["id"]: app["enabled"] for app in client.get("/api/apps", headers=a).json()["apps"]} == {"plex": True}
    assert {app["id"]: app["enabled"] for app in client.get("/api/apps", headers=b).json()["apps"]} == {"plex": False}
    assert client.get("/api/apps/plex/status", headers=b).status_code == 404


def test_youtube_cookies_are_per_person_and_encrypted(client, two, convex, account_settings):
    a, b = two
    assert client.put("/api/me/cookies", content=b'[{"name": "SID"}]', headers=a).status_code == 400
    assert client.put("/api/me/cookies", content=b"# Netscape HTTP Cookie File\n", headers=a).status_code == 400
    uploaded = client.put("/api/me/cookies", content=COOKIES.encode(), headers=a).json()
    assert uploaded["count"] == 2  # the google.com line was dropped
    # Convex holds ciphertext only.
    stored = json.dumps(list(convex.secrets.values()))
    assert "sid-value-secret" not in stored and "login-value-secret" not in stored and "google-only" not in stored
    me = client.get("/api/me", headers=a).json()
    assert me["uploads"] is True and me["cookie_count"] == 2 and me["configured"] is True
    assert client.get("/api/me", headers=b).json() | {"uploaded_at": None} == {
        "configured": False, "signed_in": False, "source": None, "avatar_url": None, "chips": [], "detail": None,
        "uploads": True, "uploaded_at": None, "cookie_count": None}

    # yt-dlp gets A's cookies only inside A's requests.
    accounts = client.app.state.accounts
    user_a = client.portal.call(accounts.from_session, token("user_admin"), "testserver")
    session = client.portal.call(client.app.state.user_youtube.session, user_a)
    path = session.settings.cookies_file
    assert path is not None and path.is_file()
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert "google-only-secret" not in path.read_text()
    token_ = use_session(session)
    try:
        args = base_args(account_settings)
        assert args[args.index("--cookies") + 1] == str(path)
        assert session_tag() is not None
    finally:
        reset_session(token_)
    assert "--cookies" not in base_args(account_settings)
    assert session_tag() is None

    assert client.delete("/api/me/cookies", headers=a).json() == {"ok": True}
    assert not path.exists()
    assert client.get("/api/me", headers=a).json()["configured"] is False


def test_plex_is_per_person_and_follows_the_account(account_settings, convex, monkeypatch):
    fake = FakePlex()
    monkeypatch.setattr(plex_client, "urlopen", fake)
    with TestClient(make_app(account_settings, convex)) as c:
        c.post("/api/admin/allowlist", json={"emails": ["bea@example.com"]}, headers=auth("user_admin"))
        c.headers.update(auth("user_admin"))
        connect(c, fake)
        assert c.get("/api/apps/plex/status").json()["connected"] is True
        bea = auth("user_bea")
        c.put("/api/apps/plex", json={"enabled": True}, headers=bea)
        assert c.get("/api/apps/plex/status", headers=bea).json()["connected"] is False
    # The token is encrypted in the account, and a new server (a restart, another machine) finds it.
    assert "user-token-secret" not in json.dumps(list(convex.secrets.values()))
    assert "server-token-secret" not in json.dumps(list(convex.secrets.values()))
    with TestClient(make_app(account_settings, convex)) as c:
        status = c.get("/api/apps/plex/status", headers=auth("user_admin")).json()
        assert status["connected"] is True and status["server"] == "Home"
        assert c.get("/api/apps", headers=auth("user_admin")).json()["apps"][0]["connected"] is True


def test_secrets_are_bound_to_their_owner_and_key():
    key = new_key()
    sealer = Sealer(key)
    sealed = sealer.seal(b"plex-token", "user_1:plex")
    assert sealer.open(sealed, "user_1:plex") == b"plex-token"
    assert sealer.open(sealed, "user_2:plex") is None  # copied to someone else
    assert Sealer(new_key()).open(sealed, "user_1:plex") is None  # another key
    assert sealer.open(sealed[:-4] + "AAAA", "user_1:plex") is None  # tampered


# -- pairing a device to an account ---------------------------------------------------------------


def test_a_car_pairs_to_whoever_approves_it(client, two, convex):
    a, b = two
    car = TestClient(client.app, base_url="https://testserver")
    started = car.post("/api/pairing/requests", json={"name": "Model Y"}).json()
    assert car.get(f"/api/pairing/requests/{started['id']}").json() == {"state": "waiting"}
    assert car.get("/api/auth/me").status_code == 401
    assert client.post("/api/pairing/approve", json={"code": started["code"]}, headers=b).status_code == 200
    assert car.get(f"/api/pairing/requests/{started['id']}").json() == {"state": "paired"}
    me = car.get("/api/auth/me").json()
    assert me["email"] == "bea@example.com" and me["via"] == "device" and me["device"] == "Model Y"
    # Only the cookie's hash is stored.
    assert all(len(d["tokenHash"]) == 64 for d in convex.devices.values())
    # A's devices and B's devices are their own.
    assert client.get("/api/pairing/devices", headers=a).json()["devices"] == []
    devices = client.get("/api/pairing/devices", headers=b).json()["devices"]
    assert [d["name"] for d in devices] == ["Model Y"]
    # A paired device can't pair others.
    other = car.post("/api/pairing/requests", json={}).json()
    assert car.post("/api/pairing/approve", json={"code": other["code"]}).status_code == 403
    # Someone else can't revoke it; its owner can, from anywhere.
    assert client.delete(f"/api/pairing/devices/{devices[0]['id']}", headers=a).status_code == 404
    assert client.delete(f"/api/pairing/devices/{devices[0]['id']}", headers=b).json() == {"ok": True}
    assert car.get("/api/auth/me").status_code == 401


def test_a_paired_device_loses_access_with_its_owner(client, two):
    _, b = two
    car = TestClient(client.app, base_url="https://testserver")
    started = car.post("/api/pairing/requests", json={"name": "TV"}).json()
    client.post("/api/pairing/approve", json={"code": started["code"]}, headers=b)
    car.get(f"/api/pairing/requests/{started['id']}")
    assert car.get("/api/auth/me").status_code == 200
    client.delete("/api/admin/allowlist/bea@example.com", headers=auth("user_admin"))
    response = car.get("/api/auth/me")
    assert response.status_code == 403 and code(response) == "not_invited"


def test_a_paired_device_can_sign_itself_out(client, two):
    _, b = two
    car = TestClient(client.app, base_url="https://testserver")
    started = car.post("/api/pairing/requests", json={"name": "TV"}).json()
    client.post("/api/pairing/approve", json={"code": started["code"]}, headers=b)
    car.get(f"/api/pairing/requests/{started['id']}")
    assert car.post("/api/pairing/forget", headers={"Origin": "https://testserver"}).json() == {"ok": True}
    assert client.get("/api/pairing/devices", headers=b).json()["devices"] == []


# -- the verifier on its own ------------------------------------------------------------------------


@pytest.mark.anyio
async def test_signing_keys_are_fetched_once_and_refetched_for_new_keys():
    fetches = []
    now = [1000.0]

    def fetch(url):
        fetches.append(url)
        return jwks()

    verifier = ClerkVerifier(PUBLISHABLE, fetch=fetch, clock=lambda: now[0])
    for _ in range(3):
        await verifier.verify(token("u"), host="testserver")
    assert fetches == [f"https://{FAPI}/.well-known/jwks.json"]
    with pytest.raises(InvalidSession):
        await verifier.verify(token("u", kid="rotated"), host="testserver")
    with pytest.raises(InvalidSession):  # no refetch storm for unknown keys
        await verifier.verify(token("u", kid="rotated"), host="testserver")
    assert len(fetches) == 1
    now[0] += 31
    with pytest.raises(InvalidSession):
        await verifier.verify(token("u", kid="rotated"), host="testserver")
    assert len(fetches) == 2


def test_settings_from_the_environment(monkeypatch, tmp_path):
    from app.config import load_settings

    for name, value in {"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": PUBLISHABLE, "CLERK_SECRET_KEY": "sk_test_x",
                        "CONVEX_ENDPOINT": "https://x.convex.site/", "YTC_CONVEX_SECRET": "s", "YTC_SECRETS_KEY": new_key(),
                        "YTC_ADMIN_EMAILS": "A@Example.com, b@example.com", "YTC_YTDLP_COOKIES_FILE": str(tmp_path / "c.txt"),
                        "YTC_DATA_DIR": str(tmp_path)}.items():
        monkeypatch.setenv(name, value)
    settings = load_settings()
    assert settings.accounts_enabled and settings.convex_site_url == "https://x.convex.site"
    assert settings.admin_emails == ("a@example.com", "b@example.com")
    # Everyone brings their own cookies: the server-wide file is left alone.
    assert settings.cookies_file is None and settings.ignored_server_cookies
    monkeypatch.setenv("YTC_ACCOUNTS", "off")
    settings = load_settings()
    assert not settings.accounts_enabled and settings.cookies_file == tmp_path / "c.txt"


def test_cookie_values_never_reach_the_logs(client, caplog):
    caplog.set_level("DEBUG")
    client.put("/api/me/cookies", content=COOKIES.encode(), headers=auth("user_admin"))
    client.get("/api/me", headers=auth("user_admin"))
    assert "secret" not in caplog.text.replace("YTC_SECRETS_KEY", "")


@pytest.mark.anyio
async def test_calls_to_clerk_and_convex_name_themselves(monkeypatch):
    """Cloudflare, in front of Clerk's APIs, answers 403 to Python's default User-Agent."""
    import io
    import urllib.request

    from app.accounts import clerk as clerk_module
    from app.accounts.clerk import ClerkApi
    from app.accounts.convex import ConvexClient

    seen = []

    class Answer(io.BytesIO):
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return None

    def urlopen(request, timeout):
        seen.append((request.full_url, request.get_header("User-agent")))
        body = {"result": []} if "convex" in request.full_url else {
            "id": "user_1", "primary_email_address_id": "e1", "email_addresses": [{"id": "e1", "email_address": "A@x.com"}]}
        return Answer(json.dumps(body).encode())

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert (await ClerkApi("sk_test_x").profile("user_1")).email == "a@x.com"
    assert await ConvexClient("https://fake.convex.site", "s").call("allowlist.list") == []
    assert [agent for _, agent in seen] == [clerk_module.USER_AGENT] * 2
    assert "Python-urllib" not in clerk_module.USER_AGENT

"""Add-on apps: listing, turning on and off, per-app routes, persistence and the loopback guard."""

import json

from fastapi import APIRouter
from fastapi.testclient import TestClient

from app.apps import AppSpec
from app.main import create_app
from tests.conftest import with_settings


def fake_app(connected: bool = False, calls: list | None = None) -> AppSpec:
    router = APIRouter()

    @router.get("/hello")
    async def hello() -> dict:
        return {"hello": "world"}

    return AppSpec(id="fake", name="Fake", description="A test app.", router=router, holds_private_data=True,
                   connected=lambda: connected, on_disable=(lambda: calls.append("off")) if calls is not None else None)


def client(settings, apps=None, host: str = "127.0.0.1") -> TestClient:
    return TestClient(create_app(settings, apps=apps), client=(host, 50000), base_url="http://localhost:8000")


def test_plex_is_listed_and_starts_off(settings):
    with client(settings) as c:
        listing = c.get("/api/apps").json()
        assert listing["available"] is True
        plex = next(app for app in listing["apps"] if app["id"] == "plex")
        assert plex == {"id": "plex", "name": "Plex", "description": plex["description"], "enabled": False,
                        "connected": False, "holds_private_data": True}
        response = c.get("/api/apps/plex/status")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "app_disabled"


def test_turning_an_app_on_opens_its_routes_and_off_closes_them(settings):
    calls: list = []
    with client(settings, [fake_app(calls=calls)]) as c:
        assert c.get("/api/apps/fake/hello").status_code == 404
        turned_on = c.put("/api/apps/fake", json={"enabled": True})
        assert turned_on.status_code == 200 and turned_on.json()["enabled"] is True
        assert c.get("/api/apps/fake/hello").json() == {"hello": "world"}
        assert c.put("/api/apps/fake", json={"enabled": False}).json()["enabled"] is False
        assert c.get("/api/apps/fake/hello").status_code == 404
    assert calls == ["off"]


def test_choices_survive_a_restart(settings):
    with client(settings, [fake_app()]) as c:
        c.put("/api/apps/fake", json={"enabled": True})
    saved = settings.app_config_dir / "apps.json"
    assert json.loads(saved.read_text()) == {"enabled": ["fake"]}
    assert oct(settings.app_config_dir.stat().st_mode & 0o777) == "0o700"
    with client(settings, [fake_app()]) as c:
        assert c.get("/api/apps/fake/hello").status_code == 200


def test_an_unreadable_choices_file_leaves_every_app_off(settings):
    settings.app_config_dir.mkdir(parents=True)
    (settings.app_config_dir / "apps.json").write_text("{not json")
    with client(settings, [fake_app()]) as c:
        assert c.get("/api/apps").json()["apps"][0]["enabled"] is False


def test_unknown_apps_and_bad_bodies(settings):
    with client(settings) as c:
        assert c.put("/api/apps/nope", json={"enabled": True}).json()["error"]["code"] == "not_found"
        assert c.put("/api/apps/plex", json={}).status_code == 400


def test_apps_can_be_switched_off_for_the_whole_server(settings):
    off = with_settings(settings, enable_apps=False)
    off.app_config_dir.mkdir(parents=True)
    (off.app_config_dir / "apps.json").write_text('{"enabled": ["fake"]}')
    with client(off, [fake_app()]) as c:
        listing = c.get("/api/apps").json()
        assert listing["available"] is False and listing["apps"][0]["enabled"] is False
        assert c.put("/api/apps/fake", json={"enabled": True}).status_code == 403
        assert c.get("/api/apps/fake/hello").status_code == 404


def test_a_connected_private_app_limits_the_api_to_this_computer(settings):
    with client(settings, [fake_app(connected=True)]) as local:
        local.put("/api/apps/fake", json={"enabled": True})
        assert local.get("/api/apps").status_code == 200
    with client(settings, [fake_app(connected=True)], host="192.168.1.30") as remote:
        response = remote.get("/api/health")
        assert response.status_code == 403
        assert "app connected to private data" in response.json()["error"]["message"]
        # Pages (not /api) still load, so the app can explain.
        assert remote.get("/").status_code in (200, 404)


def test_an_app_that_isnt_connected_doesnt_limit_the_api(settings):
    with client(settings, [fake_app(connected=False)]) as local:
        local.put("/api/apps/fake", json={"enabled": True})
    with client(settings, [fake_app(connected=False)], host="192.168.1.30") as remote:
        assert remote.get("/api/health").status_code == 200

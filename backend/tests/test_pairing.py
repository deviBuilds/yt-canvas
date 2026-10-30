"""Pairing other devices so they can use private data through a tunnel."""

import json
import os

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from app import devices as devices_module
from app.apps import AppSpec
from app.main import create_app


def private_app() -> AppSpec:
    router = APIRouter()

    @router.get("/hello")
    async def hello() -> dict:
        return {"hello": "world"}

    return AppSpec(id="fake", name="Fake", description="", router=router, holds_private_data=True, connected=lambda: True)


@pytest.fixture
def app(settings):
    application = create_app(settings, apps=[private_app()])
    with local(application) as c:
        assert c.put("/api/apps/fake", json={"enabled": True}).status_code == 200
    return application


def local(application) -> TestClient:
    return TestClient(application, client=("127.0.0.1", 50000), base_url="http://localhost:8000")


def remote(application) -> TestClient:
    # Through the tunnel: a public address and the tunnel's own (HTTPS) host name.
    return TestClient(application, client=("203.0.113.5", 50000), base_url="https://abc.trycloudflare.com")


def pair(car: TestClient, home: TestClient) -> str:
    request = car.post("/api/pairing/requests", json={"name": "Tesla"}).json()
    assert home.post("/api/pairing/approve", json={"code": request["code"]}).status_code == 200
    assert car.get(f"/api/pairing/requests/{request['id']}").json() == {"state": "paired"}
    return request["id"]


def test_a_device_pairs_with_a_code_typed_in_on_this_computer(app, settings):
    with remote(app) as car, local(app) as home:
        assert car.get("/api/apps/fake/hello").status_code == 403
        assert car.get("/api/pairing/status").json() == {"local": False, "paired": False, "required": True, "device": None,
                                                       "accounts": False}

        created = car.post("/api/pairing/requests", json={"name": "Tesla"})
        request = created.json()
        assert len(request["code"]) == 6 and request["code"].isdigit() and request["approved"] is False
        pairing_cookie = created.headers["set-cookie"].lower()
        assert "httponly" in pairing_cookie and "secure" in pairing_cookie and "samesite=strict" in pairing_cookie
        assert car.get(f"/api/pairing/requests/{request['id']}").json() == {"state": "waiting"}

        # Only this computer approves, and only with the right code.
        assert car.post("/api/pairing/approve", json={"code": request["code"]}).status_code == 403
        wrong = "000000" if request["code"] != "000000" else "111111"
        assert home.post("/api/pairing/approve", json={"code": wrong}).status_code == 404
        assert home.get("/api/pairing/devices").json()["requests"][0]["code"] == request["code"]
        assert home.post("/api/pairing/approve", json={"code": request["code"]}).json()["approved"] is True

        collected = car.get(f"/api/pairing/requests/{request['id']}")
        assert collected.json() == {"state": "paired"}
        device_cookie = next(h for h in collected.headers.get_list("set-cookie") if h.startswith("ytc_device=")).lower()
        assert "httponly" in device_cookie and "secure" in device_cookie and "samesite=strict" in device_cookie
        assert "max-age=34560000" in device_cookie and "path=/" in device_cookie

        assert car.get("/api/apps/fake/hello").json() == {"hello": "world"}
        assert car.get("/api/pairing/status").json() == {"local": False, "paired": True, "required": True, "device": "Tesla",
                                                       "accounts": False}
        # The request is used up.
        assert car.get(f"/api/pairing/requests/{request['id']}").json() == {"state": "expired"}

    saved = settings.app_config_dir / "devices.json"
    assert oct(os.stat(saved).st_mode & 0o777) == "0o600"
    stored = json.loads(saved.read_text())
    token = car.cookies.get("ytc_device")
    assert token and token not in saved.read_text()
    assert stored["devices"][0]["name"] == "Tesla"


def test_other_devices_and_stolen_request_ids_get_nothing(app):
    with remote(app) as car, remote(app) as stranger, local(app) as home:
        request = car.post("/api/pairing/requests", json={}).json()
        home.post("/api/pairing/approve", json={"code": request["code"]})
        # Without the request's secret cookie the approval can't be collected.
        assert stranger.get(f"/api/pairing/requests/{request['id']}").json() == {"state": "expired"}
        assert car.get(f"/api/pairing/requests/{request['id']}").json() == {"state": "paired"}
        assert stranger.get("/api/apps/fake/hello").status_code == 403
        stranger.cookies.set("ytc_device", "made-up", domain="abc.trycloudflare.com")
        assert stranger.get("/api/apps/fake/hello").status_code == 403


def test_revoking_a_device_locks_it_out(app):
    with remote(app) as car, local(app) as home:
        pair(car, home)
        listing = home.get("/api/pairing/devices").json()
        assert [d["name"] for d in listing["devices"]] == ["Tesla"] and listing["requests"] == []
        assert car.get("/api/pairing/devices").status_code == 403  # only this computer manages devices
        assert home.delete(f"/api/pairing/devices/{listing['devices'][0]['id']}").json() == {"ok": True}
        assert car.get("/api/apps/fake/hello").status_code == 403
        assert home.delete("/api/pairing/devices/nope").status_code == 404


def test_codes_expire(app, monkeypatch):
    with remote(app) as car, local(app) as home:
        request = car.post("/api/pairing/requests", json={}).json()
        now = devices_module.time.time()
        monkeypatch.setattr(devices_module.time, "time", lambda: now + devices_module.REQUEST_TTL + 1)
        assert home.post("/api/pairing/approve", json={"code": request["code"]}).status_code == 404
        assert car.get(f"/api/pairing/requests/{request['id']}").json() == {"state": "expired"}


def test_another_server_process_can_approve(app, settings):
    """The tunnel's server and the dev server share the config folder."""
    other = create_app(settings, apps=[private_app()])
    with remote(app) as car, local(other) as home:
        request = car.post("/api/pairing/requests", json={}).json()
        assert home.post("/api/pairing/approve", json={"code": request["code"]}).status_code == 200
        assert car.get(f"/api/pairing/requests/{request['id']}").json() == {"state": "paired"}
        assert car.get("/api/apps/fake/hello").status_code == 200


def test_nothing_to_pair_for_without_private_data(settings):
    with remote(create_app(settings, apps=[])) as phone:
        assert phone.get("/api/pairing/status").json()["required"] is False
        assert phone.get("/api/health").status_code == 200


def test_device_names_from_user_agents():
    assert devices_module.device_name("Mozilla/5.0 (X11; Linux x86_64) Chrome/100 Safari/537.36 Tesla/2022.20") == "Tesla"
    assert devices_module.device_name("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/605.1.15") == "Safari on iPhone"
    assert devices_module.device_name("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/148.0 Safari/537.36") == "Chrome on Linux"
    assert devices_module.device_name(None) == "Browser"

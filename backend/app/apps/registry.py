"""The app registry: which add-on apps exist, which are on, and their routes."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import APIRouter, Depends, FastAPI
from pydantic import BaseModel

from ..accounts.users import Accounts, current_user, require_user
from ..config import Settings
from ..errors import AppError

log = logging.getLogger(__name__)


def _never() -> bool:
    return False


@dataclass(frozen=True)
class AppSpec:
    id: str
    name: str
    description: str
    # Routes relative to /api/apps/<id>; they answer 404 app_disabled while the app is off.
    router: APIRouter
    # A connected app with private data (a media library, an account) makes the API answer
    # only this computer, like YouTube sign-in does.
    holds_private_data: bool = False
    connected: Callable[[], bool] = _never
    on_disable: Callable[[], None] | None = None


class AppView(BaseModel):
    id: str
    name: str
    description: str
    enabled: bool
    connected: bool
    holds_private_data: bool


class AppList(BaseModel):
    # False when the server runs with YTC_ENABLE_APPS=false: every app is off and can't be turned on.
    available: bool
    apps: list[AppView]


class AppRegistry:
    """Which apps are on: for the whole server in no-login mode, for each person with accounts."""

    def __init__(self, settings: Settings, specs: list[AppSpec], accounts: Accounts | None = None) -> None:
        self.settings = settings
        self.specs = {spec.id: spec for spec in specs}
        self.accounts = accounts
        self._path = settings.app_config_dir / "apps.json"
        self._enabled = self._load() if accounts is None else set()

    @property
    def available(self) -> bool:
        return self.settings.enable_apps

    def _enabled_now(self) -> set[str]:
        if self.accounts is None:
            return self._enabled
        user = current_user()
        return set(self.accounts.latest(user).apps) if user is not None else set()

    def is_enabled(self, app_id: str) -> bool:
        return self.available and app_id in self._enabled_now()

    def spec(self, app_id: str) -> AppSpec:
        spec = self.specs.get(app_id)
        if spec is None:
            raise AppError("not_found", "There's no app with that name.", status=404)
        return spec

    def view(self, spec: AppSpec) -> AppView:
        enabled = self.is_enabled(spec.id)
        return AppView(id=spec.id, name=spec.name, description=spec.description, enabled=enabled,
                       connected=enabled and spec.connected(), holds_private_data=spec.holds_private_data)

    def listing(self) -> AppList:
        return AppList(available=self.available, apps=[self.view(spec) for spec in self.specs.values()])

    async def set_enabled(self, app_id: str, enabled: bool) -> AppView:
        spec = self.spec(app_id)
        if not self.available:
            raise AppError("forbidden", "Apps are turned off on this server (YTC_ENABLE_APPS=false).", status=403)
        apps = set(self._enabled_now())
        was_on = app_id in apps
        apps = apps | {app_id} if enabled else apps - {app_id}
        if self.accounts is not None:
            await self.accounts.set_apps(require_user(), apps)
        else:
            self._enabled = apps
            self._save()
        if was_on and not enabled and spec.on_disable:
            spec.on_disable()
        log.info("app %s %s", app_id, "enabled" if enabled else "disabled")
        return self.view(spec)

    def private_data_active(self) -> bool:
        """Is an enabled app connected to private data right now?"""
        return any(spec.holds_private_data and self.is_enabled(app_id) and spec.connected()
                   for app_id, spec in self.specs.items())

    def mount(self, app: FastAPI) -> None:
        for spec in self.specs.values():
            app.include_router(spec.router, prefix=f"/api/apps/{spec.id}", dependencies=[Depends(self._requirer(spec))])

    def _requirer(self, spec: AppSpec) -> Callable[[], None]:
        def require_enabled() -> None:
            if not self.is_enabled(spec.id):
                raise AppError("app_disabled", f"The {spec.name} app is turned off.", status=404,
                               hint="Turn it on in Apps.")
        return require_enabled

    def _load(self) -> set[str]:
        try:
            data = json.loads(self._path.read_text("utf-8"))
            return {app_id for app_id in data["enabled"] if app_id in self.specs}
        except FileNotFoundError:
            return set()
        except (OSError, ValueError, KeyError, TypeError) as exc:
            log.warning("ignoring unreadable %s (%s); every app starts off", self._path, exc)
            return set()

    def _save(self) -> None:
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = self._path.with_name(f"apps.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"enabled": sorted(self._enabled)}, indent=2) + "\n", "utf-8")
        os.replace(tmp, self._path)

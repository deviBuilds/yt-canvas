"""Add-on apps: optional features such as Plex, each off until turned on in Apps.

An app is a backend package with an :class:`AppSpec`, whose routes live under
``/api/apps/<id>/``, plus a frontend module. While an app is off, its routes answer
404 ``app_disabled`` and the browser never loads its code. Which apps are on is kept in
``<config dir>/apps.json`` (``YTC_CONFIG_DIR``), outside the repository and the media
cache, or with accounts on, in each person's account. ``YTC_ENABLE_APPS=false`` keeps every
app off, e.g. on a server shared through a tunnel.
"""

from __future__ import annotations

from ..accounts.users import Accounts
from ..config import Settings
from .plex import plex_app
from .registry import AppList, AppRegistry, AppSpec, AppView

__all__ = ["AppList", "AppRegistry", "AppSpec", "AppView", "default_apps"]


def default_apps(settings: Settings, accounts: Accounts | None = None) -> list[AppSpec]:
    return [plex_app(settings, accounts)]

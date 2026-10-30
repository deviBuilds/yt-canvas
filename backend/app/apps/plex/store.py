"""The Plex sign-in: in no-login mode kept in ``<config dir>/plex.json`` (mode 0600).

It holds the Plex client identifier, the account's token from the PIN sign-in, and the
chosen server's address and access token. Never sent to the browser. With accounts on, each
person has their own, held in memory and saved (encrypted) to their account through
``persist`` (see ``users.py``).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


class PlexStore:
    def __init__(self, directory: Path | None, *, data: dict[str, Any] | None = None,
                 persist: Callable[[dict[str, Any]], None] | None = None) -> None:
        self._path = directory / "plex.json" if directory is not None else None
        self._persist = persist
        self._data: dict[str, Any] = dict(data) if data is not None else self._load()

    @property
    def client_id(self) -> str:
        """Stable per installation: Plex lists it as a device the account can revoke."""
        if not self._data.get("client_id"):
            self._data["client_id"] = f"yt-canvas-{uuid.uuid4()}"
            self._save()
        return self._data["client_id"]

    @property
    def account(self) -> dict[str, Any] | None:
        return self._data.get("account")

    @property
    def server(self) -> dict[str, Any] | None:
        return self._data.get("server")

    @property
    def connected(self) -> bool:
        return bool(self.account and self.server)

    def set_account(self, token: str, name: str | None, avatar: str | None) -> None:
        self._data["account"] = {"token": token, "name": name, "avatar": avatar}
        self._save()

    def set_server(self, server: dict[str, Any]) -> None:
        self._data["server"] = server
        self._save()

    def clear(self) -> None:
        """Forget the account and server; keep the client identifier."""
        self._data.pop("account", None)
        self._data.pop("server", None)
        self._save()

    def _load(self) -> dict[str, Any]:
        if self._path is None:
            return {}
        try:
            data = json.loads(self._path.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            log.warning("ignoring unreadable %s (%s)", self._path, exc)
            return {}

    def _save(self) -> None:
        if self._persist is not None:
            self._persist(dict(self._data))
            return
        assert self._path is not None
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = self._path.with_name(f"plex.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(self._data, handle, indent=2)
        os.replace(tmp, self._path)

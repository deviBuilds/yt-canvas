"""An in-memory stand-in for the Convex deployment's /backend operations (frontend/convex/backend.ts)."""

from __future__ import annotations

import copy
import itertools
import time
from typing import Any

LIMITS = {"favorites": 200, "history": 100, "searches": 12}


class FakeConvex:
    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.allowlist: dict[str, dict[str, Any]] = {}
        self.secrets: dict[tuple[str, str], dict[str, Any]] = {}
        self.devices: dict[str, dict[str, Any]] = {}
        self.library: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.calls: list[str] = []
        self.down = False
        self._ids = itertools.count(1)
        self._clock = itertools.count(1_700_000_000_000, 1000)

    def _id(self, table: str) -> str:
        return f"{table}_{next(self._ids)}"

    async def call(self, op: str, **args: Any) -> Any:
        from app.accounts.convex import unavailable

        if self.down:
            raise unavailable("HTTP 503")
        self.calls.append(op)
        return copy.deepcopy(getattr(self, "op_" + op.replace(".", "_"))(**copy.deepcopy(args)))

    def _user_view(self, user: dict[str, Any]) -> dict[str, Any]:
        secrets = {kind: {"meta": s["meta"], "updatedAt": s["updatedAt"]}
                   for (uid, kind), s in self.secrets.items() if uid == user["id"]}
        return {**{k: user[k] for k in ("id", "clerkId", "email", "apps")}, "name": user.get("name"),
                "imageUrl": user.get("imageUrl"), "secrets": secrets}

    def _device_view(self, d: dict[str, Any]) -> dict[str, Any]:
        return {"id": d["id"], "name": d["name"], "created": d["createdAt"] / 1000, "last_seen": d["lastSeen"] / 1000}

    # -- users -------------------------------------------------------------------------------

    def op_users_resolve(self, clerkId: str, email: str, admin: bool, name: str | None = None,  # noqa: N803
                         imageUrl: str | None = None) -> dict[str, Any]:  # noqa: N803
        email = email.strip().lower()
        if not admin and email not in self.allowlist:
            return {"allowed": False, "user": None}
        user = next((u for u in self.users.values() if u["clerkId"] == clerkId), None)
        if user is None:
            user = {"id": self._id("users"), "clerkId": clerkId, "email": email, "apps": [], "createdAt": time.time()}
            self.users[user["id"]] = user
        user.update(email=email, name=name, imageUrl=imageUrl)
        return {"allowed": True, "user": self._user_view(user)}

    def op_users_setApps(self, userId: str, apps: list[str]) -> None:  # noqa: N802,N803
        self.users[userId]["apps"] = apps

    # -- secrets -------------------------------------------------------------------------------

    def op_secrets_get(self, userId: str, kind: str) -> dict[str, Any] | None:  # noqa: N803
        s = self.secrets.get((userId, kind))
        return s and {"ciphertext": s["ciphertext"], "meta": s["meta"], "updatedAt": s["updatedAt"]}

    def op_secrets_put(self, userId: str, kind: str, ciphertext: str, meta: Any) -> int:  # noqa: N803
        updated = next(self._clock)
        self.secrets[(userId, kind)] = {"ciphertext": ciphertext, "meta": meta, "updatedAt": updated}
        return updated

    def op_secrets_delete(self, userId: str, kind: str) -> bool:  # noqa: N803
        return self.secrets.pop((userId, kind), None) is not None

    # -- devices -------------------------------------------------------------------------------

    def op_devices_create(self, userId: str, name: str, tokenHash: str) -> dict[str, Any]:  # noqa: N803
        now = next(self._clock)
        device = {"id": self._id("devices"), "userId": userId, "name": name, "tokenHash": tokenHash,
                  "createdAt": now, "lastSeen": now}
        self.devices[device["id"]] = device
        return self._device_view(device)

    def op_devices_byHash(self, tokenHash: str) -> dict[str, Any] | None:  # noqa: N802,N803
        device = next((d for d in self.devices.values() if d["tokenHash"] == tokenHash), None)
        user = device and self.users.get(device["userId"])
        if not user:
            return None
        return {"device": self._device_view(device), "user": self._user_view(user),
                "allowed": user["email"] in self.allowlist}

    def op_devices_touch(self, deviceId: str) -> None:  # noqa: N803
        if deviceId in self.devices:
            self.devices[deviceId]["lastSeen"] = next(self._clock)

    def op_devices_list(self, userId: str) -> list[dict[str, Any]]:  # noqa: N803
        return [self._device_view(d) for d in self.devices.values() if d["userId"] == userId]

    def op_devices_revoke(self, userId: str, deviceId: str) -> str | None:  # noqa: N803
        device = self.devices.get(deviceId)
        if not device or device["userId"] != userId:
            return None
        del self.devices[deviceId]
        return device["tokenHash"]

    # -- library -------------------------------------------------------------------------------

    def _rows(self, user_id: str, name: str) -> list[dict[str, Any]]:
        rows = [row for (uid, lst, _), row in self.library.items() if uid == user_id and lst == name]
        return sorted(rows, key=lambda row: row["updatedAt"], reverse=True)

    def op_library_get(self, userId: str) -> dict[str, Any]:  # noqa: N803
        return {name: [row["data"] for row in self._rows(userId, name)[:limit]] for name, limit in LIMITS.items()}

    def op_library_put(self, userId: str, list: str, entries: list[dict[str, Any]]) -> None:  # noqa: A002,N803
        for entry in entries:
            existing = self.library.get((userId, list, entry["key"]))
            if existing is None or existing["updatedAt"] <= entry["updatedAt"]:
                self.library[(userId, list, entry["key"])] = entry
        for row in self._rows(userId, list)[LIMITS[list]:]:
            del self.library[(userId, list, row["key"])]

    def op_library_remove(self, userId: str, list: str, key: str) -> None:  # noqa: A002,N803
        self.library.pop((userId, list, key), None)

    def op_library_clear(self, userId: str, list: str) -> None:  # noqa: A002,N803
        for k in [k for k in self.library if k[0] == userId and k[1] == list]:
            del self.library[k]

    # -- allowlist -----------------------------------------------------------------------------

    def op_allowlist_list(self) -> list[dict[str, Any]]:
        return sorted(({"email": e, "addedBy": v.get("addedBy"), "addedAt": v["addedAt"]}
                       for e, v in self.allowlist.items()), key=lambda e: e["email"])

    def op_allowlist_add(self, emails: list[str], addedBy: str | None = None) -> int:  # noqa: N803
        added = 0
        for raw in emails:
            email = raw.strip().lower()
            if email and email not in self.allowlist:
                self.allowlist[email] = {"addedBy": addedBy, "addedAt": time.time()}
                added += 1
        return added

    def op_allowlist_remove(self, email: str) -> bool:
        return self.allowlist.pop(email.strip().lower(), None) is not None

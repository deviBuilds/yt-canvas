"""AES-256-GCM for secrets kept in Convex (YouTube cookies, Plex tokens).

The key (``YTC_SECRETS_KEY``, 32 bytes in urlsafe base64) exists only in the server's
environment, so Convex stores ciphertext it can't read. Each ciphertext is bound to its
owner and kind (the associated data), so a row copied to another user doesn't decrypt.
"""

from __future__ import annotations

import base64
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VERSION = "v1"


class SecretsKeyError(ValueError):
    pass


def _key(encoded: str) -> bytes:
    try:
        key = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except ValueError as exc:
        raise SecretsKeyError("YTC_SECRETS_KEY must be urlsafe base64.") from exc
    if len(key) != 32:
        raise SecretsKeyError("YTC_SECRETS_KEY must be 32 bytes (44 characters of base64).")
    return key


def new_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode()


class Sealer:
    def __init__(self, encoded_key: str) -> None:
        self._aead = AESGCM(_key(encoded_key))

    def seal(self, plaintext: bytes, context: str) -> str:
        nonce = os.urandom(12)
        sealed = self._aead.encrypt(nonce, plaintext, context.encode())
        return f"{VERSION}.{base64.urlsafe_b64encode(nonce + sealed).decode()}"

    def open(self, token: str, context: str) -> bytes | None:
        """The plaintext, or None if the token is damaged, from another key, or another context."""
        version, _, body = token.partition(".")
        if version != VERSION:
            return None
        try:
            raw = base64.urlsafe_b64decode(body)
            return self._aead.decrypt(raw[:12], raw[12:], context.encode())
        except (ValueError, InvalidTag):
            return None

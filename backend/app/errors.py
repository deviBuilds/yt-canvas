"""User-facing error type and helpers for keeping secrets out of logs."""

from __future__ import annotations

import re
from typing import Any


class AppError(Exception):
    """An error with a stable machine-readable ``code`` and an actionable message.

    ``message`` and ``hint`` are shown to users, so they must never contain raw
    subprocess output, signed URLs or filesystem paths.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 400,
        hint: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.hint = hint
        self.retryable = retryable

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "hint": self.hint,
            "retryable": self.retryable,
        }


_URL_QUERY_RE = re.compile(r"(https?://[^\s?#\"'<>]+)[?#][^\s\"'<>]*", re.IGNORECASE)
_SECRET_PARAM_RE = re.compile(
    r"\b(sig|lsig|signature|token|pot|key|cookie|authorization|n)=([^\s&\"']+)", re.IGNORECASE
)


def redact(text: str) -> str:
    """Strip query strings (signatures, IP bindings, tokens) from URLs in ``text``."""
    text = _URL_QUERY_RE.sub(r"\1?<redacted>", text)
    return _SECRET_PARAM_RE.sub(r"\1=<redacted>", text)

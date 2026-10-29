from __future__ import annotations

import dataclasses
import os
from pathlib import Path

import pytest

# Keep the developer's .env out of unit tests: it may switch on YouTube sign-in, which
# would read real browser cookies. Opt-in live runs (YTC_LIVE_TESTS=1) do use it, so the
# signed-in live tests can run against the account set up there. This runs before any
# test module imports app.main (which builds an app from the environment at import time).
if os.environ.get("YTC_LIVE_TESTS") != "1":
    os.environ["YTC_IGNORE_DOTENV"] = "1"

from app.config import Settings  # noqa: E402


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        min_free_disk_bytes=0,
        frontend_dist=None,
        cleanup_interval_seconds=3600,
    )


def with_settings(settings: Settings, **changes) -> Settings:
    return dataclasses.replace(settings, **changes)

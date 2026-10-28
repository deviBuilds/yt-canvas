from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from app.config import Settings


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

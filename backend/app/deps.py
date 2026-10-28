"""Detect external tools (yt-dlp, yt-dlp-ejs, JS runtime, ffmpeg, ffprobe)."""

from __future__ import annotations

import logging
import re
import shutil
from dataclasses import asdict, dataclass, field
from importlib import metadata

from .config import Settings
from .procs import ProcessFailure, run_process

log = logging.getLogger(__name__)

# Minimum versions documented in the yt-dlp EJS wiki.
JS_RUNTIME_NOTES = {
    "deno": "recommended; enabled by default; minimum 2.3.0",
    "node": "minimum 22.0.0; enable with YTC_YTDLP_JS_RUNTIMES=node",
    "bun": "deprecated by yt-dlp; supported 1.2.11-1.3.14 only",
    "quickjs": "minimum 2023-12-9 (QuickJS) / 0.12.0 (QuickJS-NG) for usable speed",
}
_RUNTIME_BINARIES = {"deno": "deno", "node": "node", "bun": "bun", "quickjs": "qjs"}


@dataclass
class Tool:
    name: str
    available: bool
    version: str | None = None
    path: str | None = None
    note: str | None = None


@dataclass
class DependencyReport:
    ytdlp: Tool
    ytdlp_ejs: Tool
    ffmpeg: Tool
    ffprobe: Tool
    js_runtimes: list[Tool] = field(default_factory=list)
    js_runtime_enabled: str | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def can_extract(self) -> bool:
        return self.ytdlp.available

    @property
    def can_process(self) -> bool:
        return self.ffmpeg.available and self.ffprobe.available

    def to_dict(self) -> dict:
        data = asdict(self)
        data["can_extract"] = self.can_extract
        data["can_process"] = self.can_process
        return data


async def _version(args: list[str]) -> str | None:
    try:
        result = await run_process(args, timeout=15, max_stdout=256 * 1024)
    except (ProcessFailure, OSError):
        return None
    if result.returncode != 0:
        return None
    text = (result.stdout.decode("utf-8", "replace") or result.stderr_tail).strip()
    return text.splitlines()[0].strip() if text else None


def _pkg_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


async def detect_dependencies(settings: Settings) -> DependencyReport:
    warnings: list[str] = []

    ytdlp_version = await _version([*settings.ytdlp_command, "--version"])
    ytdlp = Tool("yt-dlp", ytdlp_version is not None, ytdlp_version, " ".join(settings.ytdlp_command))
    if not ytdlp.available:
        warnings.append("yt-dlp is not runnable: YouTube search and preparation will fail. "
                        "Install backend/requirements.txt.")

    ejs_version = _pkg_version("yt-dlp-ejs")
    ytdlp_ejs = Tool("yt-dlp-ejs", ejs_version is not None, ejs_version)
    if ejs_version is None:
        warnings.append("yt-dlp-ejs is not installed; YouTube downloads may fail. Install yt-dlp[default].")

    tools = {}
    for key, binary in (("ffmpeg", settings.ffmpeg_path), ("ffprobe", settings.ffprobe_path)):
        path = shutil.which(binary)
        version = await _version([path, "-version"]) if path else None
        if version:
            match = re.search(r"version (\S+)", version)
            version = match.group(1) if match else version
        tools[key] = Tool(key, version is not None, version, path)
        if version is None:
            warnings.append(f"{key} was not found: media preparation will fail. Install FFmpeg.")

    runtimes: list[Tool] = []
    for name, binary in _RUNTIME_BINARIES.items():
        path = shutil.which(binary)
        version = None
        if path:
            version = await _version([path, "--version"] if name != "quickjs" else [path, "-h"])
            if version and name == "deno":
                version = version.split()[1] if len(version.split()) > 1 else version
        runtimes.append(Tool(name, path is not None, version, path, JS_RUNTIME_NOTES[name]))

    available = {tool.name for tool in runtimes if tool.available}
    if settings.ytdlp_js_runtimes:
        enabled = settings.ytdlp_js_runtimes[0].split(":", 1)[0]
    elif "deno" in available:
        enabled = "deno"
    else:
        enabled = None
        alt = next((name for name in ("node", "quickjs", "bun") if name in available), None)
        hint = f" {alt} is installed: set YTC_YTDLP_JS_RUNTIMES={alt} to use it." if alt else ""
        warnings.append("No JavaScript runtime is enabled for yt-dlp (Deno is the default). "
                        "YouTube extraction may be missing formats or fail." + hint)

    report = DependencyReport(
        ytdlp=ytdlp,
        ytdlp_ejs=ytdlp_ejs,
        ffmpeg=tools["ffmpeg"],
        ffprobe=tools["ffprobe"],
        js_runtimes=runtimes,
        js_runtime_enabled=enabled,
        warnings=warnings,
    )
    for warning in warnings:
        log.warning(warning)
    return report

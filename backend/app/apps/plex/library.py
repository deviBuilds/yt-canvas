"""Browsing a Plex server: libraries, home rows, items, seasons, episodes and search.

Plex's responses are turned into small models of our own. Image paths become URLs of the
backend's image proxy, so the browser never needs the server address or a token.
"""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

from pydantic import BaseModel

from ...errors import AppError
from .service import PlexService

IMAGE_PATH = re.compile(r"^/library/metadata/\d+/[A-Za-z]+/\d+$")
BROWSABLE = {"movie", "show"}


def image_url(path: Any, width: int, height: int) -> str | None:
    if not isinstance(path, str) or not IMAGE_PATH.match(path):
        return None
    return "/api/apps/plex/image?" + urllib.parse.urlencode({"path": path, "w": width, "h": height})


class PlexLibrary(BaseModel):
    key: str
    title: str
    type: str


class PlexItem(BaseModel):
    key: str
    type: str  # movie, show, season, episode
    title: str
    year: int | None = None
    summary: str | None = None
    duration_seconds: int | None = None
    poster: str | None = None
    # Episodes: a 16:9 still. Movies and shows: the background art.
    still: str | None = None
    art: str | None = None
    view_offset_seconds: int | None = None
    watched: bool = False
    show_title: str | None = None
    season: int | None = None
    episode: int | None = None
    child_count: int | None = None
    library: str | None = None
    # Recently added: several new episodes of one season, shown as that season.
    new_episodes: int | None = None


class PlexStream(BaseModel):
    id: int
    index: int | None
    kind: str  # video, audio, subtitle
    codec: str | None
    language: str | None
    title: str | None
    channels: int | None = None
    default: bool = False
    selected: bool = False


class PlexMedia(BaseModel):
    container: str | None
    video_codec: str | None
    video_resolution: str | None
    width: int | None
    height: int | None
    frame_rate: str | None
    audio_codec: str | None
    audio_channels: int | None
    bitrate_kbps: int | None
    size_bytes: int | None
    part_id: int | None
    streams: list[PlexStream]


class PlexDetails(PlexItem):
    tagline: str | None = None
    content_rating: str | None = None
    audience_rating: float | None = None
    studio: str | None = None
    genres: list[str] = []
    directors: list[str] = []
    cast: list[str] = []
    media: list[PlexMedia] = []
    children: list[PlexItem] = []


class PlexRow(BaseModel):
    library: PlexLibrary
    items: list[PlexItem]


class PlexHome(BaseModel):
    continue_watching: list[PlexItem]
    rows: list[PlexRow]


class PlexPage(BaseModel):
    items: list[PlexItem]
    offset: int
    total: int


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _seconds(ms: Any) -> int | None:
    value = _int(ms)
    return round(value / 1000) if value is not None else None


def _tags(raw: dict[str, Any], key: str, limit: int = 10) -> list[str]:
    return [tag["tag"] for tag in raw.get(key, []) if isinstance(tag, dict) and tag.get("tag")][:limit]


def item(raw: dict[str, Any]) -> PlexItem:
    kind = str(raw.get("type", ""))
    episode = kind == "episode"
    return PlexItem(
        key=str(raw.get("ratingKey", "")),
        type=kind,
        title=str(raw.get("title") or ""),
        year=_int(raw.get("year")) or _int(raw.get("parentYear")),
        summary=raw.get("summary") or None,
        duration_seconds=_seconds(raw.get("duration")),
        poster=image_url(raw.get("grandparentThumb") if episode else raw.get("thumb") or raw.get("parentThumb"), 300, 450),
        still=image_url(raw.get("thumb"), 480, 270) if episode else None,
        art=image_url(raw.get("art") or raw.get("grandparentArt"), 1280, 720),
        view_offset_seconds=_seconds(raw.get("viewOffset")),
        watched=bool(_int(raw.get("viewCount"))) if kind in ("movie", "episode") else (
            _int(raw.get("viewedLeafCount")) is not None and raw.get("viewedLeafCount") == raw.get("leafCount")),
        show_title=raw.get("grandparentTitle") if episode else raw.get("parentTitle") if kind == "season" else None,
        season=_int(raw.get("parentIndex")) if episode else _int(raw.get("index")) if kind == "season" else None,
        episode=_int(raw.get("index")) if episode else None,
        child_count=_int(raw.get("childCount")) if kind == "show" else _int(raw.get("leafCount")) if kind == "season" else None,
        library=raw.get("librarySectionTitle"),
    )


RECENT_ROW = 24  # cards in a recently added row
RECENT_FETCH = 400  # episodes read to fill it once they're grouped (a whole series may arrive at once)


def group_recent(raws: list[dict[str, Any]], limit: int = RECENT_ROW) -> list[PlexItem]:
    """Recently added, with episodes grouped by season as Plex's own apps do.

    Plex lists every new episode on its own. Several new episodes of one season become one
    card for that season (its poster, or the show's, with the season number); a lone episode
    stays an episode. Cards keep the order of each group's newest entry.
    """
    seasons: dict[str, list[dict[str, Any]]] = {}
    order: list[tuple[str, str]] = []  # ("season", season key) or ("item", index)
    for index, raw in enumerate(raws):
        season_key = raw.get("parentRatingKey")
        if raw.get("type") == "episode" and season_key:
            if str(season_key) not in seasons:
                order.append(("season", str(season_key)))
            seasons.setdefault(str(season_key), []).append(raw)
        else:
            order.append(("item", str(index)))
    cards: list[PlexItem] = []
    seen: set[str] = set()
    for kind, key in order:
        episodes = seasons.get(key, []) if kind == "season" else []
        if kind == "item" or len(episodes) == 1:
            card = item(raws[int(key)] if kind == "item" else episodes[0])
        else:
            first = episodes[0]
            card = PlexItem(
                key=key, type="season", title=first.get("parentTitle") or f"Season {first.get('parentIndex', '?')}",
                poster=image_url(first.get("parentThumb") or first.get("grandparentThumb"), 300, 450),
                art=image_url(first.get("grandparentArt") or first.get("art"), 1280, 720),
                show_title=first.get("grandparentTitle"), season=_int(first.get("parentIndex")),
                watched=all(_int(e.get("viewCount")) for e in episodes), new_episodes=len(episodes),
                library=first.get("librarySectionTitle"))
        if card.key and card.key not in seen:
            seen.add(card.key)
            cards.append(card)
        if len(cards) >= limit:
            break
    return cards


def media(raw: dict[str, Any]) -> PlexMedia:
    part = (raw.get("Part") or [{}])[0]
    streams = []
    for stream in part.get("Stream", []):
        kind = {1: "video", 2: "audio", 3: "subtitle"}.get(stream.get("streamType"))
        if not kind:
            continue
        streams.append(PlexStream(
            id=int(stream["id"]),
            index=_int(stream.get("index")),
            kind=kind,
            codec=stream.get("codec"),
            language=stream.get("language") or stream.get("languageCode"),
            title=stream.get("displayTitle") or stream.get("extendedDisplayTitle"),
            channels=_int(stream.get("channels")),
            default=bool(stream.get("default")),
            selected=bool(stream.get("selected")),
        ))
    return PlexMedia(
        container=part.get("container") or raw.get("container"),
        video_codec=raw.get("videoCodec"),
        video_resolution=raw.get("videoResolution"),
        width=_int(raw.get("width")),
        height=_int(raw.get("height")),
        frame_rate=raw.get("videoFrameRate"),
        audio_codec=raw.get("audioCodec"),
        audio_channels=_int(raw.get("audioChannels")),
        bitrate_kbps=_int(raw.get("bitrate")),
        size_bytes=_int(part.get("size")),
        part_id=_int(part.get("id")),
        streams=streams,
    )


def details(raw: dict[str, Any], children: list[dict[str, Any]]) -> PlexDetails:
    base = item(raw).model_dump()
    rating = raw.get("audienceRating") or raw.get("rating")
    return PlexDetails(
        **base,
        tagline=raw.get("tagline"),
        content_rating=raw.get("contentRating"),
        audience_rating=float(rating) if isinstance(rating, (int, float)) else None,
        studio=raw.get("studio"),
        genres=_tags(raw, "Genre"),
        directors=_tags(raw, "Director", 3),
        cast=_tags(raw, "Role", 12),
        media=[media(m) for m in raw.get("Media", []) if isinstance(m, dict)],
        children=[item(child) for child in children],
    )


class PlexLibraryService:
    def __init__(self, plex: PlexService) -> None:
        self.plex = plex

    async def libraries(self) -> list[PlexLibrary]:
        container = await self.plex.json("/library/sections", what="library list")
        return [PlexLibrary(key=str(d["key"]), title=d.get("title") or "Library", type=d["type"])
                for d in container.get("Directory", []) if d.get("type") in BROWSABLE]

    async def home(self) -> PlexHome:
        watching = await self.plex.json("/hubs/home/continueWatching", what="continue watching")
        continue_watching = [item(m) for m in watching.get("Metadata", [])]
        if not continue_watching:
            on_deck = await self.plex.json("/library/onDeck", what="on deck")
            continue_watching = [item(m) for m in on_deck.get("Metadata", [])]
        rows = []
        for library in await self.libraries():
            size = RECENT_FETCH if library.type == "show" else RECENT_ROW
            recent = await self.plex.json(f"/library/sections/{library.key}/recentlyAdded",
                                          {"X-Plex-Container-Start": 0, "X-Plex-Container-Size": size}, what="library")
            items = group_recent(recent.get("Metadata", []))
            if items:
                rows.append(PlexRow(library=library, items=items))
        return PlexHome(continue_watching=continue_watching, rows=rows)

    async def library_items(self, key: str, offset: int, limit: int, sort: str) -> PlexPage:
        library = next((lib for lib in await self.libraries() if lib.key == key), None)
        if library is None:
            raise_not_found("library")
        container = await self.plex.json(f"/library/sections/{key}/all", {
            "type": 1 if library.type == "movie" else 2,
            "sort": {"title": "titleSort", "added": "addedAt:desc", "year": "year:desc"}.get(sort, "titleSort"),
            "X-Plex-Container-Start": offset,
            "X-Plex-Container-Size": limit,
        }, what="library")
        items = [item(m) for m in container.get("Metadata", [])]
        total = _int(container.get("totalSize")) or offset + len(items)
        return PlexPage(items=items, offset=offset, total=total)

    async def details(self, key: str) -> PlexDetails:
        container = await self.plex.json(f"/library/metadata/{key}", what="item")
        found = container.get("Metadata") or []
        if not found:
            raise_not_found("item")
        raw = found[0]
        children: list[dict[str, Any]] = []
        if raw.get("type") in ("show", "season"):
            children = (await self.plex.json(f"/library/metadata/{key}/children", what="item")).get("Metadata", [])
        return details(raw, children)

    async def search(self, query: str) -> list[PlexItem]:
        container = await self.plex.json("/hubs/search", {"query": query, "limit": 20}, what="search")
        found: list[PlexItem] = []
        for hub in container.get("Hub", []):
            if hub.get("type") in ("movie", "show", "episode"):
                found.extend(item(m) for m in hub.get("Metadata", []))
        return found

    async def image(self, path: str, width: int, height: int) -> tuple[bytes, str]:
        if not IMAGE_PATH.match(path):
            raise_not_found("image")
        response = await self.plex.get("/photo/:/transcode", {
            "width": width, "height": height, "minSize": 1, "upscale": 1, "url": path,
        }, what="image", headers={"Accept": "image/*"})
        return response.body, response.header("Content-Type") or "image/jpeg"


def raise_not_found(what: str) -> None:
    raise AppError("not_found", f"Plex doesn't have that {what}.", status=404)

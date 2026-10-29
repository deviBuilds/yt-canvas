"""Feeds and related videos parsed from public YouTube pages (no network).

The fixtures are small hand-written ``ytInitialData`` fragments that mirror the
shapes seen on the real Music, Live, News and Gaming pages and on a logged-out
watch page (October 2026), not page dumps.
"""

import json
import urllib.error

import pytest
from fastapi.testclient import TestClient

from app.discovery import youtube_pages as yp
from app.discovery.normalize import normalize_entry
from app.errors import AppError
from app.main import create_app

from .conftest import with_settings

UC_FOX = "UCwNqHDsnBCKT-olwJwIFyfg"
UC_TAYLOR = "UCqECaJ8Gagnn7YCbPEzWH6g"
UC_BUDDHA = "UCgV6JBw3eqr2V_-EbWa8mvQ"
AVATAR = "https://yt3.ggpht.com/fox=s68-c-k-c0x00ffffff-no-rj"
AVATAR_TAYLOR = "https://yt3.googleusercontent.com/taylor=s88-c-k-c0x00ffffff-no-rj"
STATION_ID = "RDCLAK5uy_k5n4srrEB1wgvIjPNTXS9G1ufE9WQxhnA"


# --- Fixture builders ---------------------------------------------------------

def runs(*texts):
    return {"runs": [{"text": text} for text in texts]}


def channel_link(name, channel_id=UC_FOX, base="/@foxsports"):
    return {"runs": [{"text": name, "navigationEndpoint": {
        "commandMetadata": {"webCommandMetadata": {"url": base, "webPageType": "WEB_PAGE_TYPE_CHANNEL"}},
        "browseEndpoint": {"browseId": channel_id, "canonicalBaseUrl": base},
    }}]}


def watch_endpoint(video_id, url=None):
    return {"commandMetadata": {"webCommandMetadata": {"url": url or f"/watch?v={video_id}"}},
            "watchEndpoint": {"videoId": video_id}}


def video_renderer(video_id, title="Bombshell report rocks Alaska Senate race", *, length="12:34",
                   overlay=("DEFAULT", None), views="1,234 views", published="2 hours ago", **extra):
    """``videoRenderer`` as on the News and Live pages; pass ``None`` to omit a field."""
    style, text = overlay
    renderer = {
        "videoId": video_id,
        "thumbnail": {"thumbnails": [
            {"url": f"https://i.ytimg.com/vi/{video_id}/hq720.jpg?sqp=small", "width": 360, "height": 202},
            {"url": f"https://i.ytimg.com/vi/{video_id}/hq720.jpg?sqp=large", "width": 720, "height": 404},
        ]},
        "title": runs(title),
        "ownerText": channel_link("FOX Sports"),
        "navigationEndpoint": watch_endpoint(video_id),
        "thumbnailOverlays": [
            {"thumbnailOverlayTimeStatusRenderer": {"text": runs(text or length or ""), "style": style}},
            {"thumbnailOverlayToggleButtonRenderer": {"untoggledTooltip": "Watch later"}},
        ],
        "channelThumbnailSupportedRenderers": {"channelThumbnailWithLinkRenderer": {
            "thumbnail": {"thumbnails": [{"url": AVATAR, "width": 68, "height": 68}]},
            "navigationEndpoint": {"browseEndpoint": {"browseId": UC_FOX, "canonicalBaseUrl": "/@foxsports"}},
        }},
    }
    if length:
        renderer["lengthText"] = {"simpleText": length}
    if views:
        renderer["viewCountText"] = {"simpleText": views}
    if published:
        renderer["publishedTimeText"] = {"simpleText": published}
    renderer.update(extra)
    return renderer


def live_renderer(video_id):
    return video_renderer(video_id, "World Series Game 5", length=None, published=None, overlay=("LIVE", "LIVE"),
                          views=None, viewCountText=runs("17,363", " watching"))


def upcoming_renderer(video_id):
    return video_renderer(video_id, "2026 Midterm Election coverage", length=None, published=None,
                          overlay=("UPCOMING", "Upcoming"), views=None, viewCountText=runs("7", " waiting"),
                          upcomingEventData={"startTime": "1793746800", "upcomingEventText": runs("Scheduled for ")})


def streamed_renderer(video_id):
    return video_renderer(video_id, "Indie World Showcase", length="1:56:45", views="836,450 views",
                          published="Streamed 9h ago")


def part(text, *, label=None, icon=None, channel_id=None, base=None):
    data = {"text": {"content": text}}
    if channel_id:
        data["text"]["commandRuns"] = [{"startIndex": 0, "length": len(text), "onTap": {"innertubeCommand": {
            "browseEndpoint": {"browseId": channel_id, "canonicalBaseUrl": base or f"/channel/{channel_id}"},
        }}}]
    if label:
        data["accessibilityLabel"] = label
    if icon:
        data["leadingIcon"] = {"name": icon, "height": 12, "width": 12}
    return data


def lockup(video_id, title="Taylor Swift - Our Song", *, content_type="LOCKUP_CONTENT_TYPE_VIDEO",
           badge="3:23", badge_style="THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT", rows=None, url=None):
    """``lockupViewModel`` as on the Music page and in watch-page related videos."""
    if rows is None:
        rows = [
            [part("Taylor Swift", channel_id=UC_TAYLOR)],
            [part("231M", label="231 million views", icon="PLAY_ARROW_OUTLINED"),
             part("17y ago", label="17 years ago")],
        ]
    return {
        "contentImage": {"thumbnailViewModel": {
            "image": {"sources": [
                {"url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg?sqp=x", "width": 480, "height": 270},
            ]},
            "overlays": [
                {"thumbnailBottomOverlayViewModel": {"badges": [
                    {"thumbnailBadgeViewModel": {"text": badge, "badgeStyle": badge_style}},
                ]}},
                {"thumbnailHoverOverlayToggleActionsViewModel": {"buttons": []}},
            ],
        }},
        "metadata": {"lockupMetadataViewModel": {
            "title": {"content": title},
            "image": {"decoratedAvatarViewModel": {
                "avatar": {"avatarViewModel": {"image": {"sources": [
                    {"url": AVATAR_TAYLOR, "width": 68, "height": 68},
                ]}}},
                "rendererContext": {"commandContext": {"onTap": {"innertubeCommand": {
                    "browseEndpoint": {"browseId": UC_TAYLOR},
                }}}},
            }},
            "metadata": {"contentMetadataViewModel": {
                "metadataRows": [{"metadataParts": row} for row in rows],
                "delimiter": " ",
            }},
        }},
        "contentId": video_id,
        "contentType": content_type,
        "rendererContext": {"commandContext": {"onTap": {"innertubeCommand": watch_endpoint(video_id, url)}}},
    }


def station_lockup():
    return {
        "contentImage": {"collectionThumbnailViewModel": {"primaryThumbnail": {"thumbnailViewModel": {
            "image": {"sources": [{"url": f"https://i9.ytimg.com/s_p/{STATION_ID}/mqdefault.jpg", "width": 180}]},
        }}}},
        "metadata": {"lockupMetadataViewModel": {"title": {"content": "RELEASED"}}},
        "contentId": STATION_ID,
        "contentType": "LOCKUP_CONTENT_TYPE_STATION",
    }


def rich_shelf(title, *items, **extra):
    """A ``richSectionRenderer`` shelf of ``(renderer key, renderer)`` pairs."""
    shelf = {"title": {"simpleText": title},
             "contents": [{"richItemRenderer": {"content": {key: renderer}}} for key, renderer in items],
             **extra}
    return {"richSectionRenderer": {"content": {"richShelfRenderer": shelf}}}


def browse_page(*sections):
    return {"contents": {"twoColumnBrowseResultsRenderer": {"tabs": [
        {"tabRenderer": {"selected": True, "content": {"richGridRenderer": {"contents": list(sections)}}}},
        {"tabRenderer": {"title": "Posts"}},
    ]}}}


def gaming_page(*renderers):
    """Gaming: ``shelfRenderer`` → ``horizontalListRenderer`` of ``gridVideoRenderer``, plus game cards."""
    return {"contents": {"twoColumnBrowseResultsRenderer": {"tabs": [{"tabRenderer": {"content": {
        "sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [{"shelfRenderer": {
                "title": runs("Featured"),
                "content": {"horizontalListRenderer": {"items": [{"gridVideoRenderer": r} for r in renderers]}},
            }}]}},
            {"itemSectionRenderer": {"contents": [{"horizontalCardListRenderer": {"cards": [
                {"gameCardRenderer": {"game": {"gameDetailsRenderer": {"title": {"simpleText": "League of Legends"}}}}},
            ]}}]}},
        ]}}}}]}}}


def watch_page(*contents):
    return {"contents": {"twoColumnWatchNextResults": {
        "results": {"results": {"contents": []}},
        "secondaryResults": {"secondaryResults": {"results": [
            {"itemSectionRenderer": {"contents": list(contents)}},
        ]}},
    }}}


def html(data):
    return ('<!DOCTYPE html><html><head><script nonce="n">var ytInitialData = '
            f"{json.dumps(data)};</script><script>var ytInitialPlayerResponse = {{}};</script></head></html>")


# --- Field parsers ------------------------------------------------------------

@pytest.mark.parametrize("text, expected", [
    ("0:59", 59), ("12:34", 754), ("1:02:03", 3723), (" 3:23 ", 203),
    ("LIVE", None), ("SHORTS", None), ("", None), ("0:00", None), ("1:2:3:4", None), (None, None),
])
def test_parse_duration(text, expected):
    assert yp.parse_duration(text) == expected


@pytest.mark.parametrize("text, expected", [
    ("1,879,379 views", 1_879_379), ("1 view", 1), ("No views", 0), ("1.2M views", 1_200_000),
    ("231M", 231_000_000), ("231 million views", 231_000_000), ("12K views", 12_000),
    ("3.8 billion views", 3_800_000_000), ("115 thousand views", 115_000),
    ("17,363 watching", None), ("7 waiting", None), ("Recommended", None), (None, None),
])
def test_parse_view_count(text, expected):
    assert yp.parse_view_count(text) == expected


# --- Item renderers -----------------------------------------------------------

def test_video_renderer():
    item = yp.normalize_item("videoRenderer", video_renderer("NEpIPcZRi2g"))
    assert item is not None
    assert item.id == "NEpIPcZRi2g" and item.title == "Bombshell report rocks Alaska Senate race"
    assert item.channel.ref == UC_FOX and item.channel.handle == "@foxsports" and item.channel.name == "FOX Sports"
    assert item.channel.avatar_url == AVATAR
    assert item.duration_seconds == 754
    assert item.thumbnail_url.endswith("sqp=small")  # 360 px is closer to the 480 px card target
    assert item.view_count == 1234 and item.published_text == "2 hours ago"
    assert item.live_status is None and item.available


def test_grid_video_renderer_with_collaborators():
    """Gaming page: no lengthText (duration from the overlay), collab byline opens a dialog."""
    renderer = video_renderer("KgpEXSL_vlg", "NoPixel NEWS EP. 7", length=None, overlay=("DEFAULT", "10:25"),
                              views="62,623 views", published="2d ago", ownerText=None)
    del renderer["channelThumbnailSupportedRenderers"]
    renderer["shortBylineText"] = {"runs": [{"text": "Buddha GTARP and KYRSP33DY", "navigationEndpoint": {
        "showDialogCommand": {"panelLoadingStrategy": {"inlineContent": {"dialogViewModel": {"customContent": {
            "listViewModel": {"listItems": [{"listItemViewModel": {
                "title": {"content": "Buddha GTARP"},
                "leadingAccessory": {"avatarViewModel": {"image": {"sources": [{"url": AVATAR}]}}},
                "rendererContext": {"commandContext": {"onTap": {"innertubeCommand": {
                    "browseEndpoint": {"browseId": UC_BUDDHA}}}}},
            }}]}}}}}}}}]}
    item = yp.normalize_item("gridVideoRenderer", renderer)
    assert item.duration_seconds == 625
    assert item.channel.name == "Buddha GTARP and KYRSP33DY" and item.channel.ref == UC_BUDDHA
    assert item.channel.handle is None
    assert item.view_count == 62_623 and item.published_text == "2d ago"


def test_compact_video_renderer():
    """The older related-videos card: simpleText title, longBylineText, channelThumbnail."""
    renderer = {
        "videoId": "Y-rmzh0PI3c",
        "title": {"simpleText": "Cosmos Laundromat - First Cycle"},
        "longBylineText": channel_link("Blender", "UCSMOQeBJ2RAnuFungnQOxLg", "/@BlenderOfficial"),
        "lengthText": {"simpleText": "12:11"},
        "viewCountText": {"simpleText": "No views"},
        "publishedTimeText": {"simpleText": "11 years ago"},
        "channelThumbnail": {"thumbnails": [{"url": "//yt3.ggpht.com/blender=s88"}]},
        "thumbnail": {"thumbnails": [{"url": "https://i.ytimg.com/vi/Y-rmzh0PI3c/hqdefault.jpg"}]},
    }
    item = yp.normalize_item("compactVideoRenderer", renderer)
    assert item.channel.ref == "UCSMOQeBJ2RAnuFungnQOxLg" and item.channel.handle == "@BlenderOfficial"
    assert item.channel.avatar_url == "https://yt3.ggpht.com/blender=s88"
    assert item.duration_seconds == 731 and item.view_count == 0


def test_lockup_video():
    item = yp.normalize_item("lockupViewModel", lockup("Jb2stN7kH28"))
    assert item.id == "Jb2stN7kH28" and item.title == "Taylor Swift - Our Song"
    assert item.channel.ref == UC_TAYLOR and item.channel.name == "Taylor Swift"
    assert item.channel.avatar_url == AVATAR_TAYLOR
    assert item.duration_seconds == 203
    assert item.view_count == 231_000_000 and item.published_text == "17 years ago"
    assert item.thumbnail_url == "https://i.ytimg.com/vi/Jb2stN7kH28/hqdefault.jpg?sqp=x"
    assert item.live_status is None


def test_lockup_collaboration_uses_avatar_stack_endpoint():
    renderer = lockup("F1z5E5gzlLA", rows=[
        [part("PBS KIDS"), part("and Wild Kratts")],
        [part("1.6M", label="1.6 million views"), part("6y ago", label="6 years ago")],
    ])
    renderer["metadata"]["lockupMetadataViewModel"]["image"] = {"avatarStackViewModel": {
        "avatars": [{"avatarViewModel": {"image": {"sources": [{"url": AVATAR}]}}}],
        "rendererContext": {"commandContext": {"onTap": {"innertubeCommand": {"showDialogCommand": {
            "listItems": [{"rendererContext": {"commandContext": {"onTap": {"innertubeCommand": {
                "browseEndpoint": {"browseId": UC_FOX}}}}}}]}}}}},
    }}
    item = yp.normalize_item("lockupViewModel", renderer)
    assert item.channel.name == "PBS KIDS" and item.channel.ref == UC_FOX and item.channel.avatar_url == AVATAR
    assert item.view_count == 1_600_000


@pytest.mark.parametrize("renderer", [
    station_lockup(),
    lockup("PL4fGSI1pDJn6O1LS0XSdF3RyO0Rq_LDeI", content_type="LOCKUP_CONTENT_TYPE_PLAYLIST"),
    {**lockup("Jb2stN7kH28"), "contentType": None},
])
def test_lockup_non_videos_are_skipped(renderer):
    assert yp.normalize_item("lockupViewModel", renderer) is None


def test_live_status_detection():
    def status(key, renderer):
        return yp.normalize_item(key, renderer).live_status

    assert status("videoRenderer", live_renderer("pGXdGaGgKcA")) == "is_live"
    badge_only = video_renderer("pGXdGaGgKcA", badges=[{"metadataBadgeRenderer": {
        "style": "BADGE_STYLE_TYPE_LIVE_NOW", "label": "LIVE"}}])
    assert status("videoRenderer", badge_only) == "is_live"
    assert status("videoRenderer", upcoming_renderer("GvWSyescLv8")) == "is_upcoming"
    premiere = video_renderer("GvWSyescLv8", length=None, views=None, published="Premieres 10/30/26, 6:00 PM")
    assert status("videoRenderer", premiere) == "is_upcoming"

    streamed = yp.normalize_item("videoRenderer", streamed_renderer("9OPoiRcze0w"))
    assert streamed.live_status == "was_live" and streamed.duration_seconds == 7005
    assert streamed.published_text == "Streamed 9h ago" and streamed.view_count == 836_450

    live_lockup = lockup("hzpuL0g_E7E", badge="LIVE", badge_style="THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE",
                         rows=[[part("LoL Esports")], [part("133K watching")]])
    assert status("lockupViewModel", live_lockup) == "is_live"
    streamed_lockup = lockup("efzxdQeODpU", badge="1:12:11", rows=[
        [part("DAZN Football")], [part("21M", label="21 million views"), part("Streamed 2 days ago")]])
    item = yp.normalize_item("lockupViewModel", streamed_lockup)
    assert item.live_status == "was_live" and item.published_text == "Streamed 2 days ago"
    assert item.view_count == 21_000_000 and item.channel.name == "DAZN Football"


@pytest.mark.parametrize("key, renderer", [
    ("videoRenderer", video_renderer("abcdefghijk", overlay=("SHORTS", "SHORTS"), length=None)),
    ("videoRenderer", video_renderer("abcdefghijk", navigationEndpoint={"reelWatchEndpoint": {"videoId": "x"}})),
    ("videoRenderer", video_renderer("abcdefghijk", navigationEndpoint=watch_endpoint("x", "/shorts/abcdefghijk"))),
    ("lockupViewModel", lockup("abcdefghijk", url="/shorts/abcdefghijk")),
    ("lockupViewModel", lockup("abcdefghijk", badge="SHORTS")),
    ("videoRenderer", video_renderer("abcdefghijk", badges=[{"metadataBadgeRenderer": {
        "style": "BADGE_STYLE_TYPE_MEMBERS_ONLY", "label": "Members only"}}])),
])
def test_shorts_and_members_only_are_skipped(key, renderer):
    assert yp.normalize_item(key, renderer) is None


def test_missing_fields_degrade_gracefully():
    item = yp.normalize_item("videoRenderer", {"videoId": "dQw4w9WgXcQ"})
    assert item.title == "Untitled video"
    assert item.channel is None and item.duration_seconds is None and item.view_count is None
    assert item.published_text is None and item.live_status is None
    assert item.thumbnail_url == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"

    bare = yp.normalize_item("lockupViewModel", {"contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
                                                 "contentId": "dQw4w9WgXcQ"})
    assert bare.title == "Untitled video" and bare.channel is None

    assert yp.normalize_item("videoRenderer", {"videoId": "not-an-id"}) is None
    assert yp.normalize_item("videoRenderer", {"videoId": "dQw4w9WgXcQ", "title": 42}).title == "Untitled video"
    assert yp.normalize_item("videoRenderer", ["not", "a", "dict"]) is None
    assert yp.normalize_item("postRenderer", {"postId": "x"}) is None
    # Unsafe thumbnail and avatar hosts are dropped.
    odd = video_renderer("dQw4w9WgXcQ", thumbnail={"thumbnails": [{"url": "https://evil.example/x.jpg"}]},
                         channelThumbnailSupportedRenderers={"thumbnail": {"thumbnails": [{"url": "http://x"}]}})
    item = yp.normalize_item("videoRenderer", odd)
    assert item.thumbnail_url == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
    assert item.channel.avatar_url is None


def test_new_fields_default_to_none_for_ytdlp_entries():
    item = normalize_entry({"id": "dQw4w9WgXcQ", "channel_id": UC_FOX, "channel": "FOX Sports"})
    assert item.published_text is None and item.channel.avatar_url is None


# --- Pages --------------------------------------------------------------------

def test_live_page_keeps_only_finished_streams():
    data = browse_page(
        {"richSectionRenderer": {"content": {"carouselItemRenderer": {"carouselItems": [
            {"defaultPromoPanelRenderer": {"title": {"simpleText": "Promo"}}}]}}}},
        rich_shelf("Live Now", ("videoRenderer", live_renderer("pGXdGaGgKcA")),
                   ("videoRenderer", live_renderer("mCG3bBjEYRY"))),
        rich_shelf("Recent Live Streams", ("videoRenderer", streamed_renderer("yb7vFbBQCXQ")),
                   ("videoRenderer", streamed_renderer("9OPoiRcze0w")),
                   ("videoRenderer", streamed_renderer("yb7vFbBQCXQ"))),  # duplicate
        rich_shelf("Upcoming Live Streams", ("videoRenderer", upcoming_renderer("GvWSyescLv8"))),
    )
    shelves = yp.parse_shelves(data)
    assert [shelf.title for shelf in shelves] == ["Recent Live Streams"]
    assert [item.id for item in shelves[0].items] == ["yb7vFbBQCXQ", "9OPoiRcze0w"]
    assert all(item.live_status == "was_live" for item in shelves[0].items)


def test_music_and_news_pages_drop_non_videos_and_empty_shelves():
    data = browse_page(
        rich_shelf("New & Trending Songs", ("lockupViewModel", station_lockup())),
        rich_shelf("New This Week", ("lockupViewModel", lockup("Xw9KWCg_tEw")),
                   ("lockupViewModel", station_lockup()), ("lockupViewModel", lockup("j8Xmnt8YESo"))),
        rich_shelf("Latest news posts", ("postRenderer", {"postId": "Ugkx"})),
        rich_shelf("News about Ohio", ("videoRenderer", video_renderer("flDKproelJ0")),
                   ("videoRenderer", live_renderer("WZEXvZcVAbE"))),
        rich_shelf("Shorts", ("videoRenderer", video_renderer("abcdefghijk")), isShorts=True),
        {"richSectionRenderer": {"content": {"reelShelfRenderer": {"items": [
            {"videoRenderer": video_renderer("abcdefghijk")}]}}}},
    )
    shelves = yp.parse_shelves(data)
    assert [(shelf.title, [item.id for item in shelf.items]) for shelf in shelves] == [
        ("New This Week", ["Xw9KWCg_tEw", "j8Xmnt8YESo"]),
        ("News about Ohio", ["flDKproelJ0"]),
    ]


def test_gaming_page_shape():
    data = gaming_page(video_renderer("KgpEXSL_vlg", length=None, overlay=("DEFAULT", "10:25")),
                       video_renderer("xxeNaxrfRVs", length=None, overlay=("DEFAULT", "21:54")))
    shelves = yp.parse_shelves(data)
    assert len(shelves) == 1 and shelves[0].title == "Featured"
    assert [item.duration_seconds for item in shelves[0].items] == [625, 1314]


def test_shelf_title_falls_back_to_header():
    section = {"richShelfRenderer": {
        "header": {"sectionHeaderViewModel": {"headline": {"content": "Top stories"}}},
        "contents": [{"richItemRenderer": {"content": {"videoRenderer": video_renderer("NEpIPcZRi2g")}}}],
    }}
    assert [shelf.title for shelf in yp.parse_shelves({"contents": [section]})] == ["Top stories"]
    untitled = {"shelfRenderer": {"content": {"items": [{"videoRenderer": video_renderer("NEpIPcZRi2g")}]}}}
    assert yp.parse_shelves({"contents": [untitled]})[0].title is None


def test_page_without_shelves_parses_to_nothing():
    assert yp.parse_shelves({"contents": {"twoColumnBrowseResultsRenderer": {"tabs": []}}}) == []
    assert yp.parse_shelves({}) == []


def test_related_videos():
    data = watch_page(
        {"reelShelfRenderer": {"items": [{"shortsLockupViewModel": {"entityId": "shorts-shelf-item"}},
                                         {"videoRenderer": video_renderer("abcdefghijk")}]}},
        {"lockupViewModel": lockup("AdNZFbBB1_4")},
        {"lockupViewModel": lockup("aqz-KE-bpKQ")},  # the video itself
        {"lockupViewModel": lockup("PL4fGSI1pDJn6O1LS0XSdF3RyO0Rq_LDeI",
                                   content_type="LOCKUP_CONTENT_TYPE_PLAYLIST")},
        {"compactVideoRenderer": video_renderer("xOXolSQcEb4")},
        {"lockupViewModel": lockup("AdNZFbBB1_4")},  # duplicate
        {"lockupViewModel": lockup("hzpuL0g_E7E", badge="LIVE")},
        {"continuationItemRenderer": {"trigger": "CONTINUATION_TRIGGER_ON_ITEM_SHOWN"}},
    )
    items = yp.parse_related(data, "aqz-KE-bpKQ")
    assert [item.id for item in items] == ["AdNZFbBB1_4", "xOXolSQcEb4"]
    assert yp.parse_related({"contents": {"twoColumnWatchNextResults": {}}}, "aqz-KE-bpKQ") == []


def test_extract_initial_data():
    data = browse_page(rich_shelf("Tricky };</script> title", ("videoRenderer", video_renderer("NEpIPcZRi2g"))))
    assert yp.extract_initial_data(html(data)) == data
    alt = f'<script>window["ytInitialData"] = {json.dumps({"a": [1, 2]})};</script>'
    assert yp.extract_initial_data(alt) == {"a": [1, 2]}
    assert yp.extract_initial_data("<html><body>No data here</body></html>") is None
    assert yp.extract_initial_data("<script>var ytInitialData = {\"broken\": ;</script>") is None
    assert yp.extract_initial_data("<script>var ytInitialData = [1, 2];</script>") is None


# --- Fetching -----------------------------------------------------------------

def test_request_is_browser_like_without_cookies():
    request = yp.build_request(yp.FEEDS["music"].url)
    headers = {key.lower(): value for key, value in request.header_items()}
    assert headers["user-agent"].startswith("Mozilla/5.0")
    assert headers["accept-language"].startswith("en-US")
    assert "cookie" not in headers and "authorization" not in headers
    assert all(source.url.startswith("https://www.youtube.com/") for source in yp.FEEDS.values())


@pytest.mark.anyio
@pytest.mark.parametrize("error, code, retryable", [
    (urllib.error.HTTPError("u", 429, "Too Many Requests", {}, None), "rate_limited", True),
    (urllib.error.HTTPError("u", 500, "Server Error", {}, None), "network_error", True),
    (urllib.error.URLError(TimeoutError("timed out")), "timeout", True),
    (TimeoutError("timed out"), "timeout", True),
    (urllib.error.URLError("Name or service not known"), "network_error", True),
    (ConnectionResetError("reset"), "network_error", True),
])
async def test_fetch_errors_become_app_errors(monkeypatch, error, code, retryable):
    def fail(url, timeout):
        raise error

    monkeypatch.setattr(yp, "_download", fail)
    with pytest.raises(AppError) as info:
        await yp.fetch_html(yp.FEEDS["news"].url, timeout=5)
    assert info.value.code == code and info.value.retryable is retryable


@pytest.mark.anyio
@pytest.mark.parametrize("final_url, retryable", [
    ("https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com", False),
    ("https://www.google.com/sorry/index?continue=x", True),
])
async def test_redirect_away_from_youtube_is_blocked(monkeypatch, final_url, retryable):
    monkeypatch.setattr(yp, "_download", lambda url, timeout: (final_url, "<html></html>"))
    with pytest.raises(AppError) as info:
        await yp.fetch_html(yp.FEEDS["news"].url, timeout=5)
    assert info.value.code == "youtube_blocked" and info.value.retryable is retryable


# --- API ----------------------------------------------------------------------

LIVE_PAGE = browse_page(
    rich_shelf("Live Now", ("videoRenderer", live_renderer("pGXdGaGgKcA"))),
    rich_shelf("Recent Live Streams", ("videoRenderer", streamed_renderer("yb7vFbBQCXQ"))),
)
WATCH_PAGE = watch_page({"lockupViewModel": lockup("AdNZFbBB1_4")}, {"lockupViewModel": lockup("aqz-KE-bpKQ")})


class FakePages:
    """Stands in for :func:`youtube_pages.fetch_html`; maps URLs to HTML or exceptions."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.responses: dict[str, object] = {
            yp.FEEDS["live"].url: html(LIVE_PAGE),
            yp.FEEDS["music"].url: html(browse_page()),
            "https://www.youtube.com/watch?v=aqz-KE-bpKQ": html(WATCH_PAGE),
        }

    async def __call__(self, url: str, *, timeout: float) -> str:
        self.calls.append(url)
        response = self.responses.get(url, AppError("network_error", "Could not reach YouTube.", status=502,
                                                    retryable=True))
        if isinstance(response, Exception):
            raise response
        return response


@pytest.fixture
def pages(monkeypatch):
    fake = FakePages()
    monkeypatch.setattr(yp, "fetch_html", fake)
    return fake


@pytest.fixture
def client(settings, pages):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_feed_list(client):
    assert client.get("/api/feeds").json() == {"feeds": [
        {"id": "music", "title": "Music"}, {"id": "news", "title": "News"},
        {"id": "live", "title": "Live"}, {"id": "gaming", "title": "Gaming"},
    ]}
    assert client.get("/api/health").json()["feeds_enabled"] is True


def test_feed_endpoint_shape_and_cache(client, pages):
    first = client.get("/api/feeds/live")
    assert first.status_code == 200
    body = first.json()
    assert set(body) == {"id", "title", "shelves", "provider", "cached"}
    assert body["id"] == "live" and body["provider"] == "youtube-pages" and body["cached"] is False
    assert [shelf["title"] for shelf in body["shelves"]] == ["Recent Live Streams"]
    item = body["shelves"][0]["items"][0]
    assert item["id"] == "yb7vFbBQCXQ" and item["live_status"] == "was_live"
    assert item["published_text"] == "Streamed 9h ago" and item["channel"]["avatar_url"] == AVATAR

    second = client.get("/api/feeds/live").json()
    assert second["cached"] is True and second["shelves"] == body["shelves"]
    assert pages.calls == [yp.FEEDS["live"].url]


def test_unknown_feed_is_not_found(client, pages):
    response = client.get("/api/feeds/trending")
    assert response.status_code == 404 and response.json()["error"]["code"] == "not_found"
    assert pages.calls == []


def test_page_that_parses_but_has_no_videos_is_empty(client):
    response = client.get("/api/feeds/music")
    assert response.status_code == 200 and response.json()["shelves"] == []


def test_fetch_and_parse_failures(client, pages):
    failed = client.get("/api/feeds/news")
    assert failed.status_code == 502
    assert failed.json()["error"]["code"] == "network_error" and failed.json()["error"]["retryable"] is True
    assert client.get("/api/feeds/news").status_code == 502
    assert len(pages.calls) == 2  # failures are not cached

    pages.responses[yp.FEEDS["gaming"].url] = "<html><body>Something else entirely</body></html>"
    unreadable = client.get("/api/feeds/gaming")
    assert unreadable.status_code == 502
    assert unreadable.json()["error"]["code"] == "extraction_failed" and unreadable.json()["error"]["retryable"]


def test_related_endpoint(client, pages):
    assert client.get("/api/related/not-an-id").status_code == 400
    assert pages.calls == []
    first = client.get("/api/related/aqz-KE-bpKQ").json()
    assert first["video_id"] == "aqz-KE-bpKQ" and first["provider"] == "youtube-pages"
    assert [item["id"] for item in first["items"]] == ["AdNZFbBB1_4"]
    assert first["items"][0]["channel"]["ref"] == UC_TAYLOR
    assert client.get("/api/related/aqz-KE-bpKQ").json()["cached"] is True
    assert pages.calls == ["https://www.youtube.com/watch?v=aqz-KE-bpKQ"]


def test_feeds_can_be_disabled(settings, pages):
    with TestClient(create_app(with_settings(settings, enable_feeds=False))) as client:
        assert client.get("/api/feeds").json() == {"feeds": []}
        assert client.get("/api/feeds/music").status_code == 404
        assert client.get("/api/related/aqz-KE-bpKQ").status_code == 404
        assert client.get("/api/health").json()["feeds_enabled"] is False
    assert pages.calls == []

from app.discovery.normalize import clean_channel_title, normalize_entries, normalize_entry, pick_thumbnail
from app.models import ChannelInfo

UC = "UCSMOQeBJ2RAnuFungnQOxLg"

# Shapes taken from real yt-dlp 2026.10.26 flat output.
SEARCH_ENTRY = {
    "_type": "url",
    "ie_key": "Youtube",
    "id": "aqz-KE-bpKQ",
    "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    "title": "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film",
    "duration": 635,
    "channel_id": UC,
    "channel": "Blender",
    "uploader_id": "@BlenderOfficial",
    "thumbnails": [
        {"url": "https://i.ytimg.com/vi/aqz-KE-bpKQ/hq720.jpg?sqp=a", "height": 202, "width": 360},
        {"url": "https://i.ytimg.com/vi/aqz-KE-bpKQ/hq720.jpg?sqp=b", "height": 404, "width": 720},
    ],
    "view_count": 23480863,
    "live_status": None,
}

CHANNEL_TAB_ENTRY = {
    "_type": "url",
    "ie_key": "Youtube",
    "id": "dVrELpmfcEQ",
    "title": "Blender Education Community Meeting",
    "duration": 7482.0,
    "channel_url": None,
    "uploader_url": None,
    "thumbnails": [],
}


def test_full_search_entry():
    item = normalize_entry(SEARCH_ENTRY)
    assert item is not None
    assert item.id == "aqz-KE-bpKQ"
    assert item.duration_seconds == 635
    assert item.channel.ref == UC and item.channel.handle == "@BlenderOfficial" and item.channel.name == "Blender"
    assert item.thumbnail_url.endswith("sqp=a")  # 360 is closer to the 480px target than 720
    assert item.available and item.view_count == 23480863


def test_missing_fields_degrade_gracefully():
    item = normalize_entry({"id": "dQw4w9WgXcQ"})
    assert item is not None
    assert item.title == "Untitled video"
    assert item.duration_seconds is None
    assert item.channel is None
    assert item.view_count is None
    # Canonical thumbnail derived from the validated ID.
    assert item.thumbnail_url == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"


def test_channel_tab_entries_inherit_page_channel():
    page_channel = ChannelInfo(ref=UC, id=UC, handle="@BlenderOfficial", name="Blender")
    item = normalize_entry(CHANNEL_TAB_ENTRY, channel_fallback=page_channel)
    assert item.channel == page_channel
    assert item.duration_seconds == 7482


def test_odd_values():
    item = normalize_entry({
        "id": "dQw4w9WgXcQ",
        "title": "  spaced \n title ",
        "duration": "12.6",
        "view_count": -5,
        "thumbnails": [{"url": "http://insecure.example/x.jpg"}, {"url": "https://evil.example/x.jpg"}, "junk"],
        "thumbnail": "//i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
        "is_live": True,
    })
    assert item.title == "spaced title"
    assert item.duration_seconds == 13
    assert item.view_count is None
    assert item.thumbnail_url == "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
    assert item.live_status == "is_live"


def test_unavailable_entries_are_marked_not_dropped():
    private = normalize_entry({"id": "dQw4w9WgXcQ", "title": "[Private video]"})
    deleted = normalize_entry({"id": "aqz-KE-bpKQ", "title": "[Deleted video]"})
    members = normalize_entry({"id": "WhWc3b3KhnY", "title": "Bonus", "availability": "subscriber_only"})
    assert (private.available, private.title, private.unavailable_reason) == (False, "Private video", "Private video")
    assert deleted.available is False
    assert members.available is False and members.title == "Bonus"


def test_non_video_entries_are_skipped_and_duplicates_removed():
    entries = [
        SEARCH_ENTRY,
        {"_type": "url", "ie_key": "YoutubeTab", "id": UC, "title": "A channel"},
        {"_type": "playlist", "id": "PLxxxxxxxxxxxxxx"},
        {"id": "not-an-id"},
        None,
        SEARCH_ENTRY,
    ]
    items = normalize_entries(entries)
    assert [i.id for i in items] == ["aqz-KE-bpKQ"]
    assert normalize_entries(None) == []


def test_thumbnail_without_id_or_candidates():
    assert pick_thumbnail({}) is None


def test_channel_title_cleanup():
    assert clean_channel_title("Blender - Videos") == "Blender"
    assert clean_channel_title("Playlist name") == "Playlist name"
    assert clean_channel_title(None) is None

import pytest

from app.errors import AppError
from app.validation import (
    channel_url,
    clean_query,
    parse_input,
    parse_timestamp,
    playlist_url,
    validate_channel_ref,
    validate_playlist_id,
    validate_video_id,
    watch_url,
)

VID = "dQw4w9WgXcQ"
PL = "PLa1F2ddGya_-UvuAqHAksYnB0qL9yWDO6"
UC = "UCSMOQeBJ2RAnuFungnQOxLg"


@pytest.mark.parametrize("value", [VID, "aqz-KE-bpKQ", "___________", "-----------"])
def test_valid_video_ids(value):
    assert validate_video_id(value) == value


@pytest.mark.parametrize("value", ["", "short", "dQw4w9WgXcQx", "dQw4w9WgXc!", "dQw4w9WgXc ", "../../etc/pa", None])
def test_invalid_video_ids(value):
    with pytest.raises(AppError) as exc:
        validate_video_id(value)
    assert exc.value.code == "invalid_input"


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/watch?v={VID}",
        f"http://youtube.com/watch?v={VID}&feature=share",
        f"https://m.youtube.com/watch?app=desktop&v={VID}",
        f"https://music.youtube.com/watch?v={VID}",
        f"youtube.com/watch?v={VID}",
        f"https://youtu.be/{VID}",
        f"youtu.be/{VID}?si=abc",
        f"https://www.youtube.com/shorts/{VID}",
        f"https://www.youtube.com/embed/{VID}?start=3",
        f"https://www.youtube-nocookie.com/embed/{VID}",
        f"https://www.youtube.com/live/{VID}",
        f"https://www.youtube.com/v/{VID}",
        f"  https://www.youtube.com/watch?v={VID}  ",
    ],
)
def test_video_urls(url):
    parsed = parse_input(url)
    assert parsed.kind == "video"
    assert parsed.video_id == VID


def test_video_url_with_playlist_and_timestamp():
    parsed = parse_input(f"https://www.youtube.com/watch?v={VID}&list={PL}&t=1m30s")
    assert (parsed.kind, parsed.video_id, parsed.playlist_id, parsed.start_seconds) == ("video", VID, PL, 90)


def test_mix_list_is_dropped_from_video_url():
    parsed = parse_input(f"https://www.youtube.com/watch?v={VID}&list=RD{VID}")
    assert parsed.kind == "video"
    assert parsed.playlist_id is None


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/playlist?list={PL}",
        f"https://m.youtube.com/playlist?list={PL}&si=x",
        f"https://www.youtube.com/watch?list={PL}",
    ],
)
def test_playlist_urls(url):
    parsed = parse_input(url)
    assert parsed.kind == "playlist"
    assert parsed.playlist_id == PL


@pytest.mark.parametrize(
    "url, ref",
    [
        (f"https://www.youtube.com/channel/{UC}", UC),
        (f"https://www.youtube.com/channel/{UC}/videos", UC),
        ("https://www.youtube.com/@BlenderOfficial", "@BlenderOfficial"),
        ("https://www.youtube.com/@BlenderOfficial/featured", "@BlenderOfficial"),
        ("youtube.com/@some.creator-1", "@some.creator-1"),
        ("https://www.youtube.com/c/Blender", "c/Blender"),
        ("https://www.youtube.com/user/BlenderFoundation", "user/BlenderFoundation"),
        ("@BlenderOfficial", "@BlenderOfficial"),
        ("https://www.youtube.com/@%E3%83%86%E3%82%B9%E3%83%88", "@テスト"),
    ],
)
def test_channel_urls(url, ref):
    parsed = parse_input(url)
    assert parsed.kind == "channel"
    assert parsed.channel_ref == ref


def test_search_url_and_keywords():
    assert parse_input("https://www.youtube.com/results?search_query=lofi+beats").query == "lofi beats"
    parsed = parse_input("  blender   open\tmovie ")
    assert parsed.kind == "search" and parsed.query == "blender open movie"
    # An 11-character word must stay a keyword search, not become a video ID.
    assert parse_input("programming").kind == "search"


@pytest.mark.parametrize(
    "value, code_hint",
    [
        ("https://evil.example.com/watch?v=dQw4w9WgXcQ", "Only YouTube"),
        ("https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ", "Only YouTube"),
        ("javascript://youtube.com/watch?v=dQw4w9WgXcQ", "http"),
        ("ftp://youtube.com/watch?v=dQw4w9WgXcQ", "http"),
        ("https://user:pw@youtube.com/watch?v=dQw4w9WgXcQ", "not a supported"),
        ("https://youtube.com:8443/watch?v=dQw4w9WgXcQ", "not a supported"),
        ("https://www.youtube.com/watch?v=bad", "valid video ID"),
        ("https://youtu.be/", "valid video ID"),
        ("https://www.youtube.com/feed/subscriptions", "not supported"),
        ("https://www.youtube.com/@BlenderOfficial/membership", "not supported"),
        ("https://www.youtube.com/playlist?list=WL", "playlist"),
        ("", "Enter"),
        ("x" * 501, "limited"),
    ],
)
def test_rejected_inputs(value, code_hint):
    with pytest.raises(AppError) as exc:
        parse_input(value)
    assert exc.value.code == "invalid_input"
    assert code_hint.lower() in exc.value.message.lower()


def test_rejects_personal_and_generated_playlists():
    for value in ("RDdQw4w9WgXcQ", "WLxxxxxxxxxxxx", "LLxxxxxxxxxxxx"):
        with pytest.raises(AppError):
            validate_playlist_id(value)


def test_channel_ref_validation():
    assert validate_channel_ref(UC) == UC
    for bad in ("UCshort", "@a", "@" + "x" * 31, "c/", "user/bad name", "notaref", "../etc"):
        with pytest.raises(AppError):
            validate_channel_ref(bad)


def test_canonical_urls_are_rebuilt_from_ids():
    assert watch_url(VID) == f"https://www.youtube.com/watch?v={VID}"
    assert playlist_url(PL) == f"https://www.youtube.com/playlist?list={PL}"
    assert channel_url(UC) == f"https://www.youtube.com/channel/{UC}/videos"
    assert channel_url("@Blender") == "https://www.youtube.com/@Blender/videos"
    assert channel_url("c/Some.Name") == "https://www.youtube.com/c/Some.Name/videos"
    assert channel_url("@テスト").startswith("https://www.youtube.com/@%E3%83%86")


def test_query_cleaning():
    assert clean_query("a\x00b​c  d") == "abc d"
    with pytest.raises(AppError):
        clean_query("   ")
    with pytest.raises(AppError):
        clean_query("q" * 201)


@pytest.mark.parametrize("value, seconds", [("90", 90), ("90s", 90), ("1m30s", 90), ("1h2m3s", 3723), ("", None),
                                            ("abc", None), (None, None)])
def test_timestamps(value, seconds):
    assert parse_timestamp(value) == seconds

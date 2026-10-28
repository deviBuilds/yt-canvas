import pytest

from app.media.formats import audio_family, select_formats, video_family


def v(fid, vcodec, height, size=None, fps=30, protocol="https", **extra):
    return {"format_id": fid, "vcodec": vcodec, "acodec": "none", "height": height, "fps": fps,
            "filesize": size, "protocol": protocol, "url": "https://example.invalid/x", **extra}


def a(fid, acodec, abr, size=None, channels=2, **extra):
    return {"format_id": fid, "vcodec": "none", "acodec": acodec, "abr": abr, "filesize": size,
            "audio_channels": channels, "protocol": "https", "url": "https://example.invalid/x", **extra}


def m(fid, vcodec, acodec, height, size=None):
    return {"format_id": fid, "vcodec": vcodec, "acodec": acodec, "height": height, "filesize": size,
            "protocol": "https", "url": "https://example.invalid/x"}


YOUTUBE_LIKE = [
    {"format_id": "sb0", "ext": "mhtml", "vcodec": "none", "acodec": "none", "protocol": "mhtml",
     "format_note": "storyboard", "url": "x"},
    a("139", "mp4a.40.5", 48, 3_000_000),
    a("140", "mp4a.40.2", 129, 10_000_000),
    a("140-drc", "mp4a.40.2", 129, 10_000_000, format_note="medium, DRC"),
    a("251", "opus", 128, 10_000_000),
    a("258", "mp4a.40.2", 387, 30_000_000, channels=6),
    v("134", "avc1.4D401E", 360, 18_000_000),
    v("136", "avc1.4D401F", 720, 87_000_000),
    v("298", "avc1.4D4020", 720, 150_000_000, fps=60),
    v("247", "vp9", 720, 56_000_000),
    v("399", "av01.0.09M.08", 1080, 124_000_000, fps=60),
    v("299", "avc1.64002A", 1080, 257_000_000, fps=60),
    m("18", "avc1.42001E", "mp4a.40.2", 360, 28_000_000),
]


def test_prefers_h264_and_stereo_aac_up_to_max_height():
    choice = select_formats(YOUTUBE_LIKE, max_height=720)
    assert choice.format_ids == ["298", "140"]
    assert choice.strategy == "remux"
    assert choice.height == 720
    assert choice.estimated_bytes == 160_000_000


def test_never_exceeds_max_height():
    choice = select_formats(YOUTUBE_LIKE, max_height=480)
    assert choice.format_ids == ["134", "140"]


def test_falls_back_to_smaller_formats_within_size_limit():
    choice = select_formats(YOUTUBE_LIKE, max_height=720, max_bytes=100_000_000)
    assert choice.format_ids == ["136", "140"]
    choice = select_formats(YOUTUBE_LIKE, max_height=720, max_bytes=30_000_000)
    assert choice.format_ids == ["134", "140"]


def test_raises_when_nothing_fits():
    with pytest.raises(ValueError, match="too_large"):
        select_formats(YOUTUBE_LIKE, max_height=720, max_bytes=1_000_000)


def test_progressive_h264_used_when_no_split_h264_exists():
    formats = [a("251", "opus", 128), v("247", "vp9", 720), m("18", "avc1.42001E", "mp4a.40.2", 360)]
    choice = select_formats(formats, max_height=720)
    assert choice.format_ids == ["18"] and choice.muxed and choice.strategy == "remux"


def test_h264_with_opus_only_transcodes_audio():
    formats = [a("251", "opus", 128), v("136", "avc1.4D401F", 720)]
    choice = select_formats(formats)
    assert choice.format_ids == ["136", "251"]
    assert choice.strategy == "transcode_audio"


def test_vp9_only_needs_transcoding():
    formats = [a("251", "opus", 128), v("247", "vp9", 720), v("399", "av01.0.05M.08", 720)]
    choice = select_formats(formats)
    assert choice.strategy == "transcode"
    assert choice.format_ids[1] == "251"


def test_mp4_extension_does_not_imply_h264():
    formats = [a("140", "mp4a.40.2", 129), {**v("399", "av01.0.08M.08", 720), "ext": "mp4"}]
    choice = select_formats(formats)
    assert choice.copy_video is False


def test_drm_and_unknown_protocols_are_ignored():
    formats = [
        a("140", "mp4a.40.2", 129),
        v("136", "avc1.4D401F", 720, has_drm=True),
        v("135", "avc1.4D401F", 480, protocol="f4m"),
        v("134", "avc1.4D401E", 360),
    ]
    assert select_formats(formats).format_ids == ["134", "140"]


def test_size_estimated_from_bitrate_when_missing():
    formats = [{**a("140", "mp4a.40.2", 128), "tbr": 128}, {**v("136", "avc1.4D401F", 720), "tbr": 1000}]
    choice = select_formats(formats, duration=100)
    assert choice.estimated_bytes == int(1128 * 1000 / 8 * 100)


def test_no_usable_formats():
    assert select_formats([]) is None
    assert select_formats(None) is None
    assert select_formats([v("136", "avc1.4D401F", 720)]) is None  # video without any audio


def test_codec_families():
    assert video_family("avc1.64001F") == "h264"
    assert video_family("vp09.00.10.08") == "vp9"
    assert video_family("hvc1.1.6.L93") == "hevc"
    assert video_family("none") is None
    assert audio_family("mp4a.40.2") == "aac"
    assert audio_family("opus") == "opus"
    assert audio_family("ec-3") == "ac3"
    assert audio_family(None) is None

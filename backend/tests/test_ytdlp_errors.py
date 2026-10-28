import pytest

from app.config import Settings
from app.errors import redact
from app.media.youtube import check_playable
from app.errors import AppError
from app.ytdlp import base_args, classify_error


@pytest.mark.parametrize(
    "stderr, code",
    [
        ("ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "unavailable"),
        ("ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "unavailable"),
        ("ERROR: [youtube] abc: This live event will begin in 3 hours.", "live_unsupported"),
        ("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate", "restricted"),
        ("ERROR: [youtube] abc: Join this channel to get access to members-only content", "restricted"),
        ("ERROR: [youtube] abc: Sign in to confirm you're not a bot.", "youtube_blocked"),
        ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "download_forbidden"),
        ("ERROR: [youtube] abc: HTTP Error 429: Too Many Requests", "rate_limited"),
        ("ERROR: [youtube] abc: Requested format is not available", "no_formats"),
        ("ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure>", "network_error"),
        ("ERROR: [youtube:tab] @nobody: This channel does not exist.", "not_found"),
        ("ERROR: Unsupported URL: https://example.com", "invalid_input"),
        ("ERROR: something entirely new", "extraction_failed"),
    ],
)
def test_classification(stderr, code):
    assert classify_error(stderr).code == code


def test_error_lines_win_over_warnings():
    stderr = ("WARNING: [youtube] No supported JavaScript runtime could be found.\n"
              "ERROR: [youtube] abc: Private video")
    assert classify_error(stderr).code == "unavailable"


def test_warning_only_js_runtime_problem_is_reported():
    stderr = "WARNING: [youtube] abc: n challenge solving failed: Some formats may be missing."
    assert classify_error(stderr).code == "js_runtime_problem"


def test_download_default():
    assert classify_error("ERROR: weird", default_code="download_failed").code == "download_failed"


def test_messages_never_echo_stderr():
    secret = "https://rr1---sn.googlevideo.com/videoplayback?expire=1&sig=SECRET&ip=1.2.3.4"
    error = classify_error(f"ERROR: unable to download {secret}: HTTP Error 403")
    assert "SECRET" not in error.message and "SECRET" not in (error.hint or "")


def test_redaction_strips_signed_query_strings():
    text = ('[debug] Invoking http downloader on "https://rr1---sn.googlevideo.com/videoplayback?'
            'expire=1793241600&ip=fda3::1&sig=AE0s2JYw&lsig=APax"')
    cleaned = redact(text)
    assert "sig=" not in cleaned and "fda3" not in cleaned and "1793241600" not in cleaned
    assert "https://rr1---sn.googlevideo.com/videoplayback?<redacted>" in cleaned


def test_base_args_are_a_fixed_argument_array(tmp_path):
    settings = Settings(data_dir=tmp_path, ytdlp_js_runtimes=("node",))
    args = base_args(settings)
    assert "--ignore-config" in args
    assert args[args.index("--js-runtimes") + 1] == "node"
    assert all(isinstance(arg, str) for arg in args)


@pytest.mark.parametrize(
    "info, code",
    [
        ({"is_live": True}, "live_unsupported"),
        ({"live_status": "is_upcoming"}, "live_unsupported"),
        ({"live_status": "post_live"}, "live_unsupported"),
        ({"availability": "needs_auth"}, "restricted"),
        ({"duration": 10_000}, "too_long"),
    ],
)
def test_unsupported_media_rejected_before_download(tmp_path, info, code):
    settings = Settings(data_dir=tmp_path, max_duration_seconds=7200)
    with pytest.raises(AppError) as exc:
        check_playable(info, settings)
    assert exc.value.code == code


def test_playable_media_passes(tmp_path):
    check_playable({"live_status": "was_live", "duration": 60, "availability": "public"},
                   Settings(data_dir=tmp_path))

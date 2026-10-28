"""Byte-range delivery through the real FastAPI app."""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.media.delivery import ByteRange, Unsatisfiable, parse_range

SIZE = 10_000
BODY = bytes(i % 251 for i in range(SIZE))
MEDIA_ID = "demo_test_720p"


@pytest.fixture
def client(settings):
    app = create_app(settings)
    with TestClient(app) as test_client:
        storage = app.state.storage
        source = settings.work_dir / "incoming.mp4"
        source.write_bytes(BODY)
        storage.commit(MEDIA_ID, source, {"media": {"content_type": "video/mp4"}})
        test_client.storage = storage
        yield test_client


def get(client, headers=None, method="GET"):
    return client.request(method, f"/api/media/{MEDIA_ID}", headers=headers or {})


def test_full_response_advertises_ranges(client):
    response = get(client)
    assert response.status_code == 200
    assert response.content == BODY
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-length"] == str(SIZE)
    assert response.headers["content-type"] == "video/mp4"
    assert response.headers["etag"]


@pytest.mark.parametrize(
    "header, start, end",
    [
        ("bytes=0-99", 0, 99),
        ("bytes=100-199", 100, 199),
        ("bytes=9990-", 9990, SIZE - 1),
        ("bytes=-10", SIZE - 10, SIZE - 1),
        ("bytes=-999999", 0, SIZE - 1),
        ("bytes=9000-999999", 9000, SIZE - 1),
        ("bytes=0-0", 0, 0),
        ("BYTES = 5 - 9", 5, 9),
    ],
)
def test_partial_ranges(client, header, start, end):
    response = get(client, {"Range": header})
    assert response.status_code == 206
    assert response.headers["content-range"] == f"bytes {start}-{end}/{SIZE}"
    assert response.headers["content-length"] == str(end - start + 1)
    assert response.content == BODY[start:end + 1]


@pytest.mark.parametrize("header", ["bytes=10000-", "bytes=20000-30000", "bytes=-0"])
def test_unsatisfiable_ranges(client, header):
    response = get(client, {"Range": header})
    assert response.status_code == 416
    assert response.headers["content-range"] == f"bytes */{SIZE}"
    assert response.content == b""


@pytest.mark.parametrize("header", ["bytes=abc", "items=0-10", "bytes=50-10", "bytes=-", "bytes=0-1,5-9", "garbage"])
def test_malformed_or_multi_ranges_fall_back_to_full_body(client, header):
    response = get(client, {"Range": header})
    assert response.status_code == 200
    assert response.content == BODY


def test_if_range_with_stale_etag_ignores_range(client):
    etag = get(client).headers["etag"]
    assert get(client, {"Range": "bytes=0-9", "If-Range": etag}).status_code == 206
    stale = get(client, {"Range": "bytes=0-9", "If-Range": '"stale"'})
    assert stale.status_code == 200 and stale.content == BODY


def test_head_requests_send_headers_only(client):
    response = get(client, method="HEAD")
    assert response.status_code == 200
    assert response.headers["content-length"] == str(SIZE)
    assert response.content == b""
    partial = get(client, {"Range": "bytes=0-9"}, method="HEAD")
    assert partial.status_code == 206 and partial.headers["content-length"] == "10"


def test_leases_are_released_after_delivery(client):
    get(client)
    get(client, {"Range": "bytes=0-9"})
    get(client, {"Range": "bytes=999999-"})
    get(client, method="HEAD")
    assert not client.storage.is_leased(MEDIA_ID)


@pytest.mark.parametrize("media_id", ["unknown_720p", "..", "a%2F..%2Fb", "x" * 200])
def test_unknown_or_unsafe_ids(client, media_id):
    response = client.get(f"/api/media/{media_id}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_parse_range_unit():
    assert parse_range(None, 10) is None
    assert parse_range("bytes=2-4", 10) == ByteRange(2, 4)
    assert parse_range("bytes=2-4", 10).length == 3
    with pytest.raises(Unsatisfiable):
        parse_range("bytes=-5", 0)

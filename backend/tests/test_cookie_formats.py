"""Uploaded cookie exports in any common format become a Netscape cookies.txt yt-dlp can read."""

from __future__ import annotations

import json
import time

import pytest

from app.cookies import UnknownCookieFormat, file_jar, netscape_text, to_netscape

NETSCAPE = (
    "# Netscape HTTP Cookie File\n"
    "# This is a generated file! Do not edit.\n"
    ".youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tsid-1\n"
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1999999999\tHSID\thsid-1\n"
    "www.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tf6=40000000&tz=Europe.Paris\n"
    ".google.com\tTRUE\t/\tTRUE\t1999999999\tNID\tgoogle-1\n"
)

COOKIE_EDITOR = [
    {"domain": ".youtube.com", "expirationDate": 1999999999.25, "hostOnly": False, "httpOnly": True, "name": "SID",
     "path": "/", "sameSite": "unspecified", "secure": True, "session": False, "storeId": "0", "value": "sid-1"},
    {"domain": "www.youtube.com", "hostOnly": True, "httpOnly": False, "name": "PREF", "path": "/", "secure": False,
     "session": True, "value": "f6=40000000"},
    {"domain": ".google.com", "expirationDate": 1999999999, "name": "NID", "path": "/", "value": "google-1"},
]

PLAYWRIGHT = {"cookies": [
    {"name": "SID", "value": "sid-1", "domain": ".youtube.com", "path": "/", "expires": 1999999999.5, "httpOnly": True,
     "secure": True, "sameSite": "Lax"},
    {"name": "YSC", "value": "ysc-1", "domain": ".youtube.com", "path": "/", "expires": -1, "httpOnly": True,
     "secure": True, "sameSite": "None"},
], "origins": []}


def fields(lines: list[str]) -> list[tuple[str, ...]]:
    return [tuple(line.split("\t")) for line in lines]


def loads_in_ytdlp(lines: list[str], tmp_path) -> dict[str, str]:
    """What yt-dlp's own Netscape parser makes of the converted file."""
    path = tmp_path / "cookies.txt"
    path.write_text(netscape_text(lines))
    return {cookie.name: cookie.value for cookie in file_jar(path)}


def test_a_netscape_cookies_txt_keeps_its_youtube_lines(tmp_path):
    lines, source = to_netscape("﻿" + NETSCAPE.replace("\n", "\r\n"))
    assert source == "netscape"
    assert fields(lines) == [
        (".youtube.com", "TRUE", "/", "TRUE", "1999999999", "SID", "sid-1"),
        ("#HttpOnly_.youtube.com", "TRUE", "/", "TRUE", "1999999999", "HSID", "hsid-1"),
        ("www.youtube.com", "FALSE", "/", "FALSE", "0", "PREF", "f6=40000000&tz=Europe.Paris"),
    ]
    assert loads_in_ytdlp(lines, tmp_path) == {"SID": "sid-1", "HSID": "hsid-1", "PREF": "f6=40000000&tz=Europe.Paris"}


def test_a_cookies_txt_whose_tabs_became_spaces(tmp_path):
    pasted = NETSCAPE.replace("\t", "   ")
    lines, source = to_netscape(pasted)
    assert source == "netscape"
    assert [f[5] for f in fields(lines)] == ["SID", "HSID", "PREF"]
    assert loads_in_ytdlp(lines, tmp_path)["SID"] == "sid-1"


def test_a_json_export_from_a_cookie_extension(tmp_path):
    lines, source = to_netscape(json.dumps(COOKIE_EDITOR, indent=2))
    assert source == "json"
    assert fields(lines) == [
        ("#HttpOnly_.youtube.com", "TRUE", "/", "TRUE", "1999999999", "SID", "sid-1"),
        ("www.youtube.com", "FALSE", "/", "FALSE", "0", "PREF", "f6=40000000"),  # a session cookie
    ]
    assert loads_in_ytdlp(lines, tmp_path) == {"SID": "sid-1", "PREF": "f6=40000000"}


def test_a_playwright_or_puppeteer_storage_state(tmp_path):
    lines, source = to_netscape(json.dumps(PLAYWRIGHT))
    assert source == "json"
    assert fields(lines) == [
        ("#HttpOnly_.youtube.com", "TRUE", "/", "TRUE", "1999999999", "SID", "sid-1"),
        ("#HttpOnly_.youtube.com", "TRUE", "/", "TRUE", "0", "YSC", "ysc-1"),
    ]
    assert loads_in_ytdlp(lines, tmp_path) == {"SID": "sid-1", "YSC": "ysc-1"}


@pytest.mark.parametrize("header", [
    "SID=sid-1; HSID=hsid-1; PREF=f6=40000000&tz=Europe.Paris",
    "Cookie: SID=sid-1; HSID=hsid-1; PREF=f6=40000000&tz=Europe.Paris;",
])
def test_a_cookie_header_copied_from_a_request(header, tmp_path):
    lines, source = to_netscape(header)
    assert source == "header"
    assert [(f[0], f[3], f[5], f[6]) for f in fields(lines)] == [
        (".youtube.com", "TRUE", "SID", "sid-1"), (".youtube.com", "TRUE", "HSID", "hsid-1"),
        (".youtube.com", "TRUE", "PREF", "f6=40000000&tz=Europe.Paris")]
    assert int(fields(lines)[0][4]) > time.time() + 300 * 24 * 3600
    assert loads_in_ytdlp(lines, tmp_path)["PREF"] == "f6=40000000&tz=Europe.Paris"


@pytest.mark.parametrize("junk", ["", "hello there", "not json {", '{"cookies": "nope"}', "a b c\nd e f"])
def test_anything_else_is_refused(junk):
    with pytest.raises(UnknownCookieFormat):
        lines, _ = to_netscape(junk)
        assert lines  # a recognised format with nothing in it would also be refused, by the upload


def test_only_other_domains_means_no_lines():
    assert to_netscape(".google.com\tTRUE\t/\tTRUE\t0\tNID\tx\n") == ([], "netscape")
    assert to_netscape(json.dumps([{"domain": ".google.com", "name": "NID", "value": "x"}])) == ([], "json")

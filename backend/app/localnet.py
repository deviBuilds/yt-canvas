"""Is a request from this computer? Used by the loopback guard and local-only endpoints."""

from __future__ import annotations

import ipaddress

from fastapi import Request


def is_loopback_ip(host: str | None) -> bool:
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def is_local_host_header(value: str | None) -> bool:
    """``Host`` names this computer: localhost, *.localhost or a loopback address (any port)."""
    if not value:
        return True  # HTTP/1.0 clients may omit it; the client address check still applies
    host = value.strip().lower()
    if host.startswith("["):
        host = host[1:host.find("]")] if "]" in host else host
    elif host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host == "localhost" or host.endswith(".localhost") or is_loopback_ip(host)


def is_local_request(request: Request) -> bool:
    """From a loopback address *and* addressed to this computer.

    A tunnel such as cloudflared connects from 127.0.0.1 but keeps the public ``Host``,
    so requests through it are not local.
    """
    client = request.client.host if request.client else None
    return is_loopback_ip(client) and is_local_host_header(request.headers.get("host"))

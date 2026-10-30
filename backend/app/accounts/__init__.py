"""Accounts: Clerk sign-in, an allowlist, and each person's data in Convex.

On when a Clerk publishable key is configured (see ``config.Settings.accounts_enabled``);
otherwise yt-canvas runs in no-login mode and nothing here is used.

- ``clerk.py``: verifies Clerk session tokens and reads profiles from Clerk's Backend API.
- ``convex.py``: the server's only way into Convex (the ``/backend`` HTTP action).
- ``crypto.py``: AES-GCM for secrets (YouTube cookies, Plex tokens) before they reach Convex.
- ``users.py``: who a request is from (a Clerk session or a paired device), with caching.
- ``guard.py``: the ASGI middleware that requires a signed-in, allowlisted person.
- ``youtube.py``: each person's uploaded YouTube cookies and their YouTube session.
- ``routes.py``: ``/api/auth``, ``/api/me/cookies``, ``/api/library`` and ``/api/admin``.
"""

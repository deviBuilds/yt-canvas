#!/usr/bin/env python3
"""Deploy yt-canvas to its server (ungate@5.75.169.86) at https://yt.devhomelab.app.

Run from the repository root with the backend's Python (it has python-dotenv):

    backend/.venv/bin/python scripts/deploy.py            # everything
    backend/.venv/bin/python scripts/deploy.py --skip-convex --skip-cloudflare

Each step is safe to repeat:
1. Convex: push frontend/convex to the deployment in CONVEX_DEPLOY_KEY and set its env vars.
2. Cloudflare (CF_ACCOUNT_API_TOKEN): a remotely managed tunnel, yt-canvas-public, whose
   ingress sends the hostnames to the app container, and a proxied CNAME for each hostname.
   ytc.devhomelab.app, where the app ran first (on gm-server-1-us), still leads to it.
   An existing DNS record that points anywhere else is left alone and the deploy stops.
3. The server: the code (the checkout, or --source) is copied to ~/apps/yt-canvas (no .env, cookies, or build output),
   deploy/.env (TUNNEL_TOKEN) and deploy/app.env (the app's keys) are written with mode 0600,
   and docker compose builds and starts the app and its tunnel.
4. Checks: the app's health on the server, then the public URL.

Secrets are read from .env and passed over ssh's stdin or in subprocess environments;
nothing secret is printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
HOST = "ungate@5.75.169.86"
# The server isn't in ~/.ssh/config; it takes its own key.
SSH_OPTIONS = ["-i", str(Path("~/.ssh/ssh-key-ungate.key").expanduser()), "-o", "IdentitiesOnly=yes",
               "-o", "BatchMode=yes"]
REMOTE_DIR = "apps/yt-canvas"
HOSTNAME = "yt.devhomelab.app"
HOSTNAMES = (HOSTNAME, "ytc.devhomelab.app")  # the first is the app's address; the rest still lead to it
ZONE = "devhomelab.app"
TUNNEL = "yt-canvas-public"
SERVICE = "http://app:8000"
LOCAL_PORT = 3350
CF_API = "https://api.cloudflare.com/client/v4"

# What the app gets in deploy/app.env: (name in the app, names to read from .env, required).
APP_ENV = [
    ("CLERK_PUBLISHABLE_KEY", ("CLERK_PUBLISHABLE_KEY", "VITE_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"), True),
    ("CLERK_SECRET_KEY", ("CLERK_SECRET_KEY",), True),
    ("CLERK_JWT_KEY", ("CLERK_JWT_KEY",), False),
    ("CONVEX_SITE_URL", ("CONVEX_SITE_URL", "CONVEX_ENDPOINT"), True),
    ("YTC_CONVEX_SECRET", ("YTC_CONVEX_SECRET",), True),
    ("YTC_SECRETS_KEY", ("YTC_SECRETS_KEY",), True),
    ("YTC_ADMIN_EMAILS", ("YTC_ADMIN_EMAILS",), True),
    ("YTC_MARK_WATCHED", ("YTC_MARK_WATCHED",), False),
]
# The server's own settings, not secret. .env's values for these are this computer's, so they
# aren't copied; change them here.
SERVER_SETTINGS = {"YTC_CACHE_MAX_MB": "8192", "YTC_CACHE_TTL_HOURS": "24", "YTC_LOG_LEVEL": "INFO",
                   "YTC_ALLOWED_ORIGINS": ",".join(f"https://{name}" for name in HOSTNAMES)}
CONVEX_ENV = ["YTC_CONVEX_SECRET", "CLERK_WEBHOOK_SECRET", "CLERK_SECRET_KEY"]

RSYNC_EXCLUDES = [
    ".git", ".env", ".env.*", "deploy/*.env", "cookie.txt", "cookies.txt", "*.cookies.txt", "__pycache__", "*.pyc",
    "backend/.venv", "backend/.pytest_cache", "frontend/node_modules", "frontend/dist", "frontend/test-results",
    "frontend/playwright-report", ".DS_Store",
]


def step(message: str) -> None:
    print(f"\n==> {message}", flush=True)


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def first(env: dict[str, str | None], names: tuple[str, ...]) -> str | None:
    return next((env[name] for name in names if env.get(name)), None)


# -- Cloudflare ---------------------------------------------------------------------------


class Cloudflare:
    def __init__(self, token: str, account: str) -> None:
        self.token = token
        self.account = account

    def call(self, method: str, path: str, body: dict | None = None):
        request = urllib.request.Request(f"{CF_API}{path}", method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Authorization": f"Bearer {self.token}",
                                                  "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            data = json.loads(exc.read() or b"{}")
        if not data.get("success"):
            messages = "; ".join(e.get("message", "?") for e in data.get("errors", [])) or "unknown error"
            fail(f"Cloudflare {method} {path.split('?')[0]}: {messages}")
        return data["result"]

    def tunnel(self) -> str:
        found = self.call("GET", f"/accounts/{self.account}/cfd_tunnel?name={TUNNEL}&is_deleted=false")
        if found:
            print(f"tunnel {TUNNEL} exists ({found[0]['id']})")
            return found[0]["id"]
        created = self.call("POST", f"/accounts/{self.account}/cfd_tunnel", {"name": TUNNEL, "config_src": "cloudflare"})
        print(f"created tunnel {TUNNEL} ({created['id']})")
        return created["id"]

    def configure(self, tunnel_id: str) -> None:
        self.call("PUT", f"/accounts/{self.account}/cfd_tunnel/{tunnel_id}/configurations", {"config": {"ingress": [
            *({"hostname": name, "service": SERVICE, "originRequest": {}} for name in HOSTNAMES),
            {"service": "http_status:404"},
        ]}})
        print(f"tunnel ingress: {', '.join(HOSTNAMES)} -> {SERVICE}")

    def dns(self, tunnel_id: str, hostname: str) -> None:
        zones = self.call("GET", f"/zones?name={ZONE}")
        if not zones:
            fail(f"the token can't see the {ZONE} zone")
        zone = zones[0]["id"]
        target = f"{tunnel_id}.cfargotunnel.com"
        records = self.call("GET", f"/zones/{zone}/dns_records?name={hostname}")
        if records:
            record = records[0]
            if record["type"] == "CNAME" and record["content"] == target:
                print(f"DNS {hostname} already points at the tunnel")
                return
            fail(f"{hostname} already has a {record['type']} record pointing at {record['content']}; "
                 "remove it in Cloudflare if it's unused, then deploy again")
        self.call("POST", f"/zones/{zone}/dns_records", {"type": "CNAME", "name": hostname, "content": target,
                                                          "proxied": True, "comment": "yt-canvas tunnel"})
        print(f"DNS {hostname} -> {target} (proxied)")

    def token_for(self, tunnel_id: str) -> str:
        return self.call("GET", f"/accounts/{self.account}/cfd_tunnel/{tunnel_id}/token")


# -- the server -------------------------------------------------------------------------------


def ssh(command: str, *, stdin: str | None = None, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(["ssh", *SSH_OPTIONS, HOST, command], input=stdin, text=True, check=check,
                          capture_output=capture)


def write_remote(path: str, content: str) -> None:
    ssh(f"umask 077 && mkdir -p {REMOTE_DIR}/deploy && cat > {REMOTE_DIR}/{path} && chmod 600 {REMOTE_DIR}/{path}",
        stdin=content)


def env_file(values: dict[str, str]) -> str:
    for name, value in values.items():
        if "\n" in value:
            fail(f"{name} spans several lines; docker's env files can't hold that")
    return "".join(f"{name}={value}\n" for name, value in values.items())


def wait_for(description: str, probe, timeout: float = 600) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe():
            print(f"{description}: ok")
            return
        time.sleep(5)
    fail(f"{description}: no answer after {int(timeout)} s")


def public_ok() -> bool:
    # Cloudflare's bot checks turn away Python's default User-Agent.
    request = urllib.request.Request(f"https://{HOSTNAME}/api/auth/config", headers={"User-Agent": "yt-canvas-deploy"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read()).get("accounts") is True
    except (OSError, ValueError):
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--skip-convex", action="store_true", help="don't push Convex functions or env vars")
    parser.add_argument("--skip-cloudflare", action="store_true", help="reuse the tunnel token already on the server")
    parser.add_argument("--source", type=Path, default=ROOT,
                        help="copy this directory instead of the checkout (say, an export of the last commit)")
    args = parser.parse_args()
    env = dotenv_values(ROOT / ".env")

    app_env: dict[str, str] = {}
    for name, sources, required in APP_ENV:
        value = first(env, sources)
        if value:
            app_env[name] = value
        elif required:
            fail(f"{name} isn't set in .env")
    app_env.update(SERVER_SETTINGS)

    if not args.skip_convex:
        step("Convex: push functions and env vars")
        if not env.get("CONVEX_DEPLOY_KEY"):
            fail("CONVEX_DEPLOY_KEY isn't set in .env")
        convex_env = {**os.environ, "CONVEX_DEPLOY_KEY": env["CONVEX_DEPLOY_KEY"]}
        subprocess.run(["npx", "convex", "dev", "--once", "--typecheck", "enable"], cwd=ROOT / "frontend",
                       env=convex_env, check=True)
        for name in CONVEX_ENV:
            if not env.get(name):
                fail(f"{name} isn't set in .env")
            subprocess.run(["npx", "convex", "env", "set", name, env[name]], cwd=ROOT / "frontend", env=convex_env,
                           check=True, capture_output=True)
            print(f"Convex env {name} set")

    tunnel_token = None
    if not args.skip_cloudflare:
        step(f"Cloudflare: tunnel {TUNNEL} and DNS for {', '.join(HOSTNAMES)}")
        token = env.get("CF_ACCOUNT_API_TOKEN")
        account = env.get("CF_ACCOUNT_ID") or re.sub(r"^https://([^.]+)\..*$", r"\1", env.get("CF_R2_ENDPOINT") or "")
        if not token or not re.fullmatch(r"[0-9a-f]{32}", account or ""):
            fail("set CF_ACCOUNT_API_TOKEN and CF_ACCOUNT_ID (or CF_R2_ENDPOINT) in .env")
        cloudflare = Cloudflare(token, account)
        tunnel_id = cloudflare.tunnel()
        cloudflare.configure(tunnel_id)
        for name in HOSTNAMES:
            cloudflare.dns(tunnel_id, name)
        tunnel_token = cloudflare.token_for(tunnel_id)

    step(f"Copy {args.source} to {HOST}:~/{REMOTE_DIR}")
    ssh(f"mkdir -p {REMOTE_DIR}")
    subprocess.run(["rsync", "-az", "--delete", "-e", shlex.join(["ssh", *SSH_OPTIONS]),
                    *[f"--exclude={pattern}" for pattern in RSYNC_EXCLUDES],
                    f"{args.source.resolve()}/", f"{HOST}:{REMOTE_DIR}/"], check=True)

    step("Write deploy/.env and deploy/app.env (mode 0600)")
    if tunnel_token:
        write_remote("deploy/.env", env_file({"TUNNEL_TOKEN": tunnel_token}))
    elif ssh(f"test -s {REMOTE_DIR}/deploy/.env", check=False).returncode != 0:
        fail("no tunnel token on the server yet; run without --skip-cloudflare")
    write_remote("deploy/app.env", env_file(app_env))

    step("Build and start (docker compose)")
    ssh(f"cd {REMOTE_DIR} && docker compose -f deploy/compose.yml up -d --build --remove-orphans")

    step("Checks")
    wait_for("app health on the server", lambda: ssh(
        f"curl -fsS -m 5 http://127.0.0.1:{LOCAL_PORT}/api/auth/config", check=False, capture=True).returncode == 0)
    # A new DNS record can take minutes to reach resolvers that cached "no such host".
    wait_for(f"https://{HOSTNAME}", public_ok, timeout=600)
    print(f"\nDeployed: https://{HOSTNAME}")


if __name__ == "__main__":
    main()

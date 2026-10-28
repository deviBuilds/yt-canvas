#!/usr/bin/env bash
# Start the FastAPI backend (port 8000) and the Vite dev server (port 5173).
# Vite proxies /api to the backend, so the page, API and media share one origin.
# Written for bash 3.2 too (the version macOS ships), so no `wait -n`.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${YTC_PORT:-8000}"
PYTHON="${YTC_PYTHON:-$ROOT/backend/.venv/bin/python}"
VITE="$ROOT/frontend/node_modules/.bin/vite"

if [[ ! -x "$PYTHON" ]]; then
  echo "Backend virtualenv not found. Run: make setup" >&2
  exit 1
fi
if [[ ! -x "$VITE" ]]; then
  echo "Frontend dependencies not installed. Run: make setup" >&2
  exit 1
fi

backend_pid=""
frontend_pid=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$frontend_pid" ]]; then kill "$frontend_pid" 2>/dev/null || true; fi
  if [[ -n "$backend_pid" ]]; then kill "$backend_pid" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd "$ROOT/backend" && exec "$PYTHON" -m uvicorn app.main:app --reload --host 127.0.0.1 --port "$BACKEND_PORT") &
backend_pid=$!
# Run Vite directly rather than through npx, so stopping this script stops Vite too.
(cd "$ROOT/frontend" && YTC_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" exec "$VITE" --host 127.0.0.1) &
frontend_pid=$!

echo "yt-canvas: open http://127.0.0.1:5173 (API on :$BACKEND_PORT). Ctrl+C stops both."
# Stop both as soon as either one exits.
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
  sleep 1
done

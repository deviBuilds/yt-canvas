#!/usr/bin/env bash
# Start the FastAPI backend (port 8000) and the Vite dev server (port 5173).
# Vite proxies /api to the backend, so the page, API and media share one origin.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${YTC_PORT:-8000}"
PYTHON="${YTC_PYTHON:-$ROOT/backend/.venv/bin/python}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Backend virtualenv not found. Run: make setup" >&2
  exit 1
fi
if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  echo "Frontend dependencies not installed. Run: make setup" >&2
  exit 1
fi

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd "$ROOT/backend" && exec "$PYTHON" -m uvicorn app.main:app --reload --host 127.0.0.1 --port "$BACKEND_PORT") &
pids+=($!)
(cd "$ROOT/frontend" && YTC_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" exec npx vite --host 127.0.0.1) &
pids+=($!)

echo "yt-canvas: open http://127.0.0.1:5173 (API on :$BACKEND_PORT). Ctrl+C stops both."
wait -n

# yt-canvas developer commands. Run `make help` for a list.
PYTHON ?= python3
VENV := backend/.venv
PY := $(VENV)/bin/python
PORT ?= 8000

.PHONY: help setup setup-backend setup-frontend dev start build test test-backend test-frontend e2e e2e-live test-live check-deps clean

help:
	@echo "make setup        install backend (venv) and frontend (npm) dependencies"
	@echo "make check-deps   report yt-dlp, yt-dlp-ejs, JS runtime and FFmpeg status"
	@echo "make dev          run backend :$(PORT) + Vite dev server :5173 (open http://127.0.0.1:5173)"
	@echo "make build        production frontend build (frontend/dist)"
	@echo "make start        serve the production build + API from one origin on :$(PORT)"
	@echo "make test         backend pytest + frontend vitest"
	@echo "make e2e          Playwright browser tests (builds first; uses local demo media)"
	@echo "make test-live    opt-in tests against real YouTube (backend + browser)"

setup: setup-backend setup-frontend

setup-backend:
	$(PYTHON) -m venv $(VENV)
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -r backend/requirements-dev.txt

setup-frontend:
	cd frontend && npm ci

check-deps:
	cd backend && .venv/bin/python -c "import asyncio, json; from app.config import load_settings; from app.deps import detect_dependencies; print(json.dumps(asyncio.run(detect_dependencies(load_settings())).to_dict(), indent=2))"

dev:
	./scripts/dev.sh

build:
	cd frontend && npm run build

start: build
	cd backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port $(PORT)

test: test-backend test-frontend

test-backend:
	cd backend && .venv/bin/python -m pytest -q

test-frontend:
	cd frontend && npm run typecheck && npm test

e2e: build
	cd frontend && npx playwright test

test-live:
	-cd backend && YTC_LIVE_TESTS=1 .venv/bin/python -m pytest -m live -s -q
	cd frontend && npm run build && E2E_LIVE=1 npx playwright test live-youtube

clean:
	rm -rf frontend/dist frontend/test-results backend/.pytest_cache

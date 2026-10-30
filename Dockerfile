# yt-canvas in one image: the built frontend, the FastAPI backend, FFmpeg, and Deno (the
# JavaScript runtime yt-dlp needs for YouTube). Runs a single process, because jobs, leases
# and caches live in memory. Built and started by deploy/compose.yml (see scripts/deploy.py).
ARG DENO_VERSION=2.9.5

FROM node:24-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM denoland/deno:bin-${DENO_VERSION} AS deno

FROM python:3.13-slim AS app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=frontend /app/frontend/dist /app/frontend/dist
# /data (media cache) and /config (apps, per-user cookie files) are volumes owned by this user.
RUN useradd --create-home --uid 10001 ytc && mkdir -p /data /config && chown ytc:ytc /data /config
USER ytc
ENV PYTHONUNBUFFERED=1 \
    YTC_IGNORE_DOTENV=1 \
    YTC_DATA_DIR=/data \
    YTC_CONFIG_DIR=/config \
    YTC_FRONTEND_DIST=/app/frontend/dist
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/auth/config', timeout=4).status == 200 else 1)"]
# Requests arrive only through the Cloudflare tunnel; its X-Forwarded-* headers are trusted.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]

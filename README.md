# yt-canvas

Browse YouTube (search, channels, playlists) and play videos whose **actual decoded frames are drawn into an HTML `<canvas>`**. A hidden `HTMLVideoElement` is the decoder, audio output and clock; frames are copied into Canvas 2D with `requestVideoFrameCallback()`, where an optional visual effect (grayscale, sepia, invert, pixelate) is applied.

- **Backend:** Python + FastAPI, with `yt-dlp` for discovery and media acquisition and FFmpeg/ffprobe for merging and conversion.
- **Frontend:** React + TypeScript + Vite, with favorites and history in `localStorage`.

![Watch page (demo media) rendered into a canvas](docs/screenshots/desktop-watch.png)

> **Note:** Playback of extracted media happens outside YouTube's official embedded player. Any deployment must account for content rights and YouTube's Terms of Service.

## Quick start

Requirements (versions this was built and tested with):

| Tool | Required | Tested |
|---|---|---|
| Python | 3.11+ | 3.13.17 |
| Node.js / npm | 22.13+ (Vite 8, Vitest 5, jsdom 29) | 22.22.0 / 10.9.4 |
| FFmpeg + ffprobe | with `libx264` and `aac` | 6.1.1 (Ubuntu 24.04 build) |
| JavaScript runtime for yt-dlp | **Deno ≥ 2.3.0** (recommended, used automatically), or Node ≥ 22.0.0 via `YTC_YTDLP_JS_RUNTIMES=node` | Deno 2.9.8 |

```bash
make setup          # backend venv + pip install, frontend npm ci
cp .env.example .env  # optional; every setting has a default
make check-deps     # shows yt-dlp / yt-dlp-ejs / JS runtime / FFmpeg status
make dev            # backend :8000 + Vite :5173 → open http://127.0.0.1:5173
```

Production-style, with a single origin serving the built UI, the API and the media:

```bash
make start          # builds frontend/dist, serves everything on http://127.0.0.1:8000
```

Without `make`:

```bash
python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements-dev.txt
(cd frontend && npm ci)
(cd backend && .venv/bin/python -m uvicorn app.main:app --port 8000) &
(cd frontend && npx vite)
```

Run a single backend process (no `--workers`), because jobs, leases and caches live in memory.

### yt-dlp's YouTube requirements (checked 2026-10-28)

yt-dlp 2026.10.26 must solve YouTube's JavaScript challenges with the **yt-dlp-ejs** scripts (0.8.0, installed by `yt-dlp[default]`), running on an **external JS runtime**. The [EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS) lists the supported runtimes:

- **Deno** ≥ 2.3.0: recommended, and the only one enabled by default.
- **Node** ≥ 22.0.0: enable with `YTC_YTDLP_JS_RUNTIMES=node`.
- **QuickJS**: supported.
- **Bun** 1.2.11–1.3.14: supported but deprecated.

Without a runtime, formats go missing or extraction fails. `GET /api/health` and the UI banner say which runtime is in use, and the backend always passes `--ignore-config` so a user-level yt-dlp config can't change its behaviour.

## Using it

- **Search bar:** type keywords, or paste a video, playlist or channel URL. The forms below are accepted, anything else (including other hosts) is rejected:
  - videos: `youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…`, `/embed/…`, `/live/…`, the `m.`, `music.` and `youtube-nocookie.com` hosts; `t=` start times and `&list=` playlists are honoured
  - playlists: `/playlist?list=…`
  - channels: `/channel/UC…`, `/@handle`, `/c/…`, `/user/…`, or a bare `@handle`
  - search URLs: `/results?search_query=…`
- **Home** shows only things that come from you or are clearly labelled, never a personalized feed:
  - continue watching, favorites, recently watched, recent searches
  - **topic shortcuts**, labelled as plain keyword searches
  - a **Demo & test media** shelf of locally generated clips, labelled as not YouTube
- **Watch page:** the canvas player has:
  - play/pause, seek, volume/mute, speed (0.25–2×), fullscreen, previous/next
  - an effect toggle plus an effect menu
  - an "Up next" queue with autoplay
  - keyboard shortcuts: Space/K, ←/→, J/L, ↑/↓, M, F, G, `<`/`>`, 0–9, Shift+N/P
- **Load more** appears only when the provider actually reported another page.

## How it works

```
frontend/src/
  discovery/    API client + paged results hook (search, channel, playlist)
  preparation/  job API, polling hook, progress/errors panel
  player/       CanvasRenderer (frame loop), CanvasPlayer (component), controls, effects, sizing
  library/      favorites / history / recent searches (localStorage)
  queue/        playback queue (sessionStorage)
backend/app/
  discovery/    DiscoveryProvider interface, yt-dlp flat provider, normalization, TTL cache
  media/        source providers (YouTube, demo), format selection, FFmpeg processing,
                job manager, storage/eviction/leases, byte-range delivery
  validation.py URL/ID parsing; canonical URLs are rebuilt from validated IDs
  procs.py      subprocess runner (arg arrays, timeouts, process-group kill, bounded output)
```

### Discovery

`DiscoveryProvider` (`backend/app/discovery/provider.py`) is the replaceable interface. The default provider uses `yt-dlp --flat-playlist -J`:
- search uses `ytsearchN:<query>`
- channels use `https://www.youtube.com/<ref>/videos`
- playlists use `…/playlist?list=<id>`

Flat extraction never resolves streams, so rendering results downloads nothing.

- **Pagination is real:** each page is fetched with `--playlist-items offset+1:offset+limit+1`, and the extra item tells whether another page exists. Pages are 20 items, search is capped at 100 results and lists at 500.
- **Metadata cache:** results are cached for 10 minutes (LRU, 256 entries), and concurrent identical requests share one yt-dlp call.
- **Tolerant normalization:** missing durations, thumbnails or channel fields are handled. Thumbnails are restricted to YouTube image hosts, falling back to `i.ytimg.com/vi/<id>/hqdefault.jpg`. Private or deleted entries stay listed but are marked unavailable.

### Media preparation (the MVP prepares before playback)

Selecting a video creates a background job: `queued → resolving → downloading → processing → ready` (or `failed`).

1. **Resolve:** a single `yt-dlp -J` call gets the metadata and every format. Live, upcoming and just-ended streams, sign-in or paid videos, and videos over the duration limit are rejected here, before any download.
2. **Select** (`media/formats.py`): selection goes by codec strings, never by container (an `.mp4` may hold AV1). Each preference is taken at the highest height ≤ `YTC_MAX_HEIGHT` (720):
   1. H.264 video-only + AAC audio-only (stereo preferred, non-DRC, original language)
   2. H.264/AAC progressive
   3. H.264 + other audio
   4. VP9/AV1/HEVC + audio (needs transcoding)

   If the size estimate exceeds the limit, the next smaller candidate is used.
3. **Download:** the selected track(s) are downloaded as separate files with `--load-info-json`, so there is no second extraction. Real byte progress comes from `--progress-template`, and size limits are enforced while downloading.
4. **Process** (`media/ffmpeg.py`): every stream is probed with ffprobe. Browser-safe streams are copied:
   - H.264 in 8-bit 4:2:0 with the Baseline, Main or High profile
   - AAC LC or HE-AAC

   Anything else is transcoded to H.264/AAC (`libx264 -preset veryfast -crf 23`, AAC 128k stereo, downscaled to the height limit). Merging and conversion happen in one FFmpeg pass with `-movflags +faststart`. The result is re-probed, and the `moov`-before-`mdat` box order is verified.
5. **Serve:** the file is committed atomically to the cache and served from `/api/media/<id>` with byte ranges. Extracted googlevideo URLs never leave the backend and are redacted in logs.

Identical requests share one job; a file already in the cache yields an immediately `ready` job, even after a restart. Progress is determinate when sizes or durations are known, and indeterminate otherwise.

**Initial delay:** playback starts only after the whole video has been downloaded and processed. For a typical 10-minute 720p video that is roughly 100–160 MB of download plus a few seconds of remuxing. Transcoding, when needed, adds time roughly proportional to the video's length. The UI says so while preparing. The media-provider boundary (`media/provider.py`) carries a `supports_progressive` flag and a `delivery` mode, so progressive (fragmented-MP4) streaming can be added later without changing the job API.

**Limits:** all are configurable in `.env.example`:

| Setting | Default |
|---|---|
| Concurrent jobs | 2 |
| Queued jobs (then HTTP 429) | 16 |
| Download size per video | 1 GB |
| Duration | 2 h |
| Resolve timeout | 60 s |
| Download timeout | 30 min |
| Processing timeout | 30 min |
| Cache size | 4 GB, LRU |
| Cache TTL | 6 h since last access |
| Minimum free disk | 1 GB |

**Cache behaviour:**
- Prepared files live in `YTC_DATA_DIR/media` (default: `<tmp>/yt-canvas`).
- Last access is recorded in the file's atime, while the mtime stays fixed, which keeps ETags stable.
- A cleanup task runs every 5 minutes, evicting expired files and removing orphaned job directories.
- Files being delivered hold a lease and are never evicted mid-stream.

### Byte-range delivery (`media/delivery.py`)

| Request | Response |
|---|---|
| No `Range` | `200` + `Accept-Ranges: bytes` |
| `bytes=a-b`, `bytes=a-`, `bytes=-n` | `206` + `Content-Range` (end clamped to the file size) |
| Start ≥ size, or `bytes=-0` | `416` + `Content-Range: bytes */size` |
| Malformed range, other unit, multiple ranges | Ignored → `200` full body (allowed by RFC 9110) |
| `If-Range` not matching the ETag | `200` full body |

`HEAD` is supported.

### Canvas playback (`frontend/src/player`)

**Rendering** (`CanvasRenderer`, framework-agnostic):
- With rVFC it draws once per presented frame.
- Otherwise it uses a `requestAnimationFrame` loop that runs only while playing and skips unchanged frames.
- At most one callback is ever pending (no duplicate loops).
- Paused, seeked, loaded, resized and effect-changed states are redrawn explicitly.
- On a source change it cancels and re-arms; `dispose()` cancels everything.

**Sizing:**
- The canvas box keeps the video's aspect ratio inside a 16:9 stage, letterboxed or pillarboxed.
- The backing buffer is CSS size × `devicePixelRatio`, capped at the video's intrinsic resolution (upscaling is left to the compositor) and at 3840×2160 pixels in total.

**Effects:**
- They use `ctx.filter` where supported.
- Otherwise a per-pixel `getImageData` transform is used. That is possible because media is served from the page's own origin (Vite proxies `/api` in development), so the canvas is never tainted.

**Decoder element visibility:**
- The `<video>` sits under the canvas at the same size, with `opacity: 0`, `playsinline`, `aria-hidden` and no PiP or remote playback, so it stays laid out and on screen without ever being visible.
- `display:none` is deliberately not the default, because browsers differ.
- A diagnostic e2e test measured all four strategies (`?decoder=layered|covered|offscreen|hidden`). In Chromium 153 (headless), every one kept presenting frames at ~27–31 fps for a 30 fps source.
- **Other browsers were not tested here**, which is why the conservative layered strategy stays the default.

**Audio and gestures:**
- The same element persists across source changes.
- Autoplay is attempted after metadata loads; if the browser blocks it, a "Click to play" overlay supplies the gesture.
- Fullscreen applies to the player wrapper (canvas + HTML controls), falling back to a fixed full-viewport mode where element fullscreen is unavailable (e.g. iPhone).

**State and errors:**
- Buffering (`waiting`), media errors (with "Prepare again") and canvas draw errors are surfaced in the player.
- A Media Session integration handles hardware keys.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Dependency report (yt-dlp, yt-dlp-ejs, JS runtimes, FFmpeg) and warnings |
| `GET /api/resolve?q=` | Classify input as video / playlist / channel / search, without contacting YouTube |
| `GET /api/search?q=&offset=` | Keyword search page |
| `GET /api/channel?ref=&offset=` | Channel uploads (`UC…`, `@handle`, `c/…`, `user/…`) |
| `GET /api/playlist?id=&offset=` | Playlist entries |
| `GET /api/demo`, `GET /api/demo/{id}/layout` | Demo samples and their pixel layout |
| `POST /api/jobs` `{source: "youtube"\|"demo", id}` | Create or join a preparation job (201 new, 200 existing) |
| `GET /api/jobs/{id}` / `DELETE /api/jobs/{id}` | Job status / cancel |
| `GET`/`HEAD /api/media/{media_id}` | Prepared MP4 with byte ranges |

Errors are always `{"error": {code, message, hint, retryable}}`. The codes include:

`invalid_input`, `not_found`, `unavailable`, `live_unsupported`, `restricted`, `youtube_blocked`, `download_forbidden`, `rate_limited`, `js_runtime_problem`, `no_formats`, `too_large`, `too_long`, `dependency_missing`, `storage_full`, `busy`, `timeout`, `processing_failed`, `cancelled`.

Raw yt-dlp and FFmpeg output stays in the backend log with URL query strings redacted.

## Demo / test media

`YTC_ENABLE_DEMO=true` (the default) exposes three clips that FFmpeg generates locally, always labelled **DEMO** in the API and UI. Each is encoded differently, so both pipeline paths get exercised:

| Clip | Source encoding | Pipeline path |
|---|---|---|
| `bars` (16:9, 20 s) | H.264/AAC in Matroska | remux |
| `vertical` (9:16, 12 s) | MPEG-4 Part 2/MP3 in AVI | transcode |
| `sweep` (4:3, 16 s) | VP9/Opus in WebM | transcode |

Every frame carries machine-readable content:
- a 24 px **time bar**, whose white fraction equals `t / duration`
- pure **red, green and blue swatches**
- an animated background

Browser tests read these pixels back from the canvas.

## Tests

```bash
make test        # backend pytest (192) + frontend typecheck & vitest (45)
make e2e         # Playwright, production build, demo media (14 tests, Chromium)
make test-live   # opt-in: real YouTube (backend + browser)
```

- **Backend** (`backend/tests`):
  - URL/ID validation and metadata normalization (with real yt-dlp output shapes)
  - format selection, error classification and redaction
  - subprocess timeouts, kill and output bounds
  - job states, dedupe, concurrency, cancel and retry
  - byte ranges (partial, suffix, clamped, unsatisfiable, malformed, multi-range, `If-Range`, `HEAD`, leases, unsafe IDs)
  - cache LRU/TTL/leases and discovery cache coalescing
  - the real FFmpeg pipeline for all three demo samples
- **Frontend unit** (`frontend/src/**/*.test.ts(x)`), against fake media and canvas implementations:
  - the renderer loop (single pending callback, redraw on seek/pause, effects with and without `ctx.filter`, reset, dispose, backing size, rAF fallback)
  - `CanvasPlayer` controls, seeking, source changes, autoplay-blocked flow, errors, buffering, keyboard, unmount
  - sizing, shortcuts, localStorage handling
- **Browser** (`frontend/e2e`), reading pixels with `getImageData`:
  - frames change during playback, and the time bar matches `currentTime`
  - a 30 fps draw rate, proving a single loop
  - pause holds the frame and resume continues
  - seeking by slider and keyboard redraws, including while paused
  - grayscale applies both paused and playing, and other effects work
  - the rAF fallback renders
  - volume, mute, speed and fullscreen work
  - next/previous change the source and the canvas follows the new aspect ratio
  - favorites and continue watching persist and resume
  - invalid or unknown media show clear errors
  - decoder strategies, plus desktop (1440×900) and mobile (Pixel 7, 412×839 at 2.625× DPR) layouts with no horizontal overflow

**Browser coverage:** only Playwright's Chromium 153 (headless shell, build 1243) was tested. Firefox, Safari/WebKit and real mobile devices were not tested.

### Results on 2026-10-28 (cloud sandbox)

- **Passed:** all deterministic suites (backend, frontend unit, Playwright with demo media).
- **Live YouTube:**
  - Search, channel and playlist listing **worked**, including search through the UI (20 results).
  - Format resolution worked at first: the EJS challenge solver ran via Deno, and 720p H.264 + stereo AAC was chosen for a remux. The googlevideo media download then returned **HTTP 403** (reported as `download_forbidden`).
  - Later attempts got HTTP 429 and **"Sign in to confirm you're not a bot"** (reported as `youtube_blocked`).
  - So **end-to-end playback of a real YouTube video could not be demonstrated from this environment**. It was not faked with fixtures. The likely cause is YouTube restricting this datacenter network; it should be re-checked from a residential or otherwise unrestricted network with `make test-live`.

## Limitations

- Only public, non-live videos are supported. Live or upcoming streams, age/member/paid-restricted videos and private videos are rejected with an explanation. Cookie/login collection and access-restriction workarounds are intentionally not implemented.
- YouTube extraction breaks periodically. Keep `yt-dlp` and `yt-dlp-ejs` updated, and expect HTTP 403/429 or bot checks from some networks, notably cloud IPs.
- Playback waits for full preparation (no progressive streaming yet). Prepared media up to 720p is stored on local disk.
- Output is always H.264/AAC MP4; VP9/AV1/Opus sources are transcoded, which costs CPU time.
- Search is capped at 100 results and channels/playlists at 500 items (configurable). Only a channel's "Videos" tab is listed.
- Favorites, history and the queue are per browser; there are no accounts.
- Single backend process; state is in memory apart from the media cache.

## Configuration

See [`.env.example`](.env.example) for every `YTC_*` setting.

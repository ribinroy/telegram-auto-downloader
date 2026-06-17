# DownLee - Telegram Auto Downloader

## Project Overview

DownLee is a full-stack media download manager that automatically downloads files from Telegram channels and supports manual URL downloads via yt-dlp (1000+ sites). It provides a real-time web dashboard for monitoring and managing downloads.

## Architecture

```
Frontend (React/TypeScript/Vite)  <-->  Backend (Python/Flask)  <-->  PostgreSQL
                                    |
                     WebSocket (Socket.IO) for real-time updates
```

### Threading Model

```
Main Thread
  |- Flask thread (daemon) ........... REST API + WebSocket (SocketIO, threading mode)
  |- Event loop thread (daemon) ..... asyncio loop for yt-dlp subprocesses
  |- VPS threads (daemon) ........... one thread per SFTP transfer + hourly autoSync loop
  '- Telegram thread (blocking) ..... Telethon client.start() - blocks main thread
```

### Entry Point

- `/main.py` - Root entry, imports `backend.main`
- `/backend/main.py` - Initializes DB, validates config, starts all threads

## Tech Stack

### Backend
- **Python 3.10+** with virtualenv at `./venv/`
- **Flask 2.3+** - REST API
- **Flask-SocketIO 5.5+** - WebSocket for real-time progress
- **SQLAlchemy 2.0+** - ORM (PostgreSQL via psycopg2-binary)
- **Telethon 1.28+** - Telegram client
- **yt-dlp** - URL-based downloads (installed separately, invoked via subprocess)
- **Prometheus client** - Metrics at `/metrics`

### Frontend
- **React 19** + **TypeScript 5.9**
- **Vite 7** - Build tool
- **Tailwind CSS 4** - Styling
- **Socket.IO client** - WebSocket
- **Recharts** - Analytics charts
- **Three.js** - VR video player
- **Lucide React** - Icons

## Project Structure

```
/
|- main.py                          # Root entry point
|- requirements.txt                 # Python dependencies
|- .env                             # Configuration (gitignored)
|- .env.example                     # Config template
|- telegram_downloader.service      # systemd service file
|
|- backend/
|  |- main.py                       # App initialization & thread orchestration
|  |- config/__init__.py            # Environment config (from .env)
|  |- database/__init__.py          # SQLAlchemy models, DatabaseManager, migrations
|  |- web_app/                      # Flask app package (split by concern)
|  |  |- __init__.py                # WebApp class (composes route mixins) + public re-exports
|  |  |- base.py                    # Shared globals (socketio/web_app), JWT token_required
|  |  |- torrent.py                 # Transmission RPC helpers (add/list/session/telegram dirs)
|  |  |- vps.py                     # VPS SSH/SFTP connection helpers
|  |  |- helpers.py                 # Misc helpers (candidate_file_paths)
|  |  '- routes/                    # Per-domain Flask route mixins (auth, downloads, url,
|  |                                #   analytics, settings, vps_settings, torrent, vps_browse, media)
|  |- telegram_handler/__init__.py  # Telethon download handler (~436 lines)
|  |- ytdlp_handler/__init__.py     # yt-dlp subprocess handler (~604 lines)
|  |- vps_handler/__init__.py       # SFTP download handler + hourly autoSync
|  |- utils/__init__.py             # Helpers (resolve_spec, encryption, MIME types)
|  |- file_meta.py                  # Video metadata extraction (ffprobe)
|  |- browser_downloader.py         # Playwright fallback for yt-dlp
|  '- metrics/__init__.py           # Prometheus counters
|
|- frontend/
|  |- package.json
|  |- vite.config.ts
|  '- src/
|     |- main.tsx                   # React entry
|     |- App.tsx                    # Main app, routing
|     |- routes.ts                  # Route constants
|     |- api/
|     |  |- index.ts               # REST API client functions
|     |  '- socket.ts              # WebSocket connection & event handlers
|     |- types/index.ts            # TypeScript interfaces
|     |- utils/format.ts           # Formatting helpers
|     |- pages/
|     |  |- DownloadsPage.tsx       # Main download list
|     |  |- VpsPage.tsx             # VPS file browser (watched folders)
|     |  |- SettingsPage.tsx        # Settings tabs (password/sources/cookies/vps/jobs)
|     |  '- AnalyticsPage.tsx       # Charts & analytics
|     '- components/
|        |- Layout.tsx              # Header, shared downloads state, secured toggle
|        |- DownloadItem.tsx        # Download list item (progress, thumbnails, actions)
|        |- AddUrlModal.tsx         # URL download dialog (formats + magnet handoff)
|        |- SourcesSettings.tsx     # Per-source specs (folder/quality/hidden)
|        |- VpsSettings.tsx         # SSH connection, torrent client, watched folders
|        |- FolderBrowser.tsx       # Reusable remote/local folder picker
|        |- LoginPage.tsx           # JWT auth login
|        |- StatsHeader.tsx         # Stats bar
|        |- VideoPlayerModal.tsx    # Video playback
|        |- VRVideoPlayer.tsx       # Three.js VR player
|        |- Toast.tsx               # Toast notifications
|        |- Tooltip.tsx             # Tooltip component
|        '- ConfirmDialog.tsx       # Confirmation dialog
```

## Database Schema

### Tables

**`downloads`** - Main download tracking
- `id` (PK), `message_id` (UUID or Telegram ID), `file`, `status`, `progress`, `speed`
- `downloaded_bytes`, `total_bytes`, `pending_time`
- `downloaded_from` ('telegram' or domain name like 'youtube.com')
- `url` (source URL for yt-dlp), `author`, `error`
- `file_meta` (JSON: video/audio codec, resolution, bitrate)
- `thumb_count`, `status_msg_id`
- `deleted_at` (soft delete), `file_deleted` (physical file removed)
- `created_at`, `updated_at`

**`settings`** - Key-value store (VPS connection, torrent client config, etc.; secrets Fernet-encrypted)
- `id` (PK), `key` (unique), `value` (text), `updated_at`

**`download_type_maps`** - Per-source download specs
- `id` (PK), `downloaded_from` (unique), `is_secured` (hide from default view), `folder`, `quality`

**`vps_watch_folders`** - Watched VPS folders
- `id` (PK), `path` (remote), `host`/`port`/`username` (owning connection)
- `auto_sync` (hourly auto-download of new files), `folder` (local destination), `is_secured`

**`users`** - Authentication
- `id` (PK), `username` (unique), `password_hash` (SHA-256)
- Default credentials: admin/admin (created on first run)

Note: legacy `labels`/`source_labels` tables and `downloads.label_id` may still exist in older DBs but are unused (the labels feature was reverted; see `_migrate_labels_to_specs()`).

### Migrations
- Handled in `DatabaseManager._run_migrations()` using ALTER TABLE statements
- Inspects existing columns and adds missing ones

## API Routes

### Auth
- `POST /api/auth/login` - Returns JWT (30-day expiry)
- `GET /api/auth/verify` - Validate token
- `POST /api/auth/password` - Change password

### Downloads
- `GET /api/downloads` - List (search, filter, sort, paginate, `include_hidden`); each item is annotated with computed `hidden` + `dest_folder`
- `GET /api/stats` - Aggregate statistics
- `GET /api/authors` - Distinct author list
- `GET /api/analytics` - Time-series & breakdown analytics
- `POST /api/retry` - Retry failed download
- `POST /api/stop` - Stop active download
- `POST /api/pause` / `POST /api/resume` - Telegram only
- `POST /api/delete` - Soft delete

### URL Downloads (yt-dlp)
- `POST /api/url/check` - Check URL & get available formats
- `POST /api/url/download` - Start download with format selection
- `POST /api/jobs/ytdlp-version` / `POST /api/jobs/ytdlp-upgrade`

### Per-Source Specs (Mappings)
- CRUD at `/api/mappings` and `/api/mappings/<id>` (folder, quality, is_secured per source)

### VPS (SSH/SFTP)
- `GET/POST/DELETE /api/settings/vps` - Connection config (password encrypted at rest)
- `POST /api/settings/vps/test` - Test SSH connection
- `POST /api/settings/vps/browse` / `POST /api/settings/local/browse` - Remote/local folder listing
- `GET/POST /api/settings/vps/folders`, `PATCH/DELETE /api/settings/vps/folders/<id>` - Watched folders (PATCH: `auto_sync`, `folder`, `is_secured`)
- `GET /api/vps/files` - Live listing of watched folders
- `POST /api/vps/download` - Download a file/directory to the home server
- `POST /api/vps/delete-remote` - Delete on the VPS

### Torrent Client (Transmission on the VPS)
- `GET/POST/DELETE /api/settings/torrent` - Config (URL normalized to the RPC endpoint, password encrypted; `incomplete_dir` = temp folder for in-progress downloads)
- `POST /api/settings/torrent/test` - session-get connectivity check
- `POST /api/torrent/add` - Send a magnet link (`{magnet, download_dir?}`); RPC helper `transmission_rpc()` handles the 409 session-id handshake
- `GET /api/torrent/list` - Live status of all torrents (name, status label, percent, down/up rate, size, ETA, download dir, error)
- Temp folder: `apply_torrent_session()` pushes `incomplete-dir`/`incomplete-dir-enabled` via `session-set` (applied on config save + re-applied before each add). Transmission downloads into the temp dir, then moves to the torrent's `download-dir` on completion.

### Video Streaming
- `GET /api/video/stream/<id>` - Range-request video streaming
- `GET /api/video/thumbs/<id>` - Thumbnail list
- `GET /api/video/thumb/<id>/<filename>` - Single thumbnail

### Settings
- `GET/POST /api/settings/cookies` - yt-dlp cookies
- `POST /api/jobs/sync-thumbnails` - Regenerate thumbnails

### Monitoring
- `GET /metrics` - Prometheus (no auth)

## WebSocket Events (Backend -> Frontend)

- `download:new` - New download added
- `download:progress` - Progress update (throttled to 1/sec)
  - `{message_id, progress, downloaded_bytes, total_bytes, speed, pending_time}`
- `download:status` - Status change (downloading -> done/failed/stopped)
  - `{message_id, status, error?}`
- `download:deleted` - Soft delete notification
- `stats` - Updated aggregate stats

## Configuration

All config via `.env` file at project root (loaded by python-dotenv):

| Variable | Default | Description |
|----------|---------|-------------|
| `API_ID` | required | Telegram API ID |
| `API_HASH` | required | Telegram API Hash |
| `CHAT_ID` | required | Telegram chat to monitor |
| `DOWNLOAD_DIR` | `./downloads` | Root download directory |
| `WEB_PORT` | `4444` | Web server port |
| `WEB_HOST` | `0.0.0.0` | Web server bind address |
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection string |
| `MAX_RETRIES` | `6` | Download retry attempts |
| `SCREENSHOTS_DIR` | `DOWNLOAD_DIR/.thumbs` | Thumbnail storage |
| `JWT_SECRET` | auto-generated, persisted to `.jwt_secret` | App secret: JWT signing + Fernet key for stored secrets |

## Download Flow

### Telegram Downloads
1. Telethon monitors `CHAT_ID` for new messages with attachments
2. Determines target folder by MIME type (Videos/Images/Documents)
3. Checks `DownloadTypeMap` for custom folder/quality overrides
4. Creates DB record, starts `client.download_media()` with progress callback
5. Emits `download:progress` via WebSocket (throttled 1/sec)
6. On completion: extracts metadata, generates thumbnails, emits `download:status`

### URL Downloads (yt-dlp)
1. Frontend calls `/api/url/check` -> runs `yt-dlp --dump-json --no-download`
2. User selects format, calls `/api/url/download`
3. Backend spawns `asyncio.create_subprocess_exec("yt-dlp", ...)`
4. Parses stdout for progress regex, emits WebSocket updates
5. Tracks in `download_tasks` dict (key: message_id, value: asyncio.Task)

### VPS Downloads (SFTP)
1. VPS page lists watched folders live over SFTP (`/api/vps/files`)
2. `POST /api/vps/download` -> `vps_handler.start_download()` runs the transfer in a daemon thread (paramiko is sync), resuming partial files
3. Destination resolved via `resolve_spec('vps', path=remote_path)`: watched folder's `folder` -> 'vps' source mapping -> `DOWNLOAD_DIR/VPS`
4. autoSync: hourly scan of `auto_sync` folders on the active connection, downloads files that appear after the baseline snapshot

### Magnet Links (Transmission)
1. AddUrlModal detects `magnet:` input -> `POST /api/torrent/add`
2. Backend calls the Transmission RPC API (`transmission_rpc()` in `web_app/torrent.py`) with optional `download-dir` (e.g. a watched folder, so autoSync fetches the result)
3. No local download record is created — the torrent lives on the VPS
4. **Telegram-sourced magnets**: a magnet link posted in a monitored channel is detected in `telegram_handler._handle_new_file()` and handed off via `transmission_add_magnet()`. Routed to `<base>/telegram/downloads` (temp in `<base>/telegram/progress`, derived from Transmission's session download-dir by `transmission_telegram_dirs()`), auto-started, and the bot replies with the torrent name. The per-torrent temp dir is applied right before the add (Transmission's incomplete-dir is session-wide but only affects active torrents). A background task (`_track_torrent_progress`) then polls Transmission (`transmission_get_torrent()`) every 15s and live-edits that reply (`` `name` download progress: xx% ``) until the torrent completes, errors, or is removed (capped at ~12h). On completion the message becomes a "Reply to this message (or react 👍) to download it to DownLee" prompt and the (chat_id, msg_id)→{path,...} is recorded in `_pending_downlee`. **Primary trigger**: replying to that prompt (`_maybe_handle_downlee_reply`, checked at the top of `_handle_new_file`) starts `vps_downloader.start_download()` to pull the completed files VPS→DownLee. A raw reaction handler (`_handle_reaction`, via `events.Raw`) is a secondary 👍 trigger (reaction updates aren't reliably delivered, esp. to bot accounts). After starting, `_track_downlee_progress` polls the transfer's DB record and live-edits the same Telegram message with `xx%` until done/failed.

### Spec Resolution (folder/quality/hidden)
- `backend/utils.resolve_spec(source, path=None)` reads `download_type_maps` (+ longest-prefix `vps_watch_folders` match for VPS paths)
- `hidden` is computed at query time in `WebApp._annotate_downloads()` — never stamped on downloads, so spec changes apply retroactively

## Key Patterns

- **Shared state**: `download_tasks = {}` dict passed to all handlers
- **WebSocket broadcast**: `get_socketio().emit(event, data)` from any module
- **Soft deletes**: `deleted_at` timestamp, never hard delete
- **Progress throttling**: 1-second minimum interval between updates
- **JWT auth**: All API routes use `@token_required` decorator (except `/metrics`)
- **Frontend serves from Flask**: Built `frontend/dist/` served as static files

## Development Commands

```bash
# Backend
source venv/bin/activate
python main.py

# Frontend
cd frontend
npm install
npm run dev          # Dev server (hot reload)
npm run build        # Build to frontend/dist/

# Service
sudo systemctl start telegram_downloader
sudo systemctl status telegram_downloader
```

## Deployment

- Runs as systemd service (`telegram_downloader.service`)
- User: `hs`, WorkingDirectory: `/home/hs/telegram-auto-downloader`
- Uses virtualenv at `./venv/`
- Frontend must be pre-built (`npm run build`) - Flask serves the dist

## Adding New Download Sources

To add a new download source (pattern established by telegram_handler and ytdlp_handler):

1. Create `backend/<source>_handler/__init__.py`
2. Implement download logic with progress tracking
3. Use `get_socketio().emit()` for real-time updates
4. Create DB records via `DatabaseManager` with appropriate `downloaded_from` value
5. Add API routes in `web_app/__init__.py` or a new blueprint
6. Wire into `backend/main.py` thread orchestration
7. Add frontend components and API client functions

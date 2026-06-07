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
|  |- web_app/__init__.py           # Flask routes, WebSocket, JWT auth (~1258 lines)
|  |- telegram_handler/__init__.py  # Telethon download handler (~436 lines)
|  |- ytdlp_handler/__init__.py     # yt-dlp subprocess handler (~604 lines)
|  |- utils/__init__.py             # Helpers (formatBytes, MIME types)
|  |- file_meta.py                  # Video metadata extraction (ffprobe)
|  |- browser_downloader.py         # Playwright fallback for yt-dlp
|  '- metrics/__init__.py           # Prometheus counters
|
|- frontend/
|  |- package.json
|  |- vite.config.ts
|  '- src/
|     |- main.tsx                   # React entry
|     |- App.tsx                    # Main app, state, routing
|     |- api/
|     |  |- index.ts               # REST API client functions
|     |  '- socket.ts              # WebSocket connection & event handlers
|     |- types/index.ts            # TypeScript interfaces
|     |- utils/format.ts           # Formatting helpers
|     '- components/
|        |- DownloadItem.tsx        # Download list item (progress, thumbnails, actions)
|        |- AddUrlModal.tsx         # URL download dialog (format selection)
|        |- SettingsDialog.tsx      # Settings (mappings, cookies, yt-dlp management)
|        |- AnalyticsPage.tsx       # Charts & analytics
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

**`settings`** - Key-value store (cookies, etc.)
- `id` (PK), `key` (unique), `value` (text), `updated_at`

**`download_type_maps`** - Per-source folder & quality mappings
- `id` (PK), `downloaded_from` (unique), `is_secured`, `folder`, `quality`

**`users`** - Authentication
- `id` (PK), `username` (unique), `password_hash` (SHA-256)
- Default credentials: admin/admin (created on first run)

### Migrations
- Handled in `DatabaseManager._run_migrations()` using ALTER TABLE statements
- Inspects existing columns and adds missing ones

## API Routes

### Auth
- `POST /api/auth/login` - Returns JWT (30-day expiry)
- `GET /api/auth/verify` - Validate token
- `POST /api/auth/password` - Change password

### Downloads
- `GET /api/downloads` - List (search, filter, sort, paginate)
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

### Download Type Mappings
- CRUD at `/api/mappings` and `/api/mappings/<id>`
- `/api/mappings/secured` and `/api/mappings/secured-ids`

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
| `JWT_SECRET` | hardcoded fallback | JWT signing key |

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

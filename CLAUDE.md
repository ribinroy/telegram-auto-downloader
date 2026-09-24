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
  |- Job scheduler (daemon) ......... fires due maintenance jobs (backend/jobs.py)
  |- Network watchdog (daemon) ...... resumes downloads the uplink interrupted
  |- Torrent watcher (daemon) ....... stops completed torrents from seeding
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
|  |  |- torrent.py                 # Client-agnostic torrent dispatchers + Transmission backend (add/list/session/telegram dirs)
|  |  |- qbittorrent.py             # qBittorrent WebUI API v2 backend (stdlib urllib + cookiejar)
|  |  |- vps.py                     # VPS SSH/SFTP connection helpers
|  |  |- helpers.py                 # Misc helpers (candidate_file_paths)
|  |  '- routes/                    # Per-domain Flask route mixins (auth, downloads, url,
|  |                                #   analytics, settings, vps_settings, torrent, vps_browse, media,
|  |                                #   rename_rules, files)
|  |- telegram_handler/__init__.py  # Telethon download handler (~436 lines)
|  |- ytdlp_handler/__init__.py     # yt-dlp subprocess handler (~604 lines)
|  |- vps_handler/__init__.py       # SFTP download handler + hourly autoSync
|  |- utils/__init__.py             # Helpers (resolve_spec, encryption, MIME types)
|  |- files.py                      # Filesystem service for the file explorer (mounts, listing, ops, thumbs)
|  |- remote_files.py               # The VPS as a second explorer drive, over SFTP (`vps:` paths)
|  |- jobs.py                       # Maintenance job bodies + schedule store + JobScheduler thread
|  |- logsafe.py                    # Log redaction filter + rotating, owner-only log handler
|  |- netwatch.py                   # Connectivity probe + stall sweep -> resumes interrupted downloads
|  |- torrent_watch.py              # Polls the torrent clients; stops finished torrents from seeding
|  |- resume.py                     # Single resume path shared by /api/retry and the watchdog
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
|     |  |- files.ts               # File explorer transport + media URL builders
|     |  '- socket.ts              # WebSocket connection & event handlers
|     |- types/index.ts            # TypeScript interfaces
|     |- utils/format.ts           # Formatting helpers
|     |- pages/
|     |  |- DownloadsPage.tsx       # Main download list
|     |  |- VpsPage.tsx             # VPS file browser (watched folders)
|     |  |- ExplorerPage.tsx        # Local file explorer (all disks, live)
|     |  |- SettingsPage.tsx        # Settings tabs (password/sources/cookies/vps/jobs)
|     |  '- AnalyticsPage.tsx       # Charts & analytics
|     '- components/
|        |- Layout.tsx              # Header, shared downloads state, secured toggle
|        |- DownloadItem.tsx        # Download list item (progress, thumbnails, actions)
|        |- AddUrlModal.tsx         # URL download dialog (formats + magnet handoff)
|        |- SourcesSettings.tsx     # Per-source specs (folder/quality/hidden)
|        |- VpsSettings.tsx         # SSH connection, torrent client, watched folders
|        |- FolderBrowser.tsx       # Reusable remote/local folder picker
|        |- explorer/               # File explorer: Sidebar, Toolbar, FileList,
|        |                          #   ContextMenu, PreviewModal, PropertiesModal
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
- `dest_base` (destination folder a VPS transfer was started with, when it isn't derivable from the source spec - e.g. a torrent client's `local_dir`; a resume reads it back so it can't restart into the wrong folder)
- `deleted_at` (soft delete), `file_deleted` (physical file removed)
- `created_at`, `updated_at`

**`settings`** - Key-value store (VPS connection, torrent client config, etc.; secrets Fernet-encrypted)
- `id` (PK), `key` (unique), `value` (text), `updated_at`

**`download_type_maps`** - Per-source download specs
- `id` (PK), `downloaded_from` (unique), `is_secured` (hide from default view), `folder`, `quality`

**`vps_watch_folders`** - Watched VPS folders
- `id` (PK), `path` (remote), `host`/`port`/`username` (owning connection)
- `auto_sync` (hourly auto-download of new files), `folder` (local destination), `is_secured`

**`rename_rules`** - Filename rewrite rules
- `id` (PK), `name`, `pattern` (regex), `replacement`, `enabled`, `position` (lower runs first)
- `source` (limit to one `downloaded_from`; NULL = all), `stop_on_match`

**`users`** - Authentication
- `id` (PK), `username` (unique), `password_hash` (bcrypt; legacy SHA-256 auto-upgraded on login)
- `token_version` - bumped to invalidate every outstanding access token
- Default credentials: admin/admin (created on first run, forced change)

**`user_sessions`** - One row per signed-in device (refresh-token backing)
- `id` (PK), `user_id`, `refresh_jti` (unique, rotated on each use), `expires_at`, `revoked_at`
- `user_agent`, `ip`, `created_at`, `last_used_at`

Note: legacy `labels`/`source_labels` tables and `downloads.label_id` may still exist in older DBs but are unused (the labels feature was reverted; see `_migrate_labels_to_specs()`).

### Migrations
- Handled in `DatabaseManager._run_migrations()` using ALTER TABLE statements
- Inspects existing columns and adds missing ones

## API Routes

### Auth
Access/refresh token pair. Access tokens are short (`ACCESS_TOKEN_MINUTES`, default 30) and carry a `tv` claim compared against `users.token_version` on every request, so revocation is instant. Refresh tokens (`REFRESH_TOKEN_DAYS`, default 30) are backed by a `user_sessions` row and rotate on each use; replaying a superseded one revokes the session (theft detection). Passwords are bcrypt (cost 12, SHA-256 pre-hash), with legacy SHA-256 digests upgraded transparently on next successful login.
- `POST /api/auth/login` - `{token, refresh_token, expires_in, user, must_change_password}`; rate limited per IP + username (`web_app/ratelimit.py`)
- `POST /api/auth/refresh` - Rotate; returns a new pair
- `POST /api/auth/logout` - Revoke this session (takes `refresh_token`)
- `POST /api/auth/logout-all` - Bump `token_version` + revoke all sessions
- `GET /api/auth/sessions` / `DELETE /api/auth/sessions/<id>` - Active devices
- `GET /api/auth/media-token` - `typ:'media'` token, valid only on the stream/thumb routes (`media_token_required`), so no API token ends up in a URL
- `GET /api/auth/verify` - Validate token
- `POST /api/auth/password` - Change password (min 8 chars; bumps `token_version`, revokes other sessions, returns a fresh pair)

### Downloads
- `GET /api/downloads` - List (search, filter, sort, paginate, `include_hidden`); each item is annotated with computed `hidden` + `dest_folder`
- `GET /api/stats` - Aggregate statistics
- `GET /api/authors` - Distinct author list
- `GET /api/analytics` - Time-series & breakdown analytics
- `POST /api/retry` - Restart a failed/stopped download from the bytes on disk (via `backend/resume.py`; 400/404/500 carry the reason)
- `POST /api/stop` - Stop active download
- `POST /api/pause` / `POST /api/resume` - Telegram only
- `POST /api/delete` - Soft delete

### Rename Rules
- `GET/POST /api/settings/rename-rules`, `PUT/DELETE /api/settings/rename-rules/<id>`, `POST .../reorder`
- `POST /api/settings/rename-rules/test` - Preview against real filenames; pass `rule` to preview an unsaved draft alone
- `POST /api/settings/rename-rules/apply` - `{dry_run}`; defaults to a dry run returning the full before/after plan

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
- `GET /api/vps/usage` - Seedbox usage, cached 60s (`?refresh=1` bypasses). Two different things, which the UI must not blur: **the account** (`disk` - the per-user `quota -w` figure a seedbox actually bills against, falling back to `df` when no quota is set; `traffic`/`clients` - the torrent clients' own cumulative counters) and **the shared machine** (`server.volume`/`load`/`net`, every tenant combined). Per-account traffic is not exposed on a seedhost box at all (no vnstat, no accounting file), so the client counters are the closest honest substitute and are labelled as such. One SSH session runs every probe (`vps_usage_snapshot()` in `web_app/vps.py`, marker-split output). `net` counters are since boot, so `rx_rate`/`tx_rate` come from the delta against the previous poll - absent on the first call, and skipped if the counters went backwards (reboot) or the window is under 5s. UI: `components/VpsUsageBar.tsx`, a strip above the VPS page tabs - quota bar + up/down totals, with the per-client split and the muted server-health row behind a chevron.
- `POST /api/vps/download` - Download a file/directory to the home server
- `POST /api/vps/delete-remote` - Delete on the VPS

### Torrent Clients (Transmission + qBittorrent on the VPS)
- **Both clients are configurable and live simultaneously.** Config is a nested `torrent_config` setting: `{transmission:{url,username,password_enc,download_dir,incomplete_dir,local_dir,stop_on_complete}, qbittorrent:{...}, telegram_default}`. A legacy flat Transmission config auto-migrates on read (`read_torrent_settings()` in `web_app/torrent.py`).
- `web_app/torrent.py` provides **client-agnostic dispatchers** (`torrent_test/add_magnet/list/control/get/set_location/telegram_dirs`, `apply_torrent_session`) that take an explicit client and route to the Transmission backend (in the same file) or the qBittorrent backend (`web_app/qbittorrent.py`). Everything keys torrents by **hash** (Transmission RPC accepts hashes as `ids`; qBittorrent is hash-native), so one code path drives both.
- `GET /api/settings/torrent` - Both clients' config (passwords never exposed) + `telegram_default`
- `POST /api/settings/torrent` - Save one client (`{client, url, username, password?, download_dir?, incomplete_dir?}`); Transmission URL normalized to the RPC endpoint, qBittorrent uses the base WebUI URL; password encrypted at rest
- `DELETE /api/settings/torrent?client=...` / `POST /api/settings/torrent/telegram-default` (`{client|null}`)
- `POST /api/settings/torrent/test` - `{client, ...}` connectivity check (Transmission session-get / qBittorrent version)
- `POST /api/torrent/add` - Send a magnet (`{magnet, client, download_dir?}`); falls back to the client's configured `download_dir` when none given
- `GET /api/torrent/list?client=...` - Live status of that client's torrents (normalized shape: name, hash, status label, percent, down/up rate, size, ETA, download dir, error, peers/seeds, `force_start`). **`completed` is a distinct status from `stopped`**: a finished torrent that is no longer seeding is done, not paused, and with the torrent watcher stopping seeds on completion that is the normal end state - labelling it "Paused" reads like something went wrong. qBittorrent already draws the line (`stoppedUP`/`pausedUP` vs `stoppedDL`/`pausedDL`); Transmission reports one `stopped` for both, so `_transmission_normalize()` derives it from the percentage plus `downlee` - the VPS→DownLee transfer that already pulled it (`{id, message_id, status, progress}` or null), matched on `<download_dir>/<name>` with a basename fallback (a Telegram-flow pull may have been taken from the temp dir). The VPS panel uses it to show **Downloaded** / live % / a retry instead of offering the pull again, so the state survives a reload.
- `POST /api/torrent/action` - `{client, action:start|force-start|stop|remove|verify, hashes:[str], delete_data?}` (legacy `ids` still accepted as hashes). **`force-start`** jumps the client's own download queue - Transmission `torrent-start-now` instead of `torrent-start`, qBittorrent `setForceStart` (a per-torrent flag, not a verb, so it is set and then the torrent is started). A plain start only queues a torrent, which on a busy seedbox looks like nothing happened. The panel offers it per row (⚡, hidden once a torrent is complete - there it would only force seeding) and for a bulk selection.
  **Order matters on qBittorrent**: a plain start *clears* the force flag, so the backend starts first (covering a stopped torrent) and forces after - doing it the other way round is a silent no-op. That same fact makes the button a toggle: a forced torrent's ⚡ sends a plain `start` to un-force it.
  The normalized shape carries `force_start` - qBittorrent reports it per torrent (plus the `forcedDL`/`forcedUP` states as a second witness), while Transmission has **no persistent forced flag** (`torrent-start-now` jumps the queue once and nothing records it), so it is `None` there. The UI only lights up on `=== true`: null is "can't tell", not "not forced". A forced row also gets a "Forced" badge, since the status label still just reads "downloading", and the panel's status dropdown carries a **`Forced (n)`** entry (reserved value `@forced`, so it can't collide with a real status) to list just those - shown only when there are any, which means never on Transmission.
- **`To be downloaded (n)`** (reserved value `@todo`) is the other pseudo-status: finished on the VPS but not yet pulled to DownLee - the queue of things still to fetch. A failed or stopped transfer counts, because the file still is not here. `downleeState()` derives the transfer state (server's `downlee` match, overridden by the WebSocket-fed downloads list while a pull runs) and `isPendingPull()` the predicate; both the filter and the row read them, so the count and what the row shows cannot drift.
- `POST /api/settings/torrent/stop-on-complete` - `{client, enabled}`; its own route so the toggle doesn't round-trip (and risk clobbering) the whole client config
- Temp folder: `apply_torrent_session()` pushes the incomplete/temp dir (Transmission `session-set incomplete-dir`; qBittorrent `setPreferences temp_path`), applied on config save + re-applied before each add. The client downloads into the temp dir, then moves to the torrent's download dir on completion.
- Frontend: Settings → VPS shows a `TorrentClientCard` per client; the VPS page has per-client tabs (Files · Transmission · qBittorrent), each its own `TorrentStatusPanel` (hash-based multi-select). Pasted magnets pick the client in `AddUrlModal`.

#### Torrent watcher (stop seeding on completion)

`backend/torrent_watch.py` is a daemon thread (started in `backend/main.py`)
that polls every configured client each `TORRENT_WATCH_INTERVAL` (30s) and
stops any torrent that has finished. It exists because a seedbox keeps every
completed torrent uploading by default, and once the files are pulled to
DownLee that upload is only spending the VPS's bandwidth.

- **It waits for `seeding`/`seed-wait`, never the raw percentage.** Both clients
  download into a temp dir and move the files as part of completing; during that
  move the torrent is not seeding yet (qBittorrent reports `moving`, normalized
  to `checking`). Acting on `percent_done >= 100` would race the move, and the
  VPS→DownLee pull would then chase files in flight between two directories.
- **It stops a given torrent once.** The `(client, hash)` pairs it has acted on
  are held in memory, so restarting a completed torrent by hand sticks instead
  of being undone on the next tick. The set is intersected with what each poll
  saw, so removed torrents don't accumulate.
- **Per-client, because seeding is a tracker requirement.** `stop_on_complete`
  lives in each client's sub-config (`stop_on_complete_enabled()` in
  `web_app/torrent.py`, **default on**), toggled on the `TorrentClientCard` in
  Settings → VPS. A full config save carries the flag over rather than resetting
  it. `TORRENT_WATCH=0` disables the thread outright.
- A client being unreachable is logged at debug and retried next tick; a failed
  stop is not marked handled, so it is retried too.

### Scheduled Jobs

Maintenance jobs can run unattended on a time of day plus a set of weekdays.
`backend/jobs.py` owns all of it; `backend/main.py` starts a `JobScheduler`
daemon thread alongside the Flask/asyncio/VPS threads.

- **The job bodies live in `jobs.py`, not in the route.** `run_job(job_id)` backs
  both the "Run now" button and a scheduled run, so the two can never drift -
  a scheduled job behaving differently from its manual twin would be a miserable
  bug to chase. `JOBS` maps id -> `{label, run, summarize}`; adding a job means
  adding an entry there and rendering `<JobSchedule jobId=...>` next to its button.
- **Schedules are one JSON blob** in the settings table (`job_schedules`), keyed
  by job id: `{enabled, time 'HH:MM', days [0-6], last_run, last_status,
  last_summary, armed_at}`. Monday = 0, matching `datetime.weekday()`. Times are
  the **server's** local wall clock (the API returns `tz` so the UI can say which).
- **Catch-up**: a slot missed while the service was down runs on the next tick
  after startup. On a home server, "the 3 AM sweep never happened because you
  rebooted at 2:55" is worse than it running late.
- **`armed_at` vs `last_run`**: every save marks an already-passed slot as handled,
  so enabling a job at 22:00 with a 03:00 time (or moving the time earlier) waits
  for tomorrow instead of firing on the spot. That marker is deliberately *not*
  `last_run`, which would make the UI report a run that never happened.
- The scheduler ticks every 30s, survives a failing job (logged, recorded as
  `last_status: 'error'`, other jobs still run), and records every outcome.
- UI: `components/JobSchedule.tsx` under each job in Settings -> Jobs - a toggle,
  a `<input type="time">`, seven day chips, and next/last run. Every control saves
  on change; the server echoes back the recomputed next run.

## File Explorer (local disks)
Live filesystem access - every call reads the disk, nothing is indexed or cached.
- `GET /api/files/roots` - Sidebar places, grouped `drive` / `folder` / `configured`: every real mount from `/proc/mounts` with live capacity, then Home + `DOWNLOAD_DIR`, then DownLee's own destination folders (source mappings, VPS watch-folder destinations, torrent `local_dir`); `?include_hidden=true` includes secured ones
- `POST /api/files/list` - `{path?, show_hidden?}` -> entries + `writable`, `usage`, `mount`, `trash`
- `POST /api/files/mkdir` / `rename` / `delete` (`{paths, permanent?}`) / `transfer` (`{paths, dest, move}`) / `upload` (multipart)
- `POST /api/files/search` (recursive, capped by results **and** a wall-clock deadline), `POST /api/files/size` (on-demand `du`), `POST /api/files/text` (preview head)
- `GET /api/files/stream|download|thumb?path=` - `@media_token_required`, range-streamed; `thumb` is a cached JPEG (Pillow for images, an ffmpeg frame grab for video)

### Video Streaming
- `GET /api/video/check/<id>` - What is on disk for a download: `{exists, kind: 'video'|'dir'|'file', path, parent, size}`. The downloads list's view button uses `kind` to decide - play a video inline, or send a folder pull / non-video file to the file explorer (`/files?path=...`, plus `&select=<path>` for a single file, which `ExplorerPage` highlights and scrolls to, then drops). Keeps `file_deleted` honest for folders too, which the old video-only check always marked as missing.
- `GET /api/video/stream/<id>` - Range-request video streaming
- `GET /api/video/thumbs/<id>` - Thumbnail list
- `GET /api/video/thumb/<id>/<filename>` - Single thumbnail

### Settings
- `GET/POST /api/settings/cookies` - yt-dlp cookies
- `POST /api/jobs/sync-thumbnails` - Regenerate download thumbnails, clean orphans, and prune the file explorer's thumbnail cache
- `GET /api/jobs/schedules` - Every job with its schedule, last outcome and next fire time (plus the server's `tz`)
- `PUT /api/jobs/schedules/<job_id>` - `{enabled?, time? 'HH:MM', days?: [0-6]}` (Monday = 0)

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
| `EXPLORER_READONLY` | `0` | Refuse every file-explorer write (rename/delete/move/copy/upload/mkdir) |
| `NET_WATCHDOG` | `1` | Resume downloads the network interrupted (see below) |
| `NET_PROBE_INTERVAL` | `20` | Seconds between connectivity probes |
| `NET_STALL_SECONDS` | `600` | Restart a download frozen this long; `0` disables |
| `NET_PROBE_HOSTS` | `1.1.1.1:53,8.8.8.8:53` | `host:port` pairs the probe TCP-connects to |
| `TORRENT_WATCH` | `1` | Run the torrent watcher thread (stop seeding on completion) |
| `TORRENT_WATCH_INTERVAL` | `30` | Seconds between torrent-client polls |

## Network Watchdog & Resume

A home uplink drops for ten seconds and nothing recovers on its own. Each
handler fails differently - Telethon burns its retry budget and the record goes
`failed`, a yt-dlp subprocess exits, an SFTP transfer dies on a socket error -
and the worst case is silent: the TCP connection is gone but nothing raises, so
the transfer sits at 47% forever. That is what "the downloads look paused" is.

- **`backend/resume.py` is the single resume path.** `resume_download(download,
  force)` dispatches to the owning handler; `/api/retry` and the watchdog both
  call it, so an automatic recovery can't drift from the button. Everything
  resumes from the bytes already on disk (Telethon seeks past the partial file,
  yt-dlp runs with `-c`, SFTP resumes at the local size).
- **`force` is the difference between dead and wedged.** Without it a transfer
  still registered as running is left alone; with it the in-flight task is
  cancelled *and awaited* before the replacement starts - skipping that wait
  gives you two writers on one partial file, or lets the old task's cleanup
  deregister the new download.
- **`backend/netwatch.py`** is a daemon thread (started in `backend/main.py`
  alongside the Flask/asyncio/VPS/job threads) doing two things, both on
  observed trouble rather than guesswork:
  - *Reconnects*: TCP-probes `NET_PROBE_HOSTS` every `NET_PROBE_INTERVAL`. On
    the link dropping it snapshots every running download's byte count; on it
    returning it waits `RECONNECT_GRACE` (30s - Telethon often recovers by
    itself) and then resumes the ones that failed or never moved again.
  - *Restarts*: a service or machine restart leaves every in-flight download
    marked `downloading` with nothing behind it - the process that was
    transferring is gone, so the row sits at its last percentage looking
    paused. On the first online tick those orphans are resumed. Telethon may
    still be connecting, so a Telegram one is retried across
    `STARTUP_RESUME_ATTEMPTS` ticks and only then marked `failed` - an honest
    failure with a retry button beats a row that claims to be downloading
    forever. Resuming without `force` is safe for a download a user started
    seconds earlier: every handler reports "already running" and declines.
  - *Stalls*: a download still marked `downloading` whose byte count hasn't
    changed for `NET_STALL_SECONDS` is force-restarted. A blip shorter than the
    probe interval never registers as an outage but still kills the socket -
    the common case. Downloads past 99% are skipped (yt-dlp muxing moves no
    bytes for minutes on a big file).
- **`stopped` and `paused` are decisions, not failures**, and are never
  auto-resumed.
- Supporting fixes, all aimed at failing *fast* instead of hanging: the SFTP
  transport sets a 30s keepalive, yt-dlp runs with `--socket-timeout 30` plus
  explicit retries, and the Telegram per-attempt backoff grew from a flat 5s to
  5/10/20/40/60s so `MAX_RETRIES` isn't burnt inside half a minute.

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

### Magnet Links (Transmission / qBittorrent)
1. AddUrlModal detects `magnet:` input -> user picks the target client -> `POST /api/torrent/add` (`{magnet, client, download_dir?}`)
1b. A `.torrent` file reaches the same panel two ways: the modal's upload button, or **dropping the file anywhere on the downloads page** (window-level drag listeners in `DownloadsPage`, with a depth-counted overlay; non-`.torrent` drops flash a rejection instead of letting the browser navigate to the file). **Multiple files at once** are taken: every `.torrent` in the drop is collected (and the upload button is `multiple`), handed to the modal as `initialFiles` — keyed on the array, so a second drop onto an open modal replaces the batch — and posted to `POST /api/torrent/add-file` (multipart) **serially**, one file per request. Each add is an upload plus a client round-trip, and firing ten at a seedbox WebUI at once is a good way to get some rejected. Each file gets its own row (sending / sent / already added / error) and a failure never abandons the rest of the batch; pressing send again retries only the failed ones. A `batchRunning` flag backs the disabled state because the mutation's `isPending` goes false *between* files, which would otherwise re-enable the button mid-batch and allow a parallel run.
2. Backend dispatches via `torrent_add_magnet(client, ...)` (Transmission RPC or qBittorrent WebUI) with optional `download-dir` (e.g. a watched folder, so autoSync fetches the result)
3. No local download record is created — the torrent lives on the VPS
4. **Telegram-sourced magnets**: a magnet link posted in a monitored channel is detected in `telegram_handler._handle_new_file()` and handed off to the client resolved by **`torrent_client_for_chat(event.chat_id)`** — the channel's own `torrent_client` (stored per-channel in the `telegram_channels` settings JSON, set via `PATCH /api/settings/telegram/channels/<id>`) if set, else the global **`telegram_default`** fallback (`get_telegram_default()`); if neither is set the bot replies that no client is configured. Routed via `torrent_telegram_dirs(client)` to `<base>/telegram/downloads` (temp in `<base>/telegram/progress`), where `<base>` is the client's configured `download_dir` (or, if blank, a sibling of the client's own default download dir), auto-started, and the bot replies with the torrent name. The per-torrent temp dir is applied right before the add. A background task (`_track_torrent_progress`, given the client) polls the client (`torrent_get()`) every 15s and live-edits that reply (`` `name` download progress: xx% ``) until the torrent completes, errors, or is removed (capped at ~12h). On completion the message becomes a `Reply "download" to this message to download it to DownLee` prompt and the (chat_id, msg_id)→{candidates,...} is recorded in `_pending_downlee`. Replying "download" to that prompt (`_maybe_handle_downlee_reply`, checked at the top of `_handle_new_file`) starts `vps_downloader.start_download()` to pull the completed files VPS→DownLee. On completion the tracker also issues `torrent_set_location()` (move) to force files out of the temp dir, and the DownLee trigger resolves the real remote path over SFTP (`_resolve_existing_remote` tries the final dir then the temp dir) so it works whether or not the client moved the files. The torrent's live name is used, since a magnet's name is a placeholder until metadata arrives. (Replies are used rather than reactions — reaction updates aren't reliably delivered, esp. to bot accounts.) After starting, `_track_downlee_progress` polls the transfer's DB record and live-edits the same Telegram message with `xx%` until done/failed.

### Spec Resolution (folder/quality/hidden)
- `backend/utils.resolve_spec(source, path=None)` reads `download_type_maps` (+ longest-prefix `vps_watch_folders` match for VPS paths)
- `hidden` is computed at query time in `WebApp._annotate_downloads()` — never stamped on downloads, so spec changes apply retroactively

## Frontend Data Layer (TanStack Query)

All API access goes through **React Query** (`@tanstack/react-query`):
- Singleton client in `frontend/src/lib/queryClient.ts` (global `staleTime` 5 min, `gcTime` 10 min, `refetchOnWindowFocus` false, `retry` 1); provider in `main.tsx`.
- Central key registry `frontend/src/api/queryKeys.ts` (`qk.*`). Mutations invalidate by **prefix** (`['torrent']`, `['vps']`, `['telegram']`, `['downloads']`) so a change refreshes every dependent screen.
- Per-domain hooks in `frontend/src/hooks/` (`useDownloads`, `useTorrents`, `useVps`, `useTelegram`, `useSettings`, `useMisc`) wrap the `api/index.ts` fetchers — queries via `useQuery`/`useInfiniteQuery`, writes via `useMutation` with `onSuccess` invalidation. `api/index.ts` remains the transport layer.
- **Realtime** (`hooks/useRealtime.ts`, mounted once in `Layout`): Socket.IO events **patch the query cache** via `setQueryData` (no refetch) — `download:new/progress/status/deleted/meta` update the `['downloads']` infinite-query pages; `stats` updates `qk.stats()`; a (re)connect invalidates once to resync.
- Live panels use `refetchInterval` (torrent list 20s) instead of `setInterval`.
- Imperative/on-demand calls stay direct (FolderBrowser `browseVps`/`browseLocal`, `checkVideoFile`, URL builders, `setToken`).

## PWA

The frontend is an installable PWA. `frontend/vite.config.ts` holds a small build-time plugin (`serviceWorker()`) that emits `dist/sw.js` with the real content-hashed precache list and a cache name derived from it. Strategies: `/api`, `/socket.io` and `/metrics` are never cached (auth, live progress, range-request video); navigations are network-first with the cached shell as offline fallback; `/assets/*` is cache-first (immutable); everything else same-origin is stale-while-revalidate.

Registration lives in `frontend/src/lib/pwa.ts` (skipped in dev). A waiting worker fires `downlee:update-ready`; `Layout` shows a Reload pill rather than auto-refreshing. Manifest + icons are in `frontend/public/` (regenerate icons from `logo.png`). Flask sets the cache headers and the `.webmanifest` MIME type in `WebApp.setup_routes`.

## Rename Rules

User-defined regexes rewrite a download's filename **before the transfer starts**, so files are written under their final name from the first byte — nothing is renamed mid-flight and no partial file is orphaned under an old name. `backend/rename.py` owns the engine; `rename_rules` table holds the rules (pattern, replacement, enabled, position, optional `source`, `stop_on_match`).

- **Rules match the stem only.** The extension is split off and reattached, so the natural `(?<=\w)[._](?=\w)` "dots to spaces" rule can't turn `Movie.mkv` into `Movie mkv`.
- `rename_for_download(name, source)` is the handler entry point: never raises, and **always sanitizes** — the input is a Telegram attachment name, a remote SFTP basename or a yt-dlp title, all attacker-influenced and all joined onto a directory.
- Applied at three points, each before any byte is written: `telegram_handler._handle_new_file` (before `open(path)`), `vps_handler.start_download` (threaded through `_local_destination(local_name=...)`, which renames the *top-level* item so a directory pull becomes `Show S01/ep01.mkv`), and `ytdlp_handler.start_download` (before the `-o` template, so yt-dlp's own `.part` already carries the final name).
- Compiled rules are cached against `get_rename_rules_token()`; edits call `invalidate_rules_cache()`. Patterns are validated on save (regex + replacement backrefs) and run under a 2s timeout, since a user regex can backtrack catastrophically.
- `apply_to_existing(dry_run)` replays the chain over **completed downloads only**, so it can never race a running transfer. Collisions resolve via `unique_name()` (" (2)") rather than aborting the batch.

Routes in `web_app/routes/rename_rules.py`; UI in `frontend/src/components/RenameRulesSettings.tsx` (Settings → Renaming), which previews rules against real filenames from the library and requires a dry run before it will touch anything.

## File Explorer

A real file manager over the home server's own disks, at `/files` (`ExplorerPage`).
Everything is read **live from disk on every request** - there is no index, no DB
table and no cache, so a file dropped in over SMB shows up on the next listing and
a pulled USB drive disappears from the sidebar.

- `backend/files.py` is the whole filesystem layer: mounts, listings, mutations,
  search, sizes, thumbnails. `web_app/routes/files.py` is transport only - parse,
  dispatch, map `FsError` to a status code.
- **Roots** are grouped for the sidebar. `drive`: every real mount from
  `/proc/mounts` (minus pseudo filesystems, snap loop mounts and OS partitions),
  each with live `shutil.disk_usage` drawn as a capacity bar. `folder`: Home and
  `DOWNLOAD_DIR`. `configured`: the destinations the rest of DownLee writes to -
  per-source mapping folders, VPS watched-folder destinations, a torrent client's
  `local_dir` - assembled in the route (`_configured_roots()`), which has the DB
  at hand, so `files.py` stays pure filesystem. Folders that no longer exist are
  dropped, duplicates merge and list what points at them ("youtube.com, vimeo.com").
  Destinations of `is_secured` sources/watched folders are omitted unless
  `?include_hidden=true` (the page passes the Layout's `showSecured`), and a
  folder that a plain source also points at still shows but drops the secured
  name from its note. The sidebar marks two things, not one: the root you are
  *at* (exact path, bright accent) and the root you are *inside* (longest path
  prefix, dim accent), resolved per group - so a folder deep on a disk lights up
  both its drive and the DownLee folder pointing there. Exact matches win the
  prefix contest first, otherwise standing on a mount point would highlight `/`.
- **Reads go anywhere** the service account can reach. **Writes** go through
  `guard_write()`: anything on a mount other than `/` is fair game (that is where
  a media library lives), while `PROTECTED_ROOTS` on the root filesystem
  (`/usr`, `/etc`, `/boot`, ...) is refused. `guard_target()` additionally refuses
  to unlink or rename a mount point itself. `EXPLORER_READONLY=1` refuses every
  write outright.
- **Delete is a trash move by default**, into `<mount>/.downlee-trash` - per mount,
  so it stays a rename instead of copying 50 GB across drives, and stays
  recoverable. Root-filesystem deletes park in `BASE_DIR/.trash`. `permanent: true`
  unlinks for real. The trash path is reported by `/api/files/list` (only once it
  exists) and linked in the sidebar.
- **Bounded work**: recursive search and folder sizes both stop on a wall-clock
  deadline as well as a result cap, because "search from the root of a 20 TB array"
  is a reasonable thing to ask a web request to do exactly once.
- **Thumbnails** (`/api/files/thumb`) are cached under `SCREENSHOTS_DIR/.explorer`,
  keyed by `(path, mtime, size)` so replacing a file in place invalidates its own
  thumbnail. That name is a one-way hash, so each `<sha1>.jpg` gets a `<sha1>.json`
  sidecar naming its source - without it nothing could ever tell a live entry from
  a dead one. `prune_thumb_cache()`, run by `POST /api/jobs/sync-thumbnails`
  (`explorer_pruned`/`explorer_kept`/`explorer_freed` in its stats), drops every
  thumbnail whose source is gone, moved or changed, plus any entry with no sidecar
  and any sidecar with no thumbnail. Images go through Pillow; videos get an ffmpeg frame grab (~1s each),
  which is why they are only requested in **grid** view - a 500-file list would
  otherwise start 500 ffmpeg processes.
- **Streaming/download by path** reuse `helpers.range_response()` (shared with the
  per-download video route) and sit behind `@media_token_required`, so no API token
  ever lands in a URL.
- Frontend: `hooks/useFiles.ts` (React Query, `staleTime: 0` - a disk is always
  stale; every mutation invalidates the whole `['files']` tree), `api/files.ts`
  transport, and `components/explorer/*`. `ExplorerSidebar` renders bare content;
  the page supplies the chrome - a pinned 64-wide column at `lg`, a hamburger
  drawer below it (kept mounted so it slides, `inert` while closed), since stacked
  above the list it ate the top of every folder on a phone. Below `sm` the toolbar's
  seven action buttons collapse the same way, into one overflow menu (reusing
  `FileContextMenu`, whose items gained an `active` flag for the toggles) that also
  carries sorting - the list header can only sort by name at that width. The current directory lives in the URL
  (`/files?path=...`), so browser back/forward is the explorer's history.
  **Click opens; press-and-hold selects** (`useRowPress` in `FileList.tsx`, 450 ms,
  cancelled by any real pointer movement, and it swallows the `click` that follows
  the hold). Once anything is selected the list is in selection mode, so further
  clicks toggle items rather than navigating away mid-selection; ctrl-click and
  shift-click still select directly with a mouse. Everything else is desktop
  standard: right-click menu, F2 rename, Delete to trash (Shift+Delete permanent),
  Ctrl+A/C/X/V, Enter to open, Backspace for up, drag-and-drop upload. On coarse
  pointers the native contextmenu is suppressed (the hold is the select gesture)
  and the row's ⋮ button opens the menu instead.

## The VPS as an explorer drive

The seedbox shows up in the file explorer's sidebar as a drive alongside the
local disks, browsable in the same UI. `backend/remote_files.py` is the whole
remote half; `files.py` stays pure local filesystem, which is what keeps it
simple.

- **Remote paths carry a `vps:` prefix** (`vps:/home6/user/downloads`), and
  `routes/files.py` dispatches list/search/size/text/delete on it. Everything
  above the transport - the URL, breadcrumb, selection, clipboard, context menu
  - already treats a path as an opaque string, so the frontend needed almost
  nothing. `vps:~` is the sidebar root: "wherever this login lands", which only
  the far end can resolve.
- **Copying VPS -> local is a download, not a copy.** A `transfer` with remote
  sources hands off to `vps_handler.start_download()`, so a paste into a local
  folder gets a real download record with progress, resume and the watchdog
  behind it. Doing it inline would block the request for however long a 50 GB
  folder takes. The UI says "Copy (paste locally to download)" and reports that
  the transfer *started*.
- **Read-mostly by design.** No remote rename/mkdir/upload and no remote-to-remote
  copy (SFTP has no server-side copy); those routes refuse a `vps:` path with a
  reason rather than failing obscurely. Remote delete works and is **always
  permanent** - the local trash is a per-mount rename, which has no equivalent
  on someone else's box, and inventing a hidden trash dir in a seedbox home
  would be worse than saying so. The dialog says "Delete on the VPS".
- **No thumbnails or streaming remotely.** A grid view would pull hundreds of
  files across the internet to make JPEGs; only text preview is cheap enough.
- **One pooled SSH session** (`vps_session()` in `web_app/vps.py`). Logging in
  costs ~0.6s against a listing's ~0.15s, so reconnecting per click would spend
  four fifths of the time on handshakes; measured 0.71s cold, 0.12s warm. It is
  handed out under a lock (paramiko channels aren't safe to share), dropped
  after `IDLE_TIMEOUT` (120s) so a closed tab isn't holding a connection open on
  the seedbox, and `close_pooled_session()` is called when the VPS config
  changes. A non-`ValueError` inside the session drops it rather than handing
  the next caller a half-dead channel.
- The sidebar capacity bar reuses the account quota, cached 60s, filled in by
  the first listing rather than by `/api/files/roots` (which must not wait on an
  SSH login during a page load).
- **The tree stops at the login home.** Above it is the provider's shared
  `/homeN`, which the account cannot list, so a remote listing reports
  `parent: null` at home (the toolbar's Up button and Backspace are already
  guarded on it) and `home` - the top of the tree - which the breadcrumb uses so
  it never renders a crumb that can only fail. `_io_error()` maps `EACCES` to a
  403 "Permission denied", because reporting an unreadable directory as "not
  found" sends you hunting for a folder that is really just someone else's.
- **The breadcrumb is prefix-aware.** `path.split('/')` on `vps:/home6/...`
  yields targets like `/vps:` and a root button pointing at the *local* `/`, so
  `splitPrefix()` strips the scheme, crumbs are built below `home`, and every
  target gets the prefix put back.

## Logging

`backend/logsafe.py` owns log setup; `setup_logging()` in `backend/main.py` just
calls `logsafe.install(LOG_FILE)`.

- **Credentials are redacted before they reach a handler.** `media_token_required`
  exists so no token lands "in a URL, browser history or an access log", but
  Werkzeug logs the full request line - query string included - which defeated
  exactly that. A media token is good for `MEDIA_TOKEN_HOURS` of arbitrary file
  read as the service user, so a world-readable log of them is a credential store.
  `RedactSecretsFilter` rewrites `token=`, `password=`, `api_key=` and friends
  (`SECRET_PARAMS`) to `[redacted]`.
- It filters the **formatted** message, not `record.msg`: Werkzeug passes the
  request line as a positional arg, so inspecting `msg` alone would miss every
  one. The filter sits on the **handler** as well as the root logger, because a
  filter on a logger does not apply to records propagated up to it.
- **Rotating and owner-only**: `RotatingFileHandler` at 10 MB x 5 (this replaced
  a 70 MB unrotated file), `chmod 600` on the log and `750` on `logs/`.
- `scrub_file()` redacts a log that was already written. It rewrites the **same
  inode** rather than renaming: the running process holds an open descriptor, so
  replacing the file would leave the service logging to an orphan. Redaction only
  shortens a line, so the content always fits, and the handler appends, so later
  writes land at the new end.

## Key Patterns

- **Shared state**: `download_tasks = {}` dict passed to all handlers
- **WebSocket broadcast**: `get_socketio().emit(event, data)` from any module
- **Soft deletes**: `deleted_at` timestamp, never hard delete
- **Progress throttling**: 1-second minimum interval between updates
- **JWT auth**: All API routes use `@token_required` (except `/metrics`); media routes use `@media_token_required`, which also accepts a `?token=` media token
- **CORS**: closed by default to `CORS_ORIGINS` (Vite dev ports); Socket.IO uses a callable origin check so same-origin handshakes always pass (`_socketio_origin_allowed`)
- **Frontend serves from Flask**: Built `frontend/dist/` served as static files

## Tests

```bash
./venv/bin/python -m pytest      # backend  (tests/)
cd frontend && npm test          # frontend (src/**/*.test.ts)
```

- **Nothing in the suite touches the real deployment.** `tests/conftest.py`
  redirects `DOWNLOAD_DIR`, `SCREENSHOTS_DIR` and `DATABASE_URL` to a temp
  directory *before* `backend.config` is imported - that module creates its
  directories at import time, so the import order in conftest is load-bearing.
- **Nothing touches the network.** A seedbox, a Telegram account and two torrent
  clients are not fixtures. `FakeSFTP` (conftest) drives the remote-drive tests
  from a dict tree, including a `restricted` directory that resolves but refuses
  to be listed - which is exactly how the shared `/homeN` above a seedbox account
  behaves, and what the 403-vs-404 test depends on.
- **Route tests run the real `WebApp`** against SQLite (`app`/`client`/`auth`
  fixtures), with the downloaders left unwired on purpose: a route that needs
  one should say so with a clear error rather than reach a live Telegram client
  or a seedbox from a test. Two fixtures exist only for isolation - bcrypt's
  cost factor is dropped to 4 (cost 12 turned a 1s run into a minute, same code
  path, different work factor), and the process-global login rate limiter is
  cleared between tests, since every test logs in from 127.0.0.1 as admin and
  one lockout test would otherwise lock out everything after it.
- Frontend logic that lived inside JSX was extracted so it can be tested
  directly: `buildCrumbs`/`splitPrefix` (ExplorerToolbar), `downleeState`/
  `isPendingPull` (TorrentStatusPanel), `isTorrentFile`, `magnetName`.
- Vitest config is separate from `vite.config.ts` so a build never loads the
  test setup (and the service-worker plugin never runs in a test).

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

## Startup Greeting

`send_startup_greeting()` announces the service in every monitored chat on each authorization. Three ways to mute one start, all folded into `TelegramDownloader.skip_greeting` in `__init__`:

1. `python main.py --no-greeting` / `-n` (argparse in `backend/main.py`)
2. `SKIP_STARTUP_GREETING=1` (env, via `backend/config`)
3. `touch .skip-greeting` then restart — `_consume_greeting_sentinel()` deletes the file as it reads it

Only (3) works with `systemctl restart`, which runs the unit's `ExecStart` and never sees CLI flags. The flag is one-shot: `send_startup_greeting` clears it after suppressing once, so a later web login in the same process still greets.

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

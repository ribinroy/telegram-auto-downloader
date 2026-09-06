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
- `POST /api/retry` - Retry failed download
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
- `POST /api/vps/download` - Download a file/directory to the home server
- `POST /api/vps/delete-remote` - Delete on the VPS

### Torrent Clients (Transmission + qBittorrent on the VPS)
- **Both clients are configurable and live simultaneously.** Config is a nested `torrent_config` setting: `{transmission:{url,username,password_enc,download_dir,incomplete_dir}, qbittorrent:{...}, telegram_default}`. A legacy flat Transmission config auto-migrates on read (`read_torrent_settings()` in `web_app/torrent.py`).
- `web_app/torrent.py` provides **client-agnostic dispatchers** (`torrent_test/add_magnet/list/control/get/set_location/telegram_dirs`, `apply_torrent_session`) that take an explicit client and route to the Transmission backend (in the same file) or the qBittorrent backend (`web_app/qbittorrent.py`). Everything keys torrents by **hash** (Transmission RPC accepts hashes as `ids`; qBittorrent is hash-native), so one code path drives both.
- `GET /api/settings/torrent` - Both clients' config (passwords never exposed) + `telegram_default`
- `POST /api/settings/torrent` - Save one client (`{client, url, username, password?, download_dir?, incomplete_dir?}`); Transmission URL normalized to the RPC endpoint, qBittorrent uses the base WebUI URL; password encrypted at rest
- `DELETE /api/settings/torrent?client=...` / `POST /api/settings/torrent/telegram-default` (`{client|null}`)
- `POST /api/settings/torrent/test` - `{client, ...}` connectivity check (Transmission session-get / qBittorrent version)
- `POST /api/torrent/add` - Send a magnet (`{magnet, client, download_dir?}`); falls back to the client's configured `download_dir` when none given
- `GET /api/torrent/list?client=...` - Live status of that client's torrents (normalized shape: name, hash, status label, percent, down/up rate, size, ETA, download dir, error, peers/seeds)
- `POST /api/torrent/action` - `{client, action:start|stop|remove, hashes:[str], delete_data?}` (legacy `ids` still accepted as hashes)
- Temp folder: `apply_torrent_session()` pushes the incomplete/temp dir (Transmission `session-set incomplete-dir`; qBittorrent `setPreferences temp_path`), applied on config save + re-applied before each add. The client downloads into the temp dir, then moves to the torrent's download dir on completion.
- Frontend: Settings → VPS shows a `TorrentClientCard` per client; the VPS page has per-client tabs (Files · Transmission · qBittorrent), each its own `TorrentStatusPanel` (hash-based multi-select). Pasted magnets pick the client in `AddUrlModal`.

### File Explorer (local disks)
Live filesystem access - every call reads the disk, nothing is indexed or cached.
- `GET /api/files/roots` - Sidebar places, grouped `drive` / `folder` / `configured`: every real mount from `/proc/mounts` with live capacity, then Home + `DOWNLOAD_DIR`, then DownLee's own destination folders (source mappings, VPS watch-folder destinations, torrent `local_dir`); `?include_hidden=true` includes secured ones
- `POST /api/files/list` - `{path?, show_hidden?}` -> entries + `writable`, `usage`, `mount`, `trash`
- `POST /api/files/mkdir` / `rename` / `delete` (`{paths, permanent?}`) / `transfer` (`{paths, dest, move}`) / `upload` (multipart)
- `POST /api/files/search` (recursive, capped by results **and** a wall-clock deadline), `POST /api/files/size` (on-demand `du`), `POST /api/files/text` (preview head)
- `GET /api/files/stream|download|thumb?path=` - `@media_token_required`, range-streamed; `thumb` is a cached JPEG (Pillow for images, an ffmpeg frame grab for video)

### Video Streaming
- `GET /api/video/stream/<id>` - Range-request video streaming
- `GET /api/video/thumbs/<id>` - Thumbnail list
- `GET /api/video/thumb/<id>/<filename>` - Single thumbnail

### Settings
- `GET/POST /api/settings/cookies` - yt-dlp cookies
- `POST /api/jobs/sync-thumbnails` - Regenerate download thumbnails, clean orphans, and prune the file explorer's thumbnail cache

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
  name from its note.
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
  transport, and `components/explorer/*`. The current directory lives in the URL
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

## Key Patterns

- **Shared state**: `download_tasks = {}` dict passed to all handlers
- **WebSocket broadcast**: `get_socketio().emit(event, data)` from any module
- **Soft deletes**: `deleted_at` timestamp, never hard delete
- **Progress throttling**: 1-second minimum interval between updates
- **JWT auth**: All API routes use `@token_required` (except `/metrics`); media routes use `@media_token_required`, which also accepts a `?token=` media token
- **CORS**: closed by default to `CORS_ORIGINS` (Vite dev ports); Socket.IO uses a callable origin check so same-origin handshakes always pass (`_socketio_origin_allowed`)
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

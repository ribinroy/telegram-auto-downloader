# DownLee

A self-hosted media downloader with Telegram integration and a modern web dashboard. Automatically download files from Telegram chats/channels, URLs (YouTube, Twitter, Instagram, and 1000+ sites), and a remote VPS/seedbox over SFTP — with magnet link handoff to the seedbox's torrent clients, a download queue, and a full file manager for the server's own disks.

## Screenshots

### Dashboard
![Dashboard](screenshots/Dashboard.png)

### Download in Progress
![Download in Progress](screenshots/Download%20in%20progress.png)

### URL Downloader
![URL Downloader](screenshots/URL%20Downloader.png)

### Analytics
![Analytics](screenshots/Analytics.png)

## Features

### Downloading
- **Telegram Downloads**: Auto-download files from any number of monitored Telegram chats/channels (managed from Settings → Telegram)
- **URL Downloads**: Download videos from YouTube, Twitter, TikTok, Instagram, and 1000+ sites via yt-dlp, with quality selection (preselected from the source's default quality). The chosen format is remembered, so a resumed or queued download fetches the same quality
- **VPS / Seedbox Downloads**: Connect to a remote server over SSH/SFTP, browse watched folders, and pull files or whole directories to the home server, resuming partial files
- **autoSync**: Watched VPS folders can auto-download new files on an hourly check
- **Download Queue**: At most *N* local downloads run at once (default 3) — anything beyond that waits its turn and starts automatically when a slot frees. A global limit plus optional per-source caps (Telegram / URL / VPS). The floating queue button shows `running/total` and opens the queue: change the limits, **drag to reorder** (drag a waiting download above a running one and they swap — the bumped one keeps its bytes and resumes later), start one now past the limit, **Stop all** and **Resume all**
- **Network Watchdog**: Resumes downloads an internet drop interrupted, restarts any download frozen for 10 minutes, and picks interrupted downloads back up after a restart — always from the bytes already on disk
- **Rename Rules**: Define regex rules (Settings → Renaming) that clean up filenames **before the download starts** — strip `1080p.WEB-DL.x264-GROUP`, turn dots into spaces, bracket the year. Files are saved under their final name from the first byte. Preview any rule against your real filenames, and replay the whole chain over already-downloaded files with a dry run first
- **Real-time Progress**: WebSocket-based live progress, speed and ETA

### Torrents (Transmission + qBittorrent on the VPS)
- **Both clients at once**: Configure either or both, each with its own connection, default download folder and temp (incomplete) folder. The VPS page has a tab per client with a live status panel — search, status filter, sort, multi-select pause/resume/remove, and **Verify & start** for torrents whose data is missing
- **Magnet & .torrent handoff**: Paste a magnet link, or drop one or more `.torrent` files anywhere on the downloads page, and pick which client gets them — optionally into a watched folder so autoSync brings the result home
- **Torrent details**: Click a torrent to see its files with per-file progress, transfer totals, ratio, dates, pieces and trackers — live while open
- **Per-file control**: **Skip** files or set their priority (Transmission: low/normal/high, qBittorrent: normal/high/max), one at a time or in bulk ("filter *sample*, select all, Skip")
- **Rename**: Rename a torrent or any of its files from the details view
- **Force start**: Jump a torrent past the client's own download queue
- **Stop seeding on completion**: A watcher stops finished torrents from seeding (per client, on by default), since once the files are pulled home the upload only spends the seedbox's bandwidth
- **"To be downloaded"**: A filter for torrents finished on the VPS but not yet pulled home; pulled ones show **Downloaded**
- **Per-Channel Magnet Routing**: Each monitored Telegram channel can route its magnets to a chosen client, with a global fallback. The bot replies with live progress and, on completion, a "reply *download*" prompt that pulls the files home
- **Seedbox usage**: Account quota, the clients' traffic counters and the shared server's load, above the VPS page

### File Explorer
- **The server's own disks, live**: Every mounted drive with its capacity, Home, the download folder and every folder DownLee writes to — read straight from disk on each visit, so a file copied in over SMB shows up immediately
- **A real file manager**: Grid and list views, search, folder sizes, text preview, video/image preview, upload (drag-and-drop), new folder, rename, copy / cut / paste, keyboard shortcuts (F2, Delete, Ctrl+A/C/X/V, Backspace). Click opens; press-and-hold selects on touch
- **Video contact sheets**: Video thumbnails are a 2×2 sheet of frames from across the clip (hover scrubs through them), generated in the background without starving the rest of the app
- **Trash by default**: Delete moves items to a per-disk `.downlee-trash` (instant, recoverable); **Delete permanently** is one click away in the selection bar. A permanent delete keeps going past folders it can't remove and tells you exactly what was left
- **The VPS as a drive**: Browse the seedbox in the same UI; pasting a VPS item into a local folder starts a real, resumable download
- Read-only mode (`EXPLORER_READONLY=1`), and system directories (`/etc`, `/usr`, `/boot`, …) are never writable

### Organising & privacy
- **Per-Source Settings**: Each source (telegram, youtube, vps, …) can have its own destination folder, default quality, and hidden flag (Settings → Sources)
- **Per-Watchfolder Settings**: Each watched VPS folder can have its own local destination folder and hidden flag
- **Hidden View**: Downloads from hidden sources/folders are filtered out of the default view (secret triple-click or Ctrl+X toggle). Removing a hidden watched folder warns which downloads would become visible and asks first
- **Soft deletes**: Downloads, watched folders, source settings, rename rules and bot queries are never erased — a delete stamps a `deleted_at` timestamp
- **Author Tracking & Filtering**: Who initiated each download (Telegram sender or logged-in web user), filterable

### Dashboard & app
- **Web Dashboard**: Modern React UI with search, filtering, sorting, dark theme, and notifications for finished, failed and completed actions
- **Thumbnail Previews**: Hover to preview video thumbnails with a carousel, or tap the preview button on mobile
- **Video Playback**: Stream downloaded videos in the browser (including a VR player); folders and other files open in the file explorer
- **Analytics**: Charts of download activity over time
- **Scheduled Jobs**: Thumbnail sync and yt-dlp upgrades can run on a schedule (time of day + weekdays), with catch-up for runs missed while the server was off
- **yt-dlp Management**: Check the version and upgrade yt-dlp from the web UI
- **Installable PWA**: Add DownLee to your phone's home screen or desktop — standalone window, offline app shell, app shortcuts
- **Prometheus Metrics**: Export metrics for monitoring with Grafana

### Security
- **User Authentication**: JWT login with bcrypt-hashed passwords, short-lived access tokens + revocable refresh sessions, per-device sign-out, and brute-force rate limiting
- **Encrypted Credentials**: VPS, torrent client and Telegram API secrets stored encrypted at rest (Fernet, keyed off the app secret)
- **Log redaction**: Tokens and passwords are scrubbed from logs before they're written; logs rotate and are owner-only

## Tech Stack

- **Backend**: Python, Flask, Flask-SocketIO, SQLAlchemy, Telethon, yt-dlp, paramiko (SFTP), ffmpeg + Pillow (thumbnails)
- **Frontend**: React, TypeScript, Vite, Tailwind CSS, TanStack Query, dnd-kit
- **Database**: PostgreSQL
- **Monitoring**: Prometheus metrics endpoint

## Prerequisites

- Python 3.10+
- Node.js 18+ (also used as yt-dlp's JavaScript runtime for YouTube extraction)
- PostgreSQL
- yt-dlp
- ffmpeg (video thumbnails and metadata)

## Quick Start

### 1. Clone and setup

```bash
git clone https://github.com/yourusername/downlee.git
cd downlee
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Setup PostgreSQL

```bash
sudo -u postgres psql -c "CREATE USER downlee WITH PASSWORD 'your_password';"
sudo -u postgres psql -c "CREATE DATABASE downlee OWNER downlee;"
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — the essentials:

```env
# Paths
DOWNLOAD_DIR=/path/to/downloads

# Server
WEB_PORT=4444
WEB_HOST=0.0.0.0

# Database
DATABASE_URL=postgresql://downlee:your_password@localhost:5432/downlee
```

Telegram API credentials and the monitored channels can be set from the web UI (**Settings → Telegram**) instead of `.env`. See [Configuration](#configuration) for everything else.

### 4. Build frontend

```bash
cd frontend
npm install
npm run build
cd ..
```

### 5. Run

```bash
python main.py
```

Access at **http://localhost:4444** (default login: `admin` / `admin` — you'll be asked to change it)

## Systemd Service

Create `/etc/systemd/system/downlee.service`:

```ini
[Unit]
Description=DownLee Media Downloader
After=network.target postgresql.service

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/downlee
Environment=PATH=/path/to/downlee/venv/bin
ExecStart=/path/to/downlee/venv/bin/python main.py
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable downlee
sudo systemctl start downlee
```

## Configuration

All settings live in `.env` (see `.env.example` for comments on each):

| Variable | Default | Description |
|----------|---------|-------------|
| `DOWNLOAD_DIR` | `./downloads` | Root download directory |
| `WEB_PORT` / `WEB_HOST` | `4444` / `0.0.0.0` | Where the web UI listens |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `API_ID` / `API_HASH` / `CHAT_ID` | — | Optional fallback; normally set in Settings → Telegram |
| `MAX_RETRIES` | `6` | Telegram download attempts |
| `JWT_SECRET` | generated, saved to `.jwt_secret` | Signs logins and encrypts stored secrets |
| `ACCESS_TOKEN_MINUTES` / `REFRESH_TOKEN_DAYS` / `MEDIA_TOKEN_HOURS` | `30` / `30` / `12` | Token lifetimes |
| `CORS_ORIGINS` | Vite dev server only | Extra allowed origins, comma-separated |
| `TRUST_PROXY_HEADERS` / `TRUSTED_PROXY_COUNT` | `false` / `1` | Trust `X-Forwarded-For` behind your own reverse proxy |
| `SKIP_STARTUP_GREETING` | `false` | Never send the startup greeting |
| `NET_WATCHDOG` | `true` | Resume downloads a network drop interrupted |
| `NET_PROBE_INTERVAL` | `20` | Seconds between connectivity probes |
| `NET_STALL_SECONDS` | `600` | Restart a download frozen this long (`0` disables) |
| `NET_PROBE_HOSTS` | `1.1.1.1:53,8.8.8.8:53` | `host:port` pairs the probe connects to |
| `TORRENT_WATCH` / `TORRENT_WATCH_INTERVAL` | `true` / `30` | Stop finished torrents from seeding (per-client switch in Settings → VPS) |
| `EXPLORER_READONLY` | `false` | Refuse every file-explorer write |
| `THUMB_WORKERS` | cores − 1 (max 4) | Parallel explorer thumbnail generation |

The download queue's limits are set from the queue button on the downloads page, not `.env`.

## Usage

### Telegram Downloads
Files sent to a monitored Telegram chat/channel are downloaded automatically. Add channels in **Settings → Telegram**.

### URL Downloads
1. Click the **+** button (or just paste a URL anywhere on the downloads page)
2. Click "Check URL" to fetch formats
3. Select quality and click "Download"

### The Download Queue
When more downloads arrive than the limit allows, the extras show as **Waiting · #n** and start on their own as slots free. The green floating button (`3/7` = 3 running of 7) opens the queue:

- **At once** sets the global limit; the sliders button sets optional per-source caps. A source at its cap is skipped, not waited on — the next download that fits starts instead.
- **Drag the grip** to reorder. Running and waiting downloads share one list with a dashed line between them: drag a waiting download above a running one and it takes that slot, while the running one goes back to waiting with its bytes kept.
- **⚡** starts a waiting download now, past the limit; **✕** takes it out of the queue.
- **Stop all** stops everything; **Resume all** puts stopped and paused downloads back in line (the limit still applies, so resuming twenty starts three).

Retrying a failed download also takes a slot — with none free, it joins the back of the line.

### VPS / Seedbox Downloads
1. Configure the SSH connection in **Settings → VPS Connection** (password is stored encrypted)
2. Browse the remote filesystem and add watched folders
3. Open the **VPS Files** page to browse watched folders and download files/directories to the home server
4. Optionally give each watched folder a local destination folder, a hidden flag, and enable **autoSync** to pull new files automatically every hour

### Magnet Links & Torrents
1. Configure **Transmission and/or qBittorrent** in **Settings → VPS Connection → Torrent Clients**. Each client takes a Web/RPC (Transmission) or WebUI (qBittorrent) URL + credentials, plus an optional default download folder and temp (incomplete) folder on the VPS. Test the connection, then Save.
2. Paste a magnet link on the downloads page, or **drop `.torrent` files** onto it — DownLee lets you **pick the client** and sends them (several `.torrent` files go one after another, each with its own status)
3. Optionally pick a watched folder as the torrent's download directory so autoSync fetches the finished files
4. The **VPS page** has a tab per configured client with live torrent status. Select several torrents to pause/resume/force-start/remove together, filter to **To be downloaded** to see what's finished but not yet home, and pull a finished torrent to the home server with one click.
5. **Click any torrent** for its details: every file with its own progress bar, where to skip files or change their priority (singly or in bulk), rename the torrent or a file, plus ratio, dates, pieces and trackers.

> Renaming a torrent means different things per client: in **qBittorrent** it only changes the name shown in the client; in **Transmission** the name *is* the folder on the VPS, so the folder is renamed too. The details view says which. Pulls to DownLee always use the folder's real location on the VPS, whatever the torrent is called.

**Telegram-channel magnets**: a magnet posted in a monitored channel is auto-added to a torrent client. Set a per-channel client in **Settings → Telegram**, or a global fallback in **Settings → VPS → Torrent Clients**. The bot replies to the message with live download progress and, on completion, a "reply *download*" prompt to pull the files to the home server.

### File Explorer
Open it from the folder icon in the header (`/files`). The sidebar lists every disk with its free space, Home, your download folder, the folders DownLee saves into, and the VPS.

- **Open** with a click; **select** with press-and-hold (touch) or Ctrl/Shift-click. Selected items get a floating bar with Copy, Cut, Trash, Delete and Clear.
- **Trash** moves items into that disk's `.downlee-trash` folder (linked from the sidebar once it exists), so it's instant and recoverable. **Delete** removes them permanently.
- The trash folder is created at the top of each disk, so the service user needs write access there — on a disk owned by another user (e.g. Plex), Trash reports "Permission denied"; use Delete, or give the service user write access to the disk.
- **Grid view** shows video contact sheets; hover a video to scrub through its four frames.
- Copying a **VPS** item and pasting it into a local folder starts a normal download, with progress on the downloads page.

### Per-Source Settings
Configure each source's destination folder, default quality, and hidden flag in **Settings → Sources**. Hidden sources/folders are filtered from the default view; reveal them with a triple-click on the connection status pill or **Ctrl+X**.

### Scheduled Jobs
In **Settings → Jobs**, each maintenance job (thumbnail sync, yt-dlp upgrade) has a **Run now** button and an optional schedule: a time of day and the weekdays to run on, in the server's timezone. A run missed while the server was off happens shortly after it starts again.

### Silencing the Startup Greeting

DownLee greets every monitored chat when it starts (`Good Evening, reporting for duty 🫡`). While you're restarting repeatedly that gets noisy. To mute **just the next restart**:

```bash
touch .skip-greeting && sudo systemctl restart downlee
```

The file is consumed at startup, so the restart after that greets normally — nothing to remember to undo. Running the app by hand, `python main.py --no-greeting` (or `-n`) does the same thing.

> A command-line flag can't work with `systemctl restart`, which runs the unit's own `ExecStart` and never sees your arguments — that's why the file exists.

To mute it permanently, set `SKIP_STARTUP_GREETING=true` in `.env`.

## Install as an App (PWA)

DownLee ships as an installable Progressive Web App — useful on a phone, where the dashboard is mostly used to check on downloads.

- **Android/Chrome/Edge**: open DownLee and choose *Install app* / *Add to Home screen*.
- **iOS/Safari**: *Share → Add to Home Screen*.
- **Desktop Chrome/Edge**: the install icon in the address bar.

Installed, it opens in its own window with no browser chrome, gets app shortcuts (Downloads, Seedbox, Analytics), and keeps working well enough offline to show the app shell instead of a browser error page. Live data, media streaming and the WebSocket are never served from cache.

> **Browsers only offer installation over HTTPS** (or on `localhost`). On a plain-HTTP LAN address the app still works, but the install prompt won't appear — put it behind a reverse proxy with a certificate, or use Tailscale HTTPS, to get the installable experience.

When a new build is deployed, the running app notices and offers a **Reload** pill rather than refreshing underneath you mid-download.

## Security

### Bot Queries Run Shell Commands on the Host

DownLee's bot queries (**Settings → Queries**) map a keyword to a shell snippet. Tagging the bot account (or DMing it) with that keyword — e.g. `@DownLeeBot health` — executes the snippet on the server and replies with its output. **This is remote command execution by design.** Anyone with the Telegram `admin` role effectively has a shell on your host.

Things to know before enabling it:

- Snippets run via the shell (`sh -c`) **as the service user** (the `User=` in your systemd unit), with a 30-second timeout. Whatever that user can do, a query can do.
- Only Telegram users with the **admin** role can trigger queries. Everyone who messages a monitored chat is recorded with the default `user` role and gets refused; promote people deliberately in **Settings → Users**, and keep the admin list as small as possible.
- Queries can also be edited and test-run from the web UI (**Settings → Queries**), so anyone with web dashboard access can change what they execute. Change the default `admin`/`admin` login immediately.
- Keep snippets **read-only** (status, disk usage, uptime). Avoid anything that changes state — file deletion, package installs, service restarts — since a compromised Telegram account of any admin can invoke them.

### Sudo for the Hardware Queries

The default `health` query uses `sudo -n smartctl` to read disk SMART status. Do **not** give the service user broad passwordless sudo. Instead, scope a sudoers rule to exactly the binary needed (replace `your_user` with the systemd service user):

```
# /etc/sudoers.d/downlee
your_user ALL=(root) NOPASSWD: /usr/sbin/smartctl
```

With `sudo -n`, the query degrades gracefully (reports health as "unknown") if no rule is present — so granting this is optional and only needed for SMART health output.

### The File Explorer Can Write to Your Disks

The file explorer reads anything the service user can read, and can rename, move, upload and delete on any mounted data disk. System directories on the root filesystem (`/etc`, `/usr`, `/boot`, `/var`, …) are always refused, and a mount point itself can't be deleted or renamed — but anyone with dashboard access can still delete your media. Set `EXPLORER_READONLY=1` if you only want browsing and previews.

### Accounts and Sessions

- Passwords are hashed with **bcrypt** (cost 12, SHA-256 pre-hash so long passphrases aren't truncated). Accounts created by older versions stored a bare SHA-256 digest; those are verified once and then transparently re-hashed on the owner's next successful login — no action needed, no password reset.
- Logging in returns a **short-lived access token** (30 min, `ACCESS_TOKEN_MINUTES`) plus a **refresh token** (30 days, `REFRESH_TOKEN_DAYS`). The browser exchanges the latter for a new pair in the background, so nothing is signed in for 30 days on the strength of one stolen token.
- Refresh tokens are backed by a `user_sessions` row and **rotate on every use**. Replaying an already-rotated token is treated as theft and revokes that entire session.
- Sessions are revocable server-side and take effect on the very next request:
  - **Settings → Password → Active sessions** lists every signed-in device, with per-device sign-out.
  - **Sign out everywhere** invalidates every outstanding token for the account.
  - **Changing your password** does the same automatically.
- `<video>` and `<img>` tags can't send an `Authorization` header, so media URLs carry a **separate media token** scoped to the streaming and thumbnail routes only (`MEDIA_TOKEN_HOURS`, default 12h). A full API token is never placed in a URL, browser history or access log — and tokens or passwords that do appear in a request line are redacted before the log is written.
- Failed logins are **rate limited** per source IP *and* per username: 5 attempts in a 15-minute window, then a lockout that doubles with each further failure (30s → 15 min). Successful logins reset the counter. Behind a reverse proxy, set `TRUST_PROXY_HEADERS=true` so the limiter sees the real client address rather than the proxy's.

### Network Exposure

By default the server binds to `0.0.0.0` — this is intended for use on a **trusted LAN only**.

- **Do not expose DownLee directly to the internet.** If you need remote access, put it behind a reverse proxy (Caddy, nginx, Traefik) with HTTPS, and ideally restrict access further with a VPN (WireGuard, Tailscale) or proxy-level authentication.
- **CORS** is closed by default: only the Vite dev server (`localhost:5173`) is allowed, since the production UI is served by this same process and needs no cross-origin grant. Add your own origins with `CORS_ORIGINS=https://downlee.example.com` (comma-separated). `*` is honoured but logs a warning — don't use it on an exposed instance.
- All `/api/*` routes require a token, but `/metrics` (Prometheus) is **unauthenticated** by design — anyone who can reach the port can read download stats from it.
- Change the default `admin`/`admin` credentials before the dashboard is reachable by anyone else. The app forces this on first login and refuses `admin` as the new password (minimum 8 characters).
- To bind to a specific interface instead of all of them, set `WEB_HOST` in `.env` (e.g. `WEB_HOST=192.168.1.10`, or `127.0.0.1` when fronted by a local reverse proxy).

## API Endpoints

All `/api/*` routes need a token (`Authorization: Bearer …`); media routes take a media token.

### Auth

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Login; returns an access token + refresh token |
| `/api/auth/refresh` | POST | Exchange a refresh token for a new pair (rotates it) |
| `/api/auth/logout` | POST | Revoke this device's session |
| `/api/auth/logout-all` | POST | Revoke every session for the account |
| `/api/auth/sessions` | GET | List active sessions (device, IP, last used) |
| `/api/auth/sessions/<id>` | DELETE | Revoke one session |
| `/api/auth/media-token` | GET | Mint a token scoped to the media routes |
| `/api/auth/verify` | GET | Verify the access token |
| `/api/auth/password` | POST | Change password (revokes other sessions) |

### Downloads & queue

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/downloads` | GET | List downloads (supports `search`, `filter`, `sort_by`, `sort_order`, `author`, `limit`, `offset`, `include_hidden`) |
| `/api/authors` | GET | Distinct author values for filtering |
| `/api/stats` | GET | Statistics |
| `/api/analytics` | GET | Analytics data |
| `/api/url/check` | POST | Check URL formats |
| `/api/url/download` | POST | Start a URL download |
| `/api/retry` | POST | Retry/resume a failed or stopped download (joins the queue when no slot is free) |
| `/api/stop` | POST | Stop a download (a waiting one leaves the queue) |
| `/api/pause` / `/api/resume` | POST | Pause/resume a Telegram download |
| `/api/delete` | POST | Soft-delete a download |
| `/api/queue` | GET | Limits, running and waiting downloads |
| `/api/queue/limits` | PUT | Set the global limit and per-source caps |
| `/api/queue/reorder` | POST | Reorder running + waiting downloads |
| `/api/queue/start-now` | POST | Start a waiting download past the limit |
| `/api/queue/stop-all` / `/api/queue/resume-all` | POST | Stop everything / queue every stopped and paused download |
| `/api/video/check/<id>` | GET | What's on disk for a download (video, folder or file) |
| `/api/video/stream/<id>` | GET | Stream video for playback |

### File explorer

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files/roots` | GET | Disks, folders and DownLee's destination folders |
| `/api/files/list` | POST | List a folder (local, or `vps:` for the seedbox) |
| `/api/files/mkdir` / `rename` / `delete` / `transfer` / `upload` | POST | Write operations (delete trashes unless `permanent`) |
| `/api/files/search` / `size` / `text` | POST | Recursive search, folder size, text preview |
| `/api/files/thumb` | GET | Cached thumbnail / video contact sheet |
| `/api/files/stream` / `download` | GET | Range-streamed file access |

### VPS & torrents

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/settings/vps` | GET/POST/DELETE | VPS SSH connection config |
| `/api/settings/vps/test` | POST | Test the VPS SSH connection |
| `/api/settings/vps/browse` / `/api/settings/local/browse` | POST | Browse remote / local folders (folder pickers) |
| `/api/settings/vps/folders` | GET/POST | List/add watched VPS folders |
| `/api/settings/vps/folders/<id>` | PATCH/DELETE | Update specs (`auto_sync`, `folder`, `is_secured`) or remove a folder |
| `/api/settings/vps/folders/<id>/delete-impact` | GET | Which hidden downloads removing it would reveal |
| `/api/vps/files` | GET | Live listing of watched VPS folders |
| `/api/vps/usage` | GET | Seedbox quota, traffic and server load |
| `/api/vps/download` | POST | Download a VPS file/directory to the home server |
| `/api/vps/delete-remote` | POST | Delete a file/directory on the VPS |
| `/api/settings/torrent` | GET/POST/DELETE | Torrent client config (POST/DELETE take a `client`) |
| `/api/settings/torrent/test` | POST | Test a client connection |
| `/api/settings/torrent/telegram-default` | POST | Global fallback client for Telegram magnets |
| `/api/settings/torrent/stop-on-complete` | POST | Stop a client's torrents seeding once finished |
| `/api/settings/telegram/channels/<id>` | PATCH | Set a channel's magnet torrent client |
| `/api/torrent/add` / `/api/torrent/add-file` | POST | Send a magnet / a `.torrent` file to a client |
| `/api/torrent/list` | GET | Live torrent status for a client (`?client=`) |
| `/api/torrent/details` | GET | One torrent's files, totals and trackers (`?client=&hash=`) |
| `/api/torrent/files/priority` | POST | Skip files or set their priority |
| `/api/torrent/rename` | POST | Rename a torrent or one of its files |
| `/api/torrent/action` | POST | Start / force-start / stop / remove / verify torrents |

### Settings & jobs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mappings` | GET/POST | Per-source download specs (folder, quality, hidden) |
| `/api/mappings/<id>` | PUT/DELETE | Update or delete a source spec |
| `/api/settings/rename-rules` | GET/POST | Filename rewrite rules |
| `/api/settings/rename-rules/<id>` | PUT/DELETE | Update or delete a rule |
| `/api/settings/rename-rules/test` | POST | Preview rules against real filenames |
| `/api/settings/rename-rules/apply` | POST | Replay rules over existing files (dry run by default) |
| `/api/settings/cookies` | GET/POST | yt-dlp cookies |
| `/api/jobs/ytdlp-version` | GET | Current yt-dlp version |
| `/api/jobs/ytdlp-upgrade` | POST | Upgrade yt-dlp |
| `/api/jobs/sync-thumbnails` | POST | Generate missing thumbnails and clean up orphans |
| `/api/jobs/schedules` | GET | Every job with its schedule and next run |
| `/api/jobs/schedules/<job_id>` | PUT | Set a job's time and weekdays |
| `/metrics` | GET | Prometheus metrics (unauthenticated) |

## Database Schema

### Downloads Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `message_id` | String | UUID (yt-dlp, VPS) or Telegram message ID |
| `file` | String | Filename |
| `status` | String | `downloading`, `waiting`, `done`, `failed`, `stopped`, `paused` |
| `progress` | Float | 0-100% |
| `speed` | Float | KB/s |
| `error` | Text | Error message if failed |
| `downloaded_bytes` | BigInteger | Bytes downloaded so far |
| `total_bytes` | BigInteger | Total file size |
| `pending_time` | Float | Estimated seconds remaining |
| `downloaded_from` | String | `telegram`, `vps`, or domain name (e.g. `youtube`) |
| `url` | Text | Source URL (yt-dlp) or remote path (VPS) |
| `queue_position` | Integer | Rank in the download queue while waiting or running |
| `format_id` | String | yt-dlp format chosen, so a resumed or queued download keeps its quality |
| `dest_base` | String | Destination folder a VPS pull started with, when it can't be derived |
| `file_deleted` | Boolean | Whether the physical file was deleted from disk |
| `author` | String | Who initiated the download (see below) |
| `deleted_at` | Timestamp | Soft-delete timestamp (NULL = not deleted) |
| `created_at` | DateTime | When the download was created |
| `updated_at` | DateTime | Last update time |

### Author Tracking

The `author` column tracks who initiated each download:

- **Telegram downloads**: Stored as `username:user_id` (e.g. `johndoe:123456789`). Falls back to `post_author` for channel messages with signatures.
- **Web (DownLee) downloads**: Stored as the logged-in user's username (e.g. `admin`).

The UI displays only the name portion (before `:`) and shows the full `name:id` in a tooltip on hover.

### Soft Delete

Downloads, watched folders, source settings, rename rules and bot queries use a `deleted_at` timestamp instead of being erased. A row is active when `deleted_at IS NULL`. Columns that must be unique (a source's name, a bot query's key) are unique among live rows only, so a deleted entry never blocks adding the same one again.

### The Download Queue

There's no separate queue table: the queue is the `waiting` and `downloading` rows of `downloads`, ordered by `queue_position`. A download that finishes, fails, stops or is paused leaves the queue automatically.

### Other Tables

- `download_type_maps` — per-source specs: `downloaded_from`, `folder`, `quality`, `is_secured`, `deleted_at`
- `vps_watch_folders` — watched VPS folders: remote `path`, owning connection (`host`/`port`/`username`), `auto_sync`, local destination `folder`, `is_secured`, `deleted_at`
- `rename_rules` — filename rewrite rules, in order, with `deleted_at`
- `bot_queries` — Telegram bot keyword → shell snippet, with `deleted_at`
- `settings` — key-value store (VPS connection, torrent client config, download limits, job schedules, …; secrets encrypted)
- `users` / `user_sessions` — web login accounts and their signed-in devices

## Prometheus Metrics

DownLee exposes metrics at `/metrics` for Prometheus scraping:

- `downlee_downloads_total` - Total downloads by source and status
- `downlee_download_speed_bytes` - Current download speed
- `downlee_queue_size` - Active download queue size
- `downlee_db_downloads_count` - Database download counts by status

## Development

```bash
./venv/bin/python -m pytest      # backend tests
cd frontend && npm test          # frontend tests
cd frontend && npm run dev       # dev server with hot reload
```

The test suite never touches a real deployment: it runs against a temporary SQLite database and download folder, and stubs out Telegram, the seedbox and both torrent clients.

## License

Copyright © 2026 Ribin Roy

Licensed under the GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).

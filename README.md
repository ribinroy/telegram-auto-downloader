# DownLee

A self-hosted media downloader with Telegram integration and a modern web dashboard. Automatically download files from Telegram chats/channels, URLs (YouTube, Twitter, Instagram, and 1000+ sites), and a remote VPS/seedbox over SFTP — with magnet link handoff to the seedbox's torrent client.

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

- **Telegram Downloads**: Auto-download files from specified Telegram chat/channel
- **URL Downloads**: Download videos from YouTube, Twitter, TikTok, Instagram, and 1000+ sites via yt-dlp
- **VPS / Seedbox Downloads**: Connect to a remote server over SSH/SFTP, browse watched folders, and pull files or whole directories to the home server (with resume support)
- **autoSync**: Watched VPS folders can auto-download new files on an hourly check
- **Torrent Clients (Transmission + qBittorrent)**: Configure either or both clients on the VPS at once, each with its own connection, default download folder, and temp/incomplete folder. The VPS page shows a tab per configured client with a live status panel (search, status filter, sort, multi-select pause/resume/remove, and one-click "Verify & start" recovery for torrents whose data is missing)
- **Magnet Link Handoff**: Paste a magnet link and pick which client to send it to — optionally into a watched folder so autoSync brings the result home
- **Per-Channel Magnet Routing**: Each monitored Telegram channel can route its magnets to a chosen client (Settings → Telegram), with a global fallback client (Settings → VPS)
- **Per-Source Settings**: Each source (telegram, youtube, vps, ...) can have its own destination folder, default quality, and hidden flag (Settings → Sources)
- **Per-Watchfolder Settings**: Each watched VPS folder can have its own local destination folder and hidden flag
- **Quality Selection**: Choose video quality/resolution when downloading URLs (preselected from the source's default quality)
- **Download Folder Preview**: Shows the destination folder path when adding URL downloads and on each download item
- **Thumbnail Previews**: Hover to preview video thumbnails with carousel, or tap the preview button on mobile
- **Real-time Progress**: WebSocket-based live progress tracking
- **Web Dashboard**: Modern React UI with search, filtering, sorting, and dark mode
- **Author Tracking**: Tracks who initiated each download (Telegram sender or logged-in web user)
- **Author Filtering**: Filter the download list by author
- **Analytics**: Visual charts showing download statistics over time
- **Soft Delete with Timestamps**: Deleted downloads retain a `deleted_at` timestamp instead of a simple boolean
- **Hidden View**: Downloads from hidden sources/folders are filtered out of the default view (secret triple-click or Ctrl+X toggle)
- **Video Playback**: Stream downloaded videos directly in the browser
- **yt-dlp Management**: Check version and upgrade yt-dlp directly from the web UI (Settings > Jobs)
- **User Authentication**: JWT-based login with password management
- **Encrypted Credentials**: VPS and torrent client passwords stored encrypted at rest (Fernet, keyed off the JWT secret)
- **Startup Greeting**: Sends a time-appropriate greeting to the Telegram chat on startup
- **PostgreSQL Database**: Persistent storage for downloads and settings
- **Prometheus Metrics**: Export metrics for monitoring with Grafana

## Tech Stack

- **Backend**: Python, Flask, Flask-SocketIO, SQLAlchemy, Telethon, yt-dlp, paramiko (SFTP)
- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Database**: PostgreSQL
- **Monitoring**: Prometheus metrics endpoint

## Prerequisites

- Python 3.10+
- Node.js 18+ (also used as yt-dlp's JavaScript runtime for YouTube extraction)
- PostgreSQL
- yt-dlp

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

Edit `.env`:

```env
# Telegram API (get from https://my.telegram.org)
API_ID=your_api_id
API_HASH=your_api_hash
CHAT_ID=your_chat_id

# Paths
DOWNLOAD_DIR=/path/to/downloads

# Server
WEB_PORT=4444
WEB_HOST=0.0.0.0

# Database
DATABASE_URL=postgresql://downlee:your_password@localhost:5432/downlee
```

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

Access at **http://localhost:4444** (default login: `admin` / `admin`)

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

## Usage

### Telegram Downloads
Files sent to the configured Telegram chat/channel are automatically downloaded.

### URL Downloads
1. Click the **+** button (or just paste a URL anywhere on the downloads page)
2. Click "Check URL" to fetch formats
3. Select quality and click "Download"

### VPS / Seedbox Downloads
1. Configure the SSH connection in **Settings → VPS Connection** (password is stored encrypted)
2. Browse the remote filesystem and add watched folders
3. Open the **VPS Files** page to browse watched folders and download files/directories to the home server
4. Optionally give each watched folder a local destination folder, a hidden flag, and enable **autoSync** to pull new files automatically every hour

### Magnet Links (VPS Torrent Clients)
1. Configure **Transmission and/or qBittorrent** in **Settings → VPS Connection → Torrent Clients**. Each client takes a Web/RPC (Transmission) or WebUI (qBittorrent) URL + credentials, plus an optional default download folder and temp (incomplete) folder on the VPS. Test the connection, then Save.
2. Paste a magnet link on the downloads page — DownLee detects it, lets you **pick the client** (when more than one is configured), and sends it
3. Optionally pick a watched folder as the torrent's download directory so autoSync fetches the finished files
4. The **VPS page** has a tab per configured client showing live torrent status — search, filter by status, sort, and select multiple torrents to pause/resume/remove together. If a torrent reports missing data ("No data found"), use **Verify & start** to recheck and resume it.

**Telegram-channel magnets**: a magnet posted in a monitored channel is auto-added to a torrent client. Set a per-channel client in **Settings → Telegram**, or a global fallback in **Settings → VPS → Torrent Clients**. The bot replies to the message with live download progress and, on completion, a "reply *download*" prompt to pull the files to the home server.

### Per-Source Settings
Configure each source's destination folder, default quality, and hidden flag in **Settings → Sources**. Hidden sources/folders are filtered from the default view; reveal them with a triple-click on the connection status pill or **Ctrl+X**.

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

### Network Exposure

By default the server binds to `0.0.0.0` and allows all CORS origins (for both the REST API and the WebSocket) — this is intended for use on a **trusted LAN only**.

- **Do not expose DownLee directly to the internet.** If you need remote access, put it behind a reverse proxy (Caddy, nginx, Traefik) with HTTPS, and ideally restrict access further with a VPN (WireGuard, Tailscale) or proxy-level authentication.
- All `/api/*` routes require a JWT, but `/metrics` (Prometheus) is **unauthenticated** by design — anyone who can reach the port can read download stats from it.
- Change the default `admin`/`admin` credentials before the dashboard is reachable by anyone else.
- To bind to a specific interface instead of all of them, set `WEB_HOST` in `.env` (e.g. `WEB_HOST=192.168.1.10`, or `127.0.0.1` when fronted by a local reverse proxy).

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Login |
| `/api/auth/verify` | GET | Verify JWT token |
| `/api/auth/password` | POST | Change password |
| `/api/downloads` | GET | List downloads (supports `search`, `filter`, `sort_by`, `sort_order`, `author`, `limit`, `offset`, `include_hidden`) |
| `/api/authors` | GET | Get distinct author values for filtering |
| `/api/stats` | GET | Get statistics |
| `/api/url/check` | POST | Check URL formats |
| `/api/url/download` | POST | Start download |
| `/api/retry` | POST | Retry/resume a failed or stopped download |
| `/api/stop` | POST | Stop download |
| `/api/pause` / `/api/resume` | POST | Pause/resume a Telegram download |
| `/api/delete` | POST | Soft-delete download (sets `deleted_at` timestamp) |
| `/api/mappings` | GET/POST | Per-source download specs (folder, quality, hidden) |
| `/api/mappings/<id>` | PUT/DELETE | Update or delete a source spec |
| `/api/settings/vps` | GET/POST/DELETE | VPS SSH connection config |
| `/api/settings/vps/test` | POST | Test the VPS SSH connection |
| `/api/settings/vps/browse` | POST | Browse the remote VPS filesystem |
| `/api/settings/local/browse` | POST | Browse the local filesystem (folder pickers) |
| `/api/settings/vps/folders` | GET/POST | List/add watched VPS folders |
| `/api/settings/vps/folders/<id>` | PATCH/DELETE | Update specs (`auto_sync`, `folder`, `is_secured`) or remove a folder |
| `/api/vps/files` | GET | Live listing of watched VPS folders |
| `/api/vps/download` | POST | Download a VPS file/directory to the home server |
| `/api/vps/delete-remote` | POST | Delete a file/directory on the VPS |
| `/api/settings/torrent` | GET/POST/DELETE | Torrent client config (both Transmission + qBittorrent; POST/DELETE take a `client`) |
| `/api/settings/torrent/test` | POST | Test a client connection (`client`) |
| `/api/settings/torrent/telegram-default` | POST | Set the global fallback client for Telegram magnets |
| `/api/settings/telegram/channels/<id>` | PATCH | Set a channel's magnet torrent client (`torrent_client`) |
| `/api/torrent/add` | POST | Send a magnet to a client (`magnet`, `client`, `download_dir?`) |
| `/api/torrent/list` | GET | Live torrent status for a client (`?client=`) |
| `/api/torrent/action` | POST | Control torrents (`client`, `action` start/stop/remove/verify, `hashes`) |
| `/api/analytics` | GET | Get analytics data |
| `/api/settings/cookies` | GET/POST | Manage yt-dlp cookies |
| `/api/jobs/ytdlp-version` | GET | Get current yt-dlp version |
| `/api/jobs/ytdlp-upgrade` | POST | Upgrade yt-dlp to latest version |
| `/api/jobs/sync-thumbnails` | POST | Generate missing thumbnails and clean up orphans |
| `/api/video/check/<id>` | GET | Check if video file exists |
| `/api/video/stream/<id>` | GET | Stream video for playback |
| `/metrics` | GET | Prometheus metrics |

## Database Schema

### Downloads Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | Integer | Primary key |
| `message_id` | String | UUID (yt-dlp) or Telegram message ID |
| `file` | String | Filename |
| `status` | String | `downloading`, `done`, `failed`, `stopped` |
| `progress` | Float | 0-100% |
| `speed` | Float | KB/s |
| `error` | Text | Error message if failed |
| `downloaded_bytes` | BigInteger | Bytes downloaded so far |
| `total_bytes` | BigInteger | Total file size |
| `pending_time` | Float | Estimated seconds remaining |
| `downloaded_from` | String | `telegram`, `vps`, or domain name (e.g. `youtube`) |
| `url` | Text | Source URL for yt-dlp downloads |
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

Downloads use a `deleted_at` timestamp instead of a boolean flag. A download is considered active when `deleted_at IS NULL`. When deleted, `deleted_at` is set to the current timestamp, preserving when the deletion occurred.

### Other Tables

- `download_type_maps` — per-source specs: `downloaded_from` (unique), `folder`, `quality`, `is_secured`
- `vps_watch_folders` — watched VPS folders: remote `path`, owning connection (`host`/`port`/`username`), `auto_sync`, local destination `folder`, `is_secured`
- `settings` — key-value store (VPS connection, torrent client config, etc.; secrets encrypted)
- `users` — web login accounts

## Prometheus Metrics

DownLee exposes metrics at `/metrics` for Prometheus scraping:

- `downlee_downloads_total` - Total downloads by source and status
- `downlee_download_speed_bytes` - Current download speed
- `downlee_queue_size` - Active download queue size
- `downlee_db_downloads_count` - Database download counts by status

## License

Copyright © 2026 Ribin Roy

Licensed under the GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).

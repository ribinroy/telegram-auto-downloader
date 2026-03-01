# DownLee

A self-hosted media downloader with Telegram integration and a modern web dashboard. Automatically download files from Telegram chats/channels and URLs (YouTube, Twitter, Instagram, and 1000+ sites).

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
- **Quality Selection**: Choose video quality/resolution when downloading URLs
- **Real-time Progress**: WebSocket-based live progress tracking
- **Web Dashboard**: Modern React UI with search, filtering, sorting, and dark mode
- **Author Tracking**: Tracks who initiated each download (Telegram sender or logged-in web user)
- **Author Filtering**: Filter the download list by author
- **Analytics**: Visual charts showing download statistics over time
- **Soft Delete with Timestamps**: Deleted downloads retain a `deleted_at` timestamp instead of a simple boolean
- **Download Mappings**: Configure custom folders and default quality per source
- **Secured Sources**: Hide downloads from specific sources (secret 4-click toggle)
- **Video Playback**: Stream downloaded videos directly in the browser
- **User Authentication**: JWT-based login with password management
- **Startup Greeting**: Sends a time-appropriate greeting to the Telegram chat on startup
- **PostgreSQL Database**: Persistent storage for downloads and settings
- **Prometheus Metrics**: Export metrics for monitoring with Grafana

## Tech Stack

- **Backend**: Python, Flask, Flask-SocketIO, SQLAlchemy, Telethon, yt-dlp
- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Database**: PostgreSQL
- **Monitoring**: Prometheus metrics endpoint

## Prerequisites

- Python 3.10+
- Node.js 18+
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
1. Click the **+** button
2. Paste a video URL
3. Click "Check URL" to fetch formats
4. Select quality and click "Download"

### Download Mappings
1. Click 4 times on "Live" indicator to unlock settings
2. Configure per-source folders, quality, and visibility

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Login |
| `/api/auth/verify` | GET | Verify JWT token |
| `/api/auth/password` | POST | Change password |
| `/api/downloads` | GET | List downloads (supports `search`, `filter`, `sort_by`, `sort_order`, `author`, `limit`, `offset`, `exclude_mapping_ids`) |
| `/api/authors` | GET | Get distinct author values for filtering |
| `/api/stats` | GET | Get statistics |
| `/api/url/check` | POST | Check URL formats |
| `/api/url/download` | POST | Start download |
| `/api/retry` | POST | Retry failed download |
| `/api/stop` | POST | Stop download |
| `/api/delete` | POST | Soft-delete download (sets `deleted_at` timestamp) |
| `/api/mappings` | GET/POST | Manage download type mappings |
| `/api/mappings/<id>` | PUT/DELETE | Update or delete a mapping |
| `/api/analytics` | GET | Get analytics data |
| `/api/settings/cookies` | GET/POST | Manage yt-dlp cookies |
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
| `downloaded_from` | String | `telegram` or domain name (e.g. `youtube`) |
| `url` | Text | Source URL for yt-dlp downloads |
| `file_deleted` | Boolean | Whether the physical file was deleted from disk |
| `author` | String | Who initiated the download (see below) |
| `deleted_at` | Timestamp | Soft-delete timestamp (NULL = not deleted) |
| `created_at` | DateTime | When the download was created |
| `updated_at` | DateTime | Last update time |

### Author Tracking

The `author` column tracks who initiated each download:

- **Telegram downloads**: Stored as `username:user_id` (e.g. `RibinRoy:465457653`). Falls back to `post_author` for channel messages with signatures.
- **Web (DownLee) downloads**: Stored as the logged-in user's username (e.g. `admin`).

The UI displays only the name portion (before `:`) and shows the full `name:id` in a tooltip on hover.

### Soft Delete

Downloads use a `deleted_at` timestamp instead of a boolean flag. A download is considered active when `deleted_at IS NULL`. When deleted, `deleted_at` is set to the current timestamp, preserving when the deletion occurred.

## Prometheus Metrics

DownLee exposes metrics at `/metrics` for Prometheus scraping:

- `downlee_downloads_total` - Total downloads by source and status
- `downlee_download_speed_bytes` - Current download speed
- `downlee_queue_size` - Active download queue size
- `downlee_db_downloads_count` - Database download counts by status

## License

MIT

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
- **Analytics**: Visual charts showing download statistics over time
- **Download Mappings**: Configure custom folders and default quality per source
- **Secured Sources**: Hide downloads from specific sources (secret 4-click toggle)
- **Video Playback**: Stream downloaded videos directly in the browser
- **User Authentication**: JWT-based login with password management
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
| `/api/downloads` | GET | List downloads |
| `/api/stats` | GET | Get statistics |
| `/api/url/check` | POST | Check URL formats |
| `/api/url/download` | POST | Start download |
| `/api/retry` | POST | Retry failed download |
| `/api/stop` | POST | Stop download |
| `/api/delete` | POST | Delete download |
| `/api/mappings` | GET/POST | Manage mappings |
| `/api/analytics` | GET | Get analytics data |
| `/metrics` | GET | Prometheus metrics |

## Prometheus Metrics

DownLee exposes metrics at `/metrics` for Prometheus scraping:

- `downlee_downloads_total` - Total downloads by source and status
- `downlee_download_speed_bytes` - Current download speed
- `downlee_queue_size` - Active download queue size
- `downlee_db_downloads_count` - Database download counts by status

## License

MIT

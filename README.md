# Telegram Auto Downloader

Automatically download files from Telegram chats/channels and URLs (YouTube, Twitter, etc.) with a modern web dashboard.

## Features

- **Telegram Downloads**: Auto-download files from specified Telegram chat/channel
- **URL Downloads**: Download videos from YouTube, Twitter, TikTok, and 1000+ sites via yt-dlp
- **Quality Selection**: Choose video quality/resolution when downloading URLs
- **Real-time Progress**: WebSocket-based live progress tracking
- **Web Dashboard**: Modern React UI with search, filtering, and sorting
- **Download Mappings**: Configure custom folders and default quality per source
- **Secured Sources**: Hide downloads from specific sources (secret 4-click toggle)
- **User Authentication**: JWT-based login with password management
- **PostgreSQL Database**: Persistent storage for downloads and settings

## Prerequisites

- Python 3.10+
- Node.js 18+
- PostgreSQL
- yt-dlp (for URL downloads)

## Setup

### 1. Clone and create virtual environment

```bash
cd /home/hs/telegram-auto-downloader
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Install yt-dlp

```bash
pip install yt-dlp
# or
sudo apt install yt-dlp
```

### 3. Setup PostgreSQL database

```bash
sudo -u postgres psql
```

```sql
CREATE USER telegram_user WITH PASSWORD 'your_password';
CREATE DATABASE telegram_downloader OWNER telegram_user;
\q
```

### 4. Configure environment

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Telegram API (get from https://my.telegram.org)
API_ID=your_api_id
API_HASH=your_api_hash
CHAT_ID=your_chat_id

# Paths and Server
DOWNLOAD_DIR=/path/to/downloads
WEB_PORT=4444
WEB_HOST=0.0.0.0

# Database
DATABASE_URL=postgresql://telegram_user:your_password@localhost:5432/telegram_downloader

# Optional
MAX_RETRIES=6
```

### 5. Build frontend

```bash
cd frontend
npm install
npm run build
```

## Running the Application

### Option 1: Systemd Service (Recommended)

Create `/etc/systemd/system/telegram-downloader.service`:

```ini
[Unit]
Description=Telegram Auto Downloader
After=network.target postgresql.service

[Service]
Type=simple
User=your_user
WorkingDirectory=/home/hs/telegram-auto-downloader
Environment=PATH=/home/hs/telegram-auto-downloader/venv/bin
ExecStart=/home/hs/telegram-auto-downloader/venv/bin/python main.py
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable telegram-downloader
sudo systemctl start telegram-downloader
```

### Option 2: Manual

```bash
cd /home/hs/telegram-auto-downloader
source venv/bin/activate
python main.py
```

### Access

- **Web Interface**: http://localhost:4444
- Default login: `admin` / `admin` (change password after first login)

## Usage

### Telegram Downloads
Files sent to the configured Telegram chat/channel are automatically downloaded.

### URL Downloads
1. Click the **+** button in the web interface
2. Paste a video URL (YouTube, Twitter, etc.)
3. Click "Check URL" to fetch available formats
4. Select desired quality
5. Click "Download"

### Download Mappings (Hidden Feature)
1. Click 4 times on "Live" status indicator to unlock
2. Go to Settings > Mappings tab
3. Configure per-source settings:
   - **Folder**: Custom download location
   - **Quality**: Default quality (e.g., "720p")
   - **Secured**: Hide downloads from this source

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login and get JWT token
- `GET /api/auth/verify` - Verify token validity
- `POST /api/auth/password` - Update password

### Downloads
- `GET /api/downloads` - Get all downloads with stats
- `GET /api/stats` - Get download statistics
- `POST /api/retry` - Retry a failed download
- `POST /api/stop` - Stop a download
- `POST /api/delete` - Delete a download

### URL Downloads
- `POST /api/url/check` - Check URL and get available formats
- `POST /api/url/download` - Start URL download

### Mappings
- `GET /api/mappings` - Get all download type mappings
- `GET /api/mappings/secured` - Get secured source list
- `GET /api/mappings/source/:source` - Get mapping for specific source
- `POST /api/mappings` - Add new mapping
- `PUT /api/mappings/:id` - Update mapping
- `DELETE /api/mappings/:id` - Delete mapping

## WebSocket Events

- `download:progress` - Real-time download progress
- `download:status` - Download status changes
- `download:new` - New download added
- `download:deleted` - Download removed

## Tech Stack

- **Backend**: Python, Flask, Flask-SocketIO, SQLAlchemy, Telethon, yt-dlp
- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Database**: PostgreSQL

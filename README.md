# Telegram Auto Downloader

Automatically download files from a Telegram chat/channel with a web-based dashboard.

## Features

- Auto-download files from specified Telegram chat/channel
- Real-time progress tracking via WebSocket
- Web dashboard with search and filtering
- PostgreSQL database for persistent storage
- Settings configurable via web interface

## Prerequisites

- Python 3.10+
- Node.js 18+
- PostgreSQL

## Setup

### 1. Clone and create virtual environment

```bash
cd /home/hs/telegram-auto-downloader
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Setup PostgreSQL database

```bash
sudo -u postgres psql
```

```sql
CREATE USER telegram_user WITH PASSWORD 'your_password';
CREATE DATABASE telegram_downloader OWNER telegram_user;
\q
```

### 3. Configure environment

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env`:

```env
DOWNLOAD_DIR=/path/to/downloads
WEB_PORT=4444
WEB_HOST=0.0.0.0
MAX_RETRIES=6
DATABASE_URL=postgresql://telegram_user:your_password@localhost:5432/telegram_downloader
```

### 4. Install frontend dependencies

```bash
cd frontend
npm install
```

### 5. Configure Telegram credentials

Telegram API credentials are stored in the database. On first run, configure them via the web interface at `http://localhost:5173` (Settings icon).

You'll need:
- **API_ID** and **API_HASH** from https://my.telegram.org
- **CHAT_ID** of the chat/channel to monitor (forward a message to @userinfobot to get it)

## Running the Application

### Terminal 1 - Backend

```bash
cd /home/hs/telegram-auto-downloader
source venv/bin/activate
python main.py
```

### Terminal 2 - Frontend

```bash
cd /home/hs/telegram-auto-downloader/frontend
npm run dev
```

### Access

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:4444

## API Endpoints

- `GET /api/downloads` - Get all downloads with stats
- `GET /api/stats` - Get download statistics
- `GET /api/settings` - Get current settings
- `PUT /api/settings` - Update settings
- `POST /api/retry` - Retry a failed download
- `POST /api/stop` - Stop a download
- `POST /api/delete` - Delete a download

## WebSocket Events

- `downloads_update` - Real-time download progress updates

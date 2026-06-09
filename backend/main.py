"""
Main entry point for DownLee
"""
import asyncio
import logging
import threading
from backend.config import LOG_FILE, DATABASE_URL
from backend.database import init_database
from backend.telegram_handler import TelegramDownloader
from backend.ytdlp_handler import YtdlpDownloader
from backend.vps_handler import VpsDownloader
from backend.web_app import WebApp


def setup_logging():
    """Setup logging configuration"""
    logging.basicConfig(
        filename=str(LOG_FILE),
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s"
    )


def validate_credentials():
    """Warn about missing Telegram credentials in .env (non-fatal).

    API credentials and monitored channels can all be configured from the
    web UI (Settings -> Telegram) and are stored in the database; .env
    values only act as fallback/seed."""
    from backend.config import API_ID, API_HASH

    warnings = []

    if not API_ID or API_ID == 0:
        warnings.append("API_ID is not set in .env file")

    if not API_HASH or API_HASH == 'your_api_hash_here':
        warnings.append("API_HASH is not set in .env file")

    if warnings:
        print("⚠️  Telegram credentials missing from .env (can be set in the web UI instead):")
        for warning in warnings:
            print(f"   - {warning}")

    return True


def main():
    """Main function to start DownLee"""
    # Setup logging
    setup_logging()

    # Initialize database first
    print("📊 Initializing database...")
    init_database(DATABASE_URL)

    # Validate credentials
    if not validate_credentials():
        return

    # Shared download state
    download_tasks = {}  # key: message_id, value: asyncio.Task

    # Create event loop for async operations
    loop = asyncio.new_event_loop()

    # Initialize components
    telegram_downloader = TelegramDownloader(download_tasks)
    ytdlp_downloader = YtdlpDownloader(download_tasks)
    vps_downloader = VpsDownloader(download_tasks, loop)
    web_app = WebApp(download_tasks, ytdlp_downloader, loop, telegram_downloader, vps_downloader)

    # Start Flask in a separate thread
    flask_thread = threading.Thread(target=web_app.run, daemon=True)
    flask_thread.start()

    # Run event loop in a separate thread for yt-dlp async operations
    def run_loop():
        asyncio.set_event_loop(loop)
        print("🔄 Event loop starting...")
        loop.run_forever()

    loop_thread = threading.Thread(target=run_loop, daemon=True)
    loop_thread.start()

    # Give the loop thread a moment to start
    import time
    time.sleep(0.5)

    print("🎬 yt-dlp downloader ready")
    print(f"   Event loop running: {loop.is_running()}")

    # Start VPS autoSync scheduler (hourly check of watched folders)
    vps_downloader.start_autosync()
    print("🗄️  VPS autoSync scheduler started")

    # Start Telegram client (this will block)
    telegram_downloader.start()


if __name__ == "__main__":
    main()

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
from backend.web_app import WebApp


def setup_logging():
    """Setup logging configuration"""
    logging.basicConfig(
        filename=str(LOG_FILE),
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s"
    )


def check_telegram_config():
    """Check if Telegram is configured (from JSON file or .env)"""
    from backend.config import load_telegram_config

    config = load_telegram_config()

    if not config['api_id'] or not config['api_hash'] or not config['chat_id']:
        print("⚠️  Telegram not configured yet")
        print("   Configure via web UI: Settings → Telegram → Connect")
        return False

    return True


def main():
    """Main function to start DownLee"""
    # Setup logging
    setup_logging()

    # Initialize database first
    print("📊 Initializing database...")
    init_database(DATABASE_URL)

    # Check if Telegram is configured (just informational, don't exit)
    telegram_configured = check_telegram_config()

    # Shared download state
    download_tasks = {}  # key: message_id, value: asyncio.Task

    # Create event loop for async operations
    loop = asyncio.new_event_loop()

    # Initialize components
    telegram_downloader = TelegramDownloader(download_tasks)
    ytdlp_downloader = YtdlpDownloader(download_tasks)
    web_app = WebApp(download_tasks, ytdlp_downloader, loop)

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

    # Start Telegram client (this will block, or wait for config if not configured)
    telegram_downloader.start()


if __name__ == "__main__":
    main()

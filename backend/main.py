"""
Main entry point for Telegram Downloader
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


def validate_credentials():
    """Validate credentials from .env file"""
    from backend.config import API_ID, API_HASH, CHAT_ID

    errors = []

    # Check API_ID from .env
    if not API_ID or API_ID == 0:
        errors.append("API_ID is not set in .env file")

    # Check API_HASH from .env
    if not API_HASH or API_HASH == 'your_api_hash_here':
        errors.append("API_HASH is not set in .env file")

    # Check CHAT_ID from .env
    if not CHAT_ID or CHAT_ID == 0:
        errors.append("CHAT_ID is not set in .env file")

    if errors:
        print("❌ Configuration Error:")
        for error in errors:
            print(f"   - {error}")
        return False

    return True


def main():
    """Main function to start the Telegram Downloader"""
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
    web_app = WebApp(download_tasks, ytdlp_downloader, loop)

    # Start Flask in a separate thread
    flask_thread = threading.Thread(target=web_app.run, daemon=True)
    flask_thread.start()

    # Run event loop in a separate thread for yt-dlp async operations
    def run_loop():
        asyncio.set_event_loop(loop)
        loop.run_forever()

    loop_thread = threading.Thread(target=run_loop, daemon=True)
    loop_thread.start()

    print("🎬 yt-dlp downloader ready")

    # Start Telegram client (this will block)
    telegram_downloader.start()


if __name__ == "__main__":
    main()

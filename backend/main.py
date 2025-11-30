"""
Main entry point for Telegram Downloader
"""
import logging
import threading
from backend.config import LOG_FILE, DATABASE_URL
from backend.database import init_database
from backend.telegram_handler import TelegramDownloader
from backend.web_app import WebApp


def setup_logging():
    """Setup logging configuration"""
    logging.basicConfig(
        filename=str(LOG_FILE),
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s"
    )


def validate_credentials_from_db():
    """Validate credentials from database settings"""
    from backend.database import get_db
    db = get_db()
    settings = db.get_all_settings()

    errors = []

    api_id = settings.get('api_id')
    api_hash = settings.get('api_hash')
    chat_id = settings.get('chat_id')

    if not api_id or api_id == '0':
        errors.append("API_ID is not set in database settings")

    if not api_hash or api_hash == 'your_api_hash_here':
        errors.append("API_HASH is not set in database settings")

    if not chat_id or chat_id == '0':
        errors.append("CHAT_ID is not set in database settings")

    if errors:
        print("❌ Configuration Error (from database):")
        for error in errors:
            print(f"   - {error}")
        print("\n📝 Please configure settings via the web interface at http://localhost:4444")
        return False

    return True


def main():
    """Main function to start the Telegram Downloader"""
    # Setup logging
    setup_logging()

    # Initialize database first
    print("📊 Initializing database...")
    init_database(DATABASE_URL)

    # Validate credentials from database
    if not validate_credentials_from_db():
        return

    # Shared download state
    download_tasks = {}  # key: filename, value: asyncio.Task

    # Initialize components
    telegram_downloader = TelegramDownloader(download_tasks)
    web_app = WebApp(download_tasks)

    # Start Flask in a separate thread
    flask_thread = threading.Thread(target=web_app.run, daemon=True)
    flask_thread.start()

    # Start Telegram client (this will block)
    telegram_downloader.start()


if __name__ == "__main__":
    main()

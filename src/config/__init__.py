"""
Configuration module for Telegram Downloader
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Base directory - read from .env or use project root as fallback
_base_dir_env = os.getenv('BASE_DIR', '').strip().strip('"').strip("'")
BASE_DIR = Path(_base_dir_env) if _base_dir_env else Path(__file__).parent.parent.parent

# Download directory - read from .env or use BASE_DIR/downloads as fallback
_download_dir_env = os.getenv('DOWNLOAD_DIR', '').strip().strip('"').strip("'")
DOWNLOAD_DIR = Path(_download_dir_env) if _download_dir_env else BASE_DIR / "downloads"

LOGS_DIR = BASE_DIR / "logs"

# Telegram API Configuration - loaded from environment variables
API_ID = int(os.getenv('API_ID', '0'))
API_HASH = os.getenv('API_HASH', 'your_api_hash_here')
CHAT_ID = int(os.getenv('CHAT_ID', '0'))

# Validate configuration
def validate_config():
    """Validate that required configuration is set"""
    errors = []
    
    if API_ID == 0 or API_ID == '0':
        errors.append("API_ID is not set or is invalid")
    
    if API_HASH == 'your_api_hash_here' or not API_HASH:
        errors.append("API_HASH is not set")
    
    if CHAT_ID == 0 or CHAT_ID == '0':
        errors.append("CHAT_ID is not set or is invalid")
    
    if errors:
        print("❌ Configuration Error:")
        for error in errors:
            print(f"   - {error}")
        print("\n📝 Please set up your .env file:")
        print("   1. Copy .env.example to .env: cp .env.example .env")
        print("   2. Edit .env with your actual API credentials")
        print("   3. Get credentials from https://my.telegram.org")
        return False
    
    return True

# Web Interface Configuration
WEB_PORT = int(os.getenv('WEB_PORT', '4444'))
WEB_HOST = os.getenv('WEB_HOST', '0.0.0.0')

# Download Configuration
MAX_RETRIES = int(os.getenv('MAX_RETRIES', '6'))

# Database Configuration
DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://postgres:password@localhost:5432/telegram_downloader')
SESSION_FILE = BASE_DIR / "downloader_session"
DOWNLOADS_JSON = BASE_DIR / "downloads.json"
LOG_FILE = LOGS_DIR / "telegram_downloader.log"

# Create necessary directories
DOWNLOAD_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)

# Media type folders
MEDIA_FOLDERS = {
    "Documents": "Documents",
    "Images": "Images", 
    "Videos": "Videos"
}

"""
Configuration module for DownLee
"""
import os
import json
from pathlib import Path
from dotenv import load_dotenv

# Project root is two levels up from backend/config/
PROJECT_ROOT = Path(__file__).parent.parent.parent

# Load environment variables from .env file in project root
load_dotenv(PROJECT_ROOT / ".env")

# Base directory - read from .env or use project root as fallback
_base_dir_env = os.getenv('BASE_DIR', '').strip().strip('"').strip("'")
BASE_DIR = Path(_base_dir_env) if _base_dir_env else PROJECT_ROOT

# Download directory - read from .env or use BASE_DIR/downloads as fallback
_download_dir_env = os.getenv('DOWNLOAD_DIR', '').strip().strip('"').strip("'")
DOWNLOAD_DIR = Path(_download_dir_env) if _download_dir_env else BASE_DIR / "downloads"

LOGS_DIR = BASE_DIR / "logs"

# Telegram config file (for web UI configuration)
TELEGRAM_CONFIG_FILE = BASE_DIR / "telegram_config.json"


def load_telegram_config():
    """Load Telegram config from JSON file, fallback to env vars"""
    config = {
        'api_id': int(os.getenv('API_ID', '0')),
        'api_hash': os.getenv('API_HASH', ''),
        'chat_id': int(os.getenv('CHAT_ID', '0'))
    }

    # Try to load from config file (overrides env vars)
    if TELEGRAM_CONFIG_FILE.exists():
        try:
            with open(TELEGRAM_CONFIG_FILE, 'r') as f:
                file_config = json.load(f)
                if file_config.get('api_id'):
                    config['api_id'] = int(file_config['api_id'])
                if file_config.get('api_hash'):
                    config['api_hash'] = file_config['api_hash']
                if file_config.get('chat_id'):
                    config['chat_id'] = int(file_config['chat_id'])
        except (json.JSONDecodeError, ValueError):
            pass

    return config


def save_telegram_config(api_id: int, api_hash: str, chat_id: int):
    """Save Telegram config to JSON file"""
    config = {
        'api_id': api_id,
        'api_hash': api_hash,
        'chat_id': chat_id
    }
    with open(TELEGRAM_CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)
    return True


def get_telegram_config():
    """Get current Telegram config (for API responses)"""
    config = load_telegram_config()
    return {
        'api_id': config['api_id'],
        'api_hash': config['api_hash'][:8] + '...' if config['api_hash'] else '',  # Masked
        'chat_id': config['chat_id'],
        'configured': bool(config['api_id'] and config['api_hash'] and config['chat_id'])
    }


# Load Telegram config
_telegram_config = load_telegram_config()
API_ID = _telegram_config['api_id']
API_HASH = _telegram_config['api_hash']
CHAT_ID = _telegram_config['chat_id']

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

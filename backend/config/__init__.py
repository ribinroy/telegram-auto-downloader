"""
Configuration module for DownLee
"""
import os
import secrets as _secrets
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

    # CHAT_ID is optional: channels are managed via the web UI and stored in
    # the database; a CHAT_ID here only seeds the initial channel list.

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

# Application secret - signs JWT auth tokens and derives the Fernet key used
# to encrypt secrets stored in the settings table (VPS/torrent passwords,
# Telegram API hash). Resolution order:
#   1. JWT_SECRET environment variable (set it in .env for a stable secret)
#   2. A previously generated secret persisted in BASE_DIR/.jwt_secret
#   3. A freshly generated random secret, written to BASE_DIR/.jwt_secret
#      (mode 0600) so it survives restarts
# Changing the secret invalidates existing logins; stored secrets encrypted
# under the old key are migrated lazily by backend.utils.decrypt_secret().
JWT_SECRET_FILE = BASE_DIR / ".jwt_secret"


def _resolve_jwt_secret():
    env_secret = (os.getenv('JWT_SECRET') or '').strip()
    if env_secret:
        return env_secret
    try:
        persisted = JWT_SECRET_FILE.read_text().strip()
        if persisted:
            return persisted
    except OSError:
        pass
    secret = _secrets.token_urlsafe(48)
    JWT_SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(JWT_SECRET_FILE), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(secret + "\n")
    return secret


JWT_SECRET = _resolve_jwt_secret()

# Download Configuration
MAX_RETRIES = int(os.getenv('MAX_RETRIES', '6'))

# Screenshots directory for video thumbnails
_screenshots_dir_env = os.getenv('SCREENSHOTS_DIR', '').strip().strip('"').strip("'")
SCREENSHOTS_DIR = Path(_screenshots_dir_env) if _screenshots_dir_env else DOWNLOAD_DIR / '.thumbs'

# Database Configuration
DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://postgres:password@localhost:5432/telegram_downloader')
SESSION_FILE = BASE_DIR / "downloader_session"
DOWNLOADS_JSON = BASE_DIR / "downloads.json"
LOG_FILE = LOGS_DIR / "telegram_downloader.log"

# Create necessary directories
DOWNLOAD_DIR.mkdir(exist_ok=True)
LOGS_DIR.mkdir(exist_ok=True)
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

# Media type folders
MEDIA_FOLDERS = {
    "Documents": "Documents",
    "Images": "Images", 
    "Videos": "Videos"
}

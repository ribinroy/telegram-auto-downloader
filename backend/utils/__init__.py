"""
Utility functions for DownLee
"""
import os
import json
import base64
import hashlib
from datetime import datetime
from pathlib import Path


def _fernet():
    """Build a Fernet cipher keyed off the app's JWT secret.

    The key is derived (not stored) so secrets in the DB can only be
    decrypted by an instance that knows JWT_SECRET. Set a stable
    JWT_SECRET in .env in production, otherwise saved secrets become
    unreadable when the fallback secret changes.
    """
    from cryptography.fernet import Fernet
    secret = os.environ.get('JWT_SECRET', 'telegram-downloader-secret-key-change-in-prod')
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
    return Fernet(key)


def encrypt_secret(plaintext: str) -> str:
    """Encrypt a secret string for at-rest storage. Returns a token string."""
    if plaintext is None:
        plaintext = ''
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(token: str) -> str:
    """Decrypt a token produced by encrypt_secret. Returns '' on failure."""
    if not token:
        return ''
    try:
        return _fernet().decrypt(token.encode()).decode()
    except Exception:
        return ''


def resolve_label(source, override_label_id=None, path=None):
    """Resolve the label dict for a download: an explicit override wins,
    otherwise a per-path source binding (longest matching prefix of `path`),
    otherwise the source-wide default, otherwise None."""
    from backend.database import get_db
    db = get_db()
    if override_label_id:
        label = db.get_label(override_label_id)
        if label:
            return label
    return db.get_label_for_source(source, path)


def label_folder(label, default: Path) -> Path:
    """Return the label's folder (created if needed), or `default` if the
    label has no usable folder."""
    if label and label.get('folder'):
        try:
            folder = Path(label['folder'])
            folder.mkdir(parents=True, exist_ok=True)
            return folder
        except (OSError, PermissionError):
            pass
    return default


def save_state(downloads, downloads_json_path):
    """Save download state to JSON file"""
    with open(downloads_json_path, "w") as f:
        json.dump(downloads, f, indent=2, default=str)


def load_state(downloads_json_path):
    """Load previous downloads from JSON file"""
    try:
        with open(downloads_json_path, "r") as f:
            saved_data = json.load(f)
            if isinstance(saved_data, list):
                return saved_data
            else:
                return saved_data.get("downloads", [])
    except Exception:
        return []


def human_readable_size(num_bytes):
    """Convert bytes to human readable format"""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if num_bytes < 1024:
            return f"{num_bytes:.1f}{unit}"
        num_bytes /= 1024
    return f"{num_bytes:.1f}PB"


def format_time(seconds):
    """Format seconds into human readable time"""
    if not seconds:
        return "-"
    seconds = int(seconds)
    h, m = divmod(seconds, 3600)
    m, s = divmod(m, 60)
    if h > 0:
        return f"{h}h {m}m {s}s"
    elif m > 0:
        return f"{m}m {s}s"
    else:
        return f"{s}s"


def get_media_folder(mime_type):
    """Determine folder based on mime type"""
    if mime_type:
        if mime_type.startswith("image/"):
            return "Images"
        elif mime_type.startswith("video/"):
            return "Videos"
    return "Documents"

"""
Migration script to import existing JSON data into PostgreSQL database
"""
import json
from datetime import datetime
from backend.config import DATABASE_URL
from backend.database import init_database, get_db

JSON_FILE = "/home/hs/telegram_downloader/downloads.json"


def migrate():
    print("📊 Initializing database...")
    init_database(DATABASE_URL)
    db = get_db()

    print(f"📂 Reading JSON file: {JSON_FILE}")
    with open(JSON_FILE, 'r') as f:
        data = json.load(f)

    # Handle both list format and dict with "downloads" key
    if isinstance(data, dict):
        downloads = data.get('downloads', [])
    else:
        downloads = data

    print(f"📝 Found {len(downloads)} records to migrate")

    migrated = 0
    skipped = 0

    for entry in downloads:
        filename = entry.get('file', '')
        if not filename:
            skipped += 1
            continue

        # Parse timestamp
        timestamp_str = entry.get('timestamp')
        timestamp = None
        if timestamp_str:
            try:
                timestamp = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
            except:
                timestamp = datetime.utcnow()

        # Map old status to new
        status = entry.get('status', 'downloading')
        if status == 'done':
            status = 'done'
        elif status == 'failed':
            status = 'failed'
        elif status == 'stopped':
            status = 'stopped'
        else:
            status = 'downloading'

        # Add to database
        db.add_download(
            file=filename,
            status=status,
            progress=entry.get('progress', 0) or 0,
            speed=entry.get('speed', 0) or 0,
            error=entry.get('error'),
            downloaded_bytes=entry.get('downloaded_bytes', 0) or 0,
            total_bytes=entry.get('total_bytes', 0) or 0,
            pending_time=entry.get('pending_time')
        )
        migrated += 1

        if migrated % 100 == 0:
            print(f"  Migrated {migrated} records...")

    print(f"\n✅ Migration complete!")
    print(f"   - Migrated: {migrated}")
    print(f"   - Skipped (empty filename): {skipped}")


if __name__ == "__main__":
    migrate()

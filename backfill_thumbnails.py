#!/usr/bin/env python3
"""
Backfill script: Generates thumbnails for existing completed video downloads.
Safe to run while the service is running - uses its own DB session.

Also backfills the thumb_count DB column for downloads that already have
thumbnails on disk but no count stored yet.
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from backend.config import DATABASE_URL, SCREENSHOTS_DIR
from backend.database import DatabaseManager, Download, init_database
from backend.file_meta import (
    find_file, is_video_file, generate_thumbnails, VIDEO_EXTENSIONS
)


def main():
    print(f"Connecting to database: {DATABASE_URL[:30]}...")
    print(f"Screenshots dir: {SCREENSHOTS_DIR}")
    init_database(DATABASE_URL)
    db = DatabaseManager(DATABASE_URL)

    session = db.get_session()
    try:
        downloads = session.query(Download).filter(
            Download.status == 'done',
            Download.file_meta != None,
            Download.deleted_at == None,
        ).all()

        print(f"Found {len(downloads)} completed downloads with file_meta")

        generated = 0
        skipped_exists = 0
        skipped_no_duration = 0
        not_video = 0
        not_found = 0
        backfilled_count = 0

        for dl in downloads:
            file_name = dl.file
            if not file_name:
                continue

            if not is_video_file(file_name):
                not_video += 1
                continue

            dl_id = dl.id

            # Skip if thumbnails already exist on disk
            thumb_dir = SCREENSHOTS_DIR / str(dl_id)
            if thumb_dir.exists() and any(thumb_dir.glob('*.jpg')):
                # Backfill thumb_count in DB if missing
                if not dl.thumb_count:
                    count = len([f for f in thumb_dir.iterdir() if f.suffix == '.jpg'])
                    dl.thumb_count = count
                    session.commit()
                    backfilled_count += 1
                skipped_exists += 1
                continue

            # Parse duration from file_meta
            try:
                meta = json.loads(dl.file_meta) if isinstance(dl.file_meta, str) else dl.file_meta
            except (json.JSONDecodeError, TypeError):
                continue

            duration = meta.get('duration')
            if not duration or duration <= 0:
                skipped_no_duration += 1
                continue

            file_path = find_file(file_name, dl.downloaded_from)
            if not file_path:
                not_found += 1
                continue

            count = asyncio.run(generate_thumbnails(dl_id, str(file_path), duration))
            if count:
                generated += 1
                print(f"  OK: {file_name} ({count} thumbs)")
            else:
                print(f"  FAIL: {file_name}")

        print(f"\nDone! Generated: {generated}, Already had thumbs: {skipped_exists}, "
              f"No duration: {skipped_no_duration}, Not video: {not_video}, "
              f"File not found: {not_found}, DB counts backfilled: {backfilled_count}")

    finally:
        db.close_session()


if __name__ == '__main__':
    main()

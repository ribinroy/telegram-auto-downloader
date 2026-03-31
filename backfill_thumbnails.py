#!/usr/bin/env python3
"""
Thumbnail sync script: ensures thumbnails match the actual file state on disk.

- File exists, thumbnails missing → generate thumbnails
- File exists, thumbnails exist → skip (update DB count if needed)
- File missing, thumbnails exist → delete thumbnails
- Updates thumb_count in DB to stay in sync
"""
import asyncio
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from backend.config import DATABASE_URL, SCREENSHOTS_DIR
from backend.database import DatabaseManager, Download, init_database
from backend.file_meta import (
    find_file, is_video_file, generate_thumbnails, extract_meta, probe_video
)


async def async_main():
    print(f"Connecting to database: {DATABASE_URL[:30]}...")
    print(f"Screenshots dir: {SCREENSHOTS_DIR}")
    init_database(DATABASE_URL)
    db = DatabaseManager(DATABASE_URL)

    session = db.get_session()
    try:
        downloads = session.query(Download).filter(
            Download.status == 'done',
            Download.deleted_at == None,
        ).all()

        print(f"Found {len(downloads)} completed downloads\n")

        stats = {
            'generated': 0,
            'skipped': 0,
            'orphan_deleted': 0,
            'db_count_fixed': 0,
            'meta_extracted': 0,
            'not_video': 0,
            'no_duration': 0,
            'failed': 0,
        }

        for dl in downloads:
            file_name = dl.file
            if not file_name or not is_video_file(file_name):
                stats['not_video'] += 1
                continue

            dl_id = dl.id
            thumb_dir = SCREENSHOTS_DIR / str(dl_id)
            has_thumbs = thumb_dir.exists() and any(thumb_dir.glob('*.jpg'))
            file_path = find_file(file_name, dl.downloaded_from)

            # Case: file missing, thumbnails exist → delete orphan thumbnails
            if not file_path and has_thumbs:
                shutil.rmtree(thumb_dir, ignore_errors=True)
                dl.thumb_count = 0
                session.commit()
                stats['orphan_deleted'] += 1
                print(f"  DELETED orphan thumbs: {file_name} (id={dl_id})")
                continue

            # Case: file missing, no thumbnails → nothing to do
            if not file_path:
                continue

            # Case: file exists, thumbnails exist → sync DB count
            if has_thumbs:
                actual_count = len([f for f in thumb_dir.iterdir() if f.suffix == '.jpg'])
                if dl.thumb_count != actual_count:
                    dl.thumb_count = actual_count
                    session.commit()
                    stats['db_count_fixed'] += 1
                    print(f"  FIXED count: {file_name} (id={dl_id}, count={actual_count})")
                stats['skipped'] += 1
                continue

            # Case: file exists, thumbnails missing → extract meta if needed, then generate

            # Extract meta if missing
            duration = None
            if dl.file_meta:
                try:
                    meta = json.loads(dl.file_meta) if isinstance(dl.file_meta, str) else dl.file_meta
                    duration = meta.get('duration')
                except (json.JSONDecodeError, TypeError):
                    pass

            if not duration:
                probe_data = await probe_video(str(file_path))
                if probe_data:
                    meta = extract_meta(probe_data)
                    if meta.get('video'):
                        dl.file_meta = json.dumps(meta)
                        session.commit()
                        duration = meta.get('duration')
                        stats['meta_extracted'] += 1
                        print(f"  META extracted: {file_name} (id={dl_id})")

            if not duration or duration <= 0:
                stats['no_duration'] += 1
                continue

            count = await generate_thumbnails(dl_id, str(file_path), duration)
            if count:
                dl.thumb_count = count
                session.commit()
                stats['generated'] += 1
                print(f"  OK: {file_name} (id={dl_id}, {count} thumbs)")
            else:
                stats['failed'] += 1
                print(f"  FAIL: {file_name} (id={dl_id})")

        print(f"\nSync complete!")
        print(f"  Generated: {stats['generated']}")
        print(f"  Already had thumbs: {stats['skipped']}")
        print(f"  Orphan thumbs deleted: {stats['orphan_deleted']}")
        print(f"  DB counts fixed: {stats['db_count_fixed']}")
        print(f"  Meta extracted: {stats['meta_extracted']}")
        print(f"  No duration: {stats['no_duration']}")
        print(f"  Not video: {stats['not_video']}")
        print(f"  Failed: {stats['failed']}")

    finally:
        db.close_session()


def main():
    asyncio.run(async_main())


if __name__ == '__main__':
    main()

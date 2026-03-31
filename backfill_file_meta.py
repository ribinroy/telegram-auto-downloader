#!/usr/bin/env python3
"""
Backfill script: Populates file_meta column for existing video downloads.
Probes video files using ffprobe and stores video/audio metadata as JSON.

Safe to run while the service is running - uses its own DB session.
"""
import json
import subprocess
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent))

from backend.config import DOWNLOAD_DIR, DATABASE_URL
from backend.database import DatabaseManager, Download

VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv', '.wmv'}


def probe_video(file_path: str) -> dict | None:
    """Run ffprobe on a video file and return parsed metadata."""
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_streams', '-show_format', str(file_path)
            ],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        return None


def extract_meta(probe_data: dict) -> dict:
    """Extract structured metadata from ffprobe output."""
    meta = {}

    for stream in probe_data.get('streams', []):
        codec_type = stream.get('codec_type')

        if codec_type == 'video' and 'video' not in meta:
            meta['video'] = {
                'codec': stream.get('codec_name', 'unknown'),
                'width': int(stream.get('width', 0)),
                'height': int(stream.get('height', 0)),
            }
            if stream.get('bit_rate'):
                meta['video']['bitrate'] = int(stream['bit_rate'])
            # Parse fps from r_frame_rate (e.g., "30/1" or "24000/1001")
            r_frame_rate = stream.get('r_frame_rate', '')
            if '/' in r_frame_rate:
                num, den = r_frame_rate.split('/')
                if int(den) > 0:
                    meta['video']['fps'] = round(int(num) / int(den), 2)

        elif codec_type == 'audio' and 'audio' not in meta:
            meta['audio'] = {
                'codec': stream.get('codec_name', 'unknown'),
            }
            if stream.get('channels'):
                meta['audio']['channels'] = int(stream['channels'])
            if stream.get('sample_rate'):
                meta['audio']['sample_rate'] = int(stream['sample_rate'])
            if stream.get('bit_rate'):
                meta['audio']['bitrate'] = int(stream['bit_rate'])

    fmt = probe_data.get('format', {})
    if fmt.get('duration'):
        meta['duration'] = round(float(fmt['duration']), 2)
    if fmt.get('format_name'):
        meta['format'] = fmt['format_name']

    return meta


def find_file(file_name: str, downloaded_from: str, db: DatabaseManager) -> Path | None:
    """Find the physical file on disk, checking common locations and custom mappings."""
    possible_paths = [
        DOWNLOAD_DIR / file_name,
        DOWNLOAD_DIR / "Videos" / file_name,
    ]

    if downloaded_from:
        mapping = db.get_download_type_map(downloaded_from)
        if mapping and mapping.get("folder"):
            possible_paths.insert(0, Path(mapping["folder"]) / file_name)

    for p in possible_paths:
        if p.exists():
            return p
    return None


def main():
    print(f"Connecting to database: {DATABASE_URL[:30]}...")
    db = DatabaseManager(DATABASE_URL)

    session = db.get_session()
    try:
        # Get all completed downloads that don't have file_meta yet
        downloads = session.query(Download).filter(
            Download.status == 'done',
            Download.file_meta == None,
            Download.deleted_at == None,
        ).all()

        print(f"Found {len(downloads)} completed downloads without file_meta")

        updated = 0
        skipped = 0
        not_video = 0
        not_found = 0

        for dl in downloads:
            file_name = dl.file
            if not file_name:
                skipped += 1
                continue

            # Check if it's a video file by extension
            suffix = Path(file_name).suffix.lower()
            if suffix not in VIDEO_EXTENSIONS:
                not_video += 1
                continue

            file_path = find_file(file_name, dl.downloaded_from, db)
            if not file_path:
                not_found += 1
                continue

            probe_data = probe_video(file_path)
            if not probe_data:
                print(f"  SKIP (probe failed): {file_name}")
                skipped += 1
                continue

            meta = extract_meta(probe_data)
            if not meta.get('video'):
                print(f"  SKIP (no video stream): {file_name}")
                skipped += 1
                continue

            res = f"{meta['video']['width']}x{meta['video']['height']}"
            dl.file_meta = json.dumps(meta)
            updated += 1
            print(f"  OK [{res}]: {file_name}")

        session.commit()
        print(f"\nDone! Updated: {updated}, Skipped: {skipped}, Not video: {not_video}, File not found: {not_found}")

    finally:
        db.close_session()


if __name__ == '__main__':
    main()

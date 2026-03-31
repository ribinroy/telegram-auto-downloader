"""
Video file metadata extraction and auto-population.

Probes video files using ffprobe and stores video/audio metadata as JSON
in the file_meta column. Integrates into the download flow so metadata
is extracted automatically once a video download completes.
"""
import asyncio
import json
import logging
import shutil
import subprocess
from pathlib import Path

from backend.config import DOWNLOAD_DIR
from backend.database import get_db

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv', '.wmv'}

POLL_INTERVAL = 2  # seconds between probe attempts
MIN_BYTES_FOR_PROBE = 1 * 1024 * 1024  # 1MB - minimum downloaded before first probe

# Resolve ffprobe absolute path at import time so it works regardless of service PATH
FFPROBE_PATH = shutil.which('ffprobe') or '/usr/bin/ffprobe'


def probe_video(file_path: str) -> dict | None:
    """Run ffprobe on a video file and return parsed metadata."""
    try:
        result = subprocess.run(
            [
                FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json',
                '-show_streams', '-show_format', str(file_path)
            ],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            print(f"[file_meta] ffprobe exited with code {result.returncode}: {result.stderr[:200]}")
            return None
        return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as e:
        print(f"[file_meta] ffprobe exception: {e}")
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


def find_file(file_name: str, downloaded_from: str) -> Path | None:
    """Find the physical file on disk, checking common locations and custom mappings."""
    db = get_db()
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


def is_video_file(filename: str) -> bool:
    """Check if filename has a video extension."""
    return Path(filename).suffix.lower() in VIDEO_EXTENSIONS


def extract_and_store_meta(message_id) -> bool:
    """
    Try to extract metadata for a download and store it in the DB.
    Returns True if metadata was successfully stored, False otherwise.
    """
    db = get_db()
    download = db.get_download_by_message_id(message_id)
    if not download:
        return False

    if download.get('file_meta'):
        return True

    filename = download.get('file')
    if not filename or not is_video_file(filename):
        return False

    file_path = find_file(filename, download.get('downloaded_from'))
    if not file_path:
        return False

    probe_data = probe_video(str(file_path))
    if not probe_data:
        return False

    meta = extract_meta(probe_data)
    if not meta.get('video'):
        return False

    db.update_download_by_message_id(message_id, file_meta=json.dumps(meta))
    res = f"{meta['video']['width']}x{meta['video']['height']}"
    print(f"[file_meta] Stored metadata [{res}] for {filename}")

    # Emit websocket event so frontend picks up the metadata
    try:
        from backend.web_app import get_socketio
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:meta', {
                'message_id': str(message_id),
                'file_meta': meta
            })
    except Exception:
        pass

    return True


async def poll_and_extract_meta(message_id):
    """
    Background task that probes video metadata as early as possible.

    - Waits until at least 1MB has been downloaded before first probe.
    - Polls every 2s, attempting ffprobe each time.
    - If file_meta is already populated, exits immediately.
    - Gives up if the download fails/stops without successful probe.
    """
    db = get_db()
    msg_id = str(message_id)

    # Phase 1: wait until at least 1MB is downloaded
    while True:
        download = db.get_download_by_message_id(msg_id)
        if not download:
            return

        if download.get('file_meta'):
            return

        filename = download.get('file')
        if not filename or not is_video_file(filename):
            return

        status = download.get('status')
        downloaded_bytes = download.get('downloaded_bytes', 0) or 0

        if status in ('failed', 'stopped'):
            return

        if downloaded_bytes >= MIN_BYTES_FOR_PROBE or status == 'done':
            break

        await asyncio.sleep(POLL_INTERVAL)

    # Phase 2: probe every 2s until metadata is extracted
    while True:
        download = db.get_download_by_message_id(msg_id)
        if not download:
            return

        if download.get('file_meta'):
            return

        if extract_and_store_meta(msg_id):
            return

        status = download.get('status')

        if status in ('done', 'failed', 'stopped'):
            return

        await asyncio.sleep(POLL_INTERVAL)

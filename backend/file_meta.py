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

from backend.config import DOWNLOAD_DIR, SCREENSHOTS_DIR
from backend.database import get_db

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv', '.wmv'}

POLL_INTERVAL = 2  # seconds between probe attempts
MIN_BYTES_FOR_PROBE = 1 * 1024 * 1024  # 1MB - minimum downloaded before first probe

# Resolve absolute paths at import time so they work regardless of service PATH
FFPROBE_PATH = shutil.which('ffprobe') or '/usr/bin/ffprobe'
FFMPEG_PATH = shutil.which('ffmpeg') or '/usr/bin/ffmpeg'

THUMBS_DIR = SCREENSHOTS_DIR
THUMB_POSITIONS = [0.25, 0.50, 0.75, 0.95]  # Percentages of duration


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
            # Extract bit depth from pix_fmt (e.g. yuv420p10le -> 10)
            pix_fmt = stream.get('pix_fmt', '')
            bits_raw = stream.get('bits_per_raw_sample')
            if bits_raw:
                meta['video']['bit_depth'] = int(bits_raw)
            elif pix_fmt:
                import re
                m = re.search(r'p(\d+)', pix_fmt)
                if m:
                    meta['video']['bit_depth'] = int(m.group(1))
                else:
                    meta['video']['bit_depth'] = 8

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


def generate_thumbnails(message_id, file_path: str, duration: float) -> bool:
    """
    Extract 4 thumbnail images from a video at 25%, 50%, 75%, 95% of duration.
    Stores them in THUMBS_DIR/<message_id>/1.jpg .. 4.jpg
    Returns True if at least one thumbnail was created.
    """
    msg_id = str(message_id)
    thumb_dir = THUMBS_DIR / msg_id
    thumb_dir.mkdir(parents=True, exist_ok=True)

    created = 0
    for i, pos in enumerate(THUMB_POSITIONS, 1):
        timestamp = duration * pos
        out_path = thumb_dir / f"{i}.jpg"
        try:
            result = subprocess.run(
                [
                    FFMPEG_PATH, '-ss', str(timestamp),
                    '-i', str(file_path),
                    '-vframes', '1', '-q:v', '2',
                    '-y', str(out_path)
                ],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0 and out_path.exists():
                created += 1
        except (subprocess.TimeoutExpired, FileNotFoundError):
            continue

    if created > 0:
        print(f"[file_meta] Generated {created} thumbnails for {msg_id}")
    else:
        # Clean up empty folder
        shutil.rmtree(thumb_dir, ignore_errors=True)
    return created > 0


def delete_thumbnails(message_id):
    """Delete the thumbnail folder for a download."""
    msg_id = str(message_id)
    thumb_dir = THUMBS_DIR / msg_id
    if thumb_dir.exists():
        shutil.rmtree(thumb_dir, ignore_errors=True)


def get_thumbs_dir() -> Path:
    """Return the base thumbnails directory."""
    return THUMBS_DIR


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
    meta_stored = False
    while True:
        download = db.get_download_by_message_id(msg_id)
        if not download:
            return

        if download.get('file_meta'):
            meta_stored = True
            break

        if extract_and_store_meta(msg_id):
            meta_stored = True
            break

        status = download.get('status')

        if status in ('done', 'failed', 'stopped'):
            break

        await asyncio.sleep(POLL_INTERVAL)

    if not meta_stored:
        return

    # Phase 3: wait for download to complete, then generate thumbnails
    while True:
        download = db.get_download_by_message_id(msg_id)
        if not download:
            return

        status = download.get('status')
        if status == 'done':
            break
        if status in ('failed', 'stopped'):
            return

        await asyncio.sleep(POLL_INTERVAL)

    # Generate thumbnails from the completed file
    file_meta = download.get('file_meta')
    duration = file_meta.get('duration') if isinstance(file_meta, dict) else None
    if not duration:
        return

    filename = download.get('file')
    file_path = find_file(filename, download.get('downloaded_from'))
    if file_path:
        generate_thumbnails(msg_id, str(file_path), duration)

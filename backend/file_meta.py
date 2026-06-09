"""
Video file metadata extraction and auto-population.

Probes video files using ffprobe and stores video/audio metadata as JSON
in the file_meta column. Integrates into the download flow so metadata
is extracted automatically once a video download completes.
"""
import asyncio
import json
import logging
import re
import shutil
from pathlib import Path

from backend.config import DOWNLOAD_DIR, SCREENSHOTS_DIR
from backend.database import get_db

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv', '.wmv'}

POLL_INTERVAL = 2  # seconds between probe attempts
MIN_BYTES_FOR_PROBE = 1 * 1024 * 1024  # 1MB - minimum downloaded before first probe

TERMINAL_STATUSES = ('failed', 'stopped')

# Resolve absolute paths at import time so they work regardless of service PATH
FFPROBE_PATH = shutil.which('ffprobe') or '/usr/bin/ffprobe'
FFMPEG_PATH = shutil.which('ffmpeg') or '/usr/bin/ffmpeg'

THUMBS_DIR = SCREENSHOTS_DIR
THUMB_POSITIONS = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]  # Percentages of duration


async def probe_video(file_path: str) -> dict | None:
    """Run ffprobe on a video file and return parsed metadata."""
    try:
        proc = await asyncio.create_subprocess_exec(
            FFPROBE_PATH, '-v', 'quiet', '-print_format', 'json',
            '-show_streams', '-show_format', str(file_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode != 0:
            logger.warning("ffprobe exited with code %d: %s", proc.returncode, stderr.decode()[:200])
            return None
        return json.loads(stdout.decode())
    except asyncio.TimeoutError:
        logger.warning("ffprobe timed out for %s", file_path)
        if proc.returncode is None:
            proc.kill()
        return None
    except (json.JSONDecodeError, FileNotFoundError) as e:
        logger.warning("ffprobe exception: %s", e)
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


def find_file(file_name: str, downloaded_from: str = None, url: str = None) -> Path | None:
    """Find the physical file on disk, checking common locations and the
    source's configured destination folder. For VPS downloads pass the
    remote path as `url` so per-watchfolder destinations are checked too."""
    from backend.utils import resolve_spec
    possible_paths = [
        DOWNLOAD_DIR / file_name,
        DOWNLOAD_DIR / "Videos" / file_name,
    ]

    if downloaded_from == 'vps':
        possible_paths.insert(0, DOWNLOAD_DIR / "VPS" / file_name)
    spec = resolve_spec(downloaded_from or 'telegram',
                        path=url if downloaded_from == 'vps' else None)
    if spec.get("folder"):
        possible_paths.insert(0, Path(spec["folder"]) / file_name)

    for p in possible_paths:
        if p.exists():
            return p
    return None


def is_video_file(filename: str) -> bool:
    """Check if filename has a video extension."""
    return Path(filename).suffix.lower() in VIDEO_EXTENSIONS


async def extract_and_store_meta(message_id) -> bool:
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

    file_path = find_file(filename, download.get('downloaded_from'), download.get('url'))
    if not file_path:
        return False

    probe_data = await probe_video(str(file_path))
    if not probe_data:
        return False

    meta = extract_meta(probe_data)
    if not meta.get('video'):
        return False

    db.update_download_by_message_id(message_id, file_meta=json.dumps(meta))
    res = f"{meta['video']['width']}x{meta['video']['height']}"
    logger.info("Stored metadata [%s] for %s", res, filename)

    _emit_event('download:meta', {
        'message_id': str(message_id),
        'file_meta': meta
    })

    return True


async def generate_thumbnails(download_id, file_path: str, duration: float) -> int:
    """
    Extract thumbnail images from a video at each THUMB_POSITIONS percentage.
    Stores them in THUMBS_DIR/<download_id>/1.jpg .. N.jpg
    All ffmpeg processes run in parallel for speed.
    Returns the number of thumbnails created.
    """
    folder_name = str(download_id)
    thumb_dir = THUMBS_DIR / folder_name
    thumb_dir.mkdir(parents=True, exist_ok=True)

    async def _extract_one(index: int, pos: float) -> bool:
        timestamp = duration * pos
        out_path = thumb_dir / f"{index}.jpg"
        try:
            proc = await asyncio.create_subprocess_exec(
                FFMPEG_PATH, '-ss', str(timestamp),
                '-i', str(file_path),
                '-vframes', '1', '-q:v', '2',
                '-vf', "scale='min(900,iw)':-2",
                '-y', str(out_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=30)
            return proc.returncode == 0 and out_path.exists()
        except (asyncio.TimeoutError, FileNotFoundError):
            if proc and proc.returncode is None:
                proc.kill()
            return False

    results = await asyncio.gather(
        *(_extract_one(i, pos) for i, pos in enumerate(THUMB_POSITIONS, 1))
    )
    created = sum(results)

    if created > 0:
        logger.info("Generated %d thumbnails for download %s", created, folder_name)
        # Persist count in DB and notify frontend
        db = get_db()
        db.update_download_by_id(download_id, thumb_count=created)
        _emit_event('download:thumbs', {
            'download_id': download_id,
            'thumb_count': created
        })
    else:
        shutil.rmtree(thumb_dir, ignore_errors=True)
    return created


def delete_thumbnails(download_id):
    """Delete the thumbnail folder for a download and reset DB count."""
    thumb_dir = THUMBS_DIR / str(download_id)
    if thumb_dir.exists():
        shutil.rmtree(thumb_dir, ignore_errors=True)
    db = get_db()
    db.update_download_by_id(download_id, thumb_count=0)


def get_thumbs_dir() -> Path:
    """Return the base thumbnails directory."""
    return THUMBS_DIR


def _emit_event(event: str, data: dict):
    """Emit a websocket event to the frontend, swallowing errors."""
    try:
        from backend.web_app import get_socketio
        socketio = get_socketio()
        if socketio:
            socketio.emit(event, data)
    except Exception:
        pass


async def _poll_download(db, msg_id, *, ready_fn):
    """
    Poll download status until ready_fn(download) returns True,
    or the download enters a terminal state / disappears.
    Returns the download dict when ready, or None.
    """
    while True:
        download = db.get_download_by_message_id(msg_id)
        if not download:
            return None
        if ready_fn(download):
            return download
        if download.get('status') in TERMINAL_STATUSES:
            return None
        await asyncio.sleep(POLL_INTERVAL)


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

    # Phase 1: wait until enough data is downloaded to probe
    download = await _poll_download(db, msg_id, ready_fn=lambda d: (
        d.get('file_meta')
        or not d.get('file') or not is_video_file(d['file'])
        or (d.get('downloaded_bytes', 0) or 0) >= MIN_BYTES_FOR_PROBE
        or d.get('status') == 'done'
    ))
    if not download:
        return

    filename = download.get('file')
    if not filename or not is_video_file(filename) or download.get('file_meta'):
        return

    # Phase 2: actively probe every 2s until metadata is extracted
    meta_stored = False
    while True:
        download = db.get_download_by_message_id(msg_id)
        if not download:
            return
        if download.get('file_meta'):
            meta_stored = True
            break
        if await extract_and_store_meta(msg_id):
            meta_stored = True
            break
        if download.get('status') in (*TERMINAL_STATUSES, 'done'):
            break
        await asyncio.sleep(POLL_INTERVAL)

    if not meta_stored:
        return

    # Phase 3: wait for download to complete, then generate thumbnails
    download = await _poll_download(db, msg_id, ready_fn=lambda d: d.get('status') == 'done')
    if not download:
        return

    file_meta = download.get('file_meta')
    duration = file_meta.get('duration') if isinstance(file_meta, dict) else None
    if not duration:
        return

    filename = download.get('file')
    file_path = find_file(filename, download.get('downloaded_from'), download.get('url'))
    if file_path:
        await generate_thumbnails(download.get('id'), str(file_path), duration)

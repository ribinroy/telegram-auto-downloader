"""
Full technical details of one video file, for the player's info (i) modal.

`file_meta` on a download keeps a one-line summary (first video + first audio
stream); this is the whole picture - every stream, the container, chapters,
HDR - probed live, so it works for an explorer path with no download row too.
"""
import json
import logging
import re
import subprocess
from fractions import Fraction
from pathlib import Path

from backend.file_meta import FFPROBE_PATH

logger = logging.getLogger(__name__)

PROBE_TIMEOUT = 30

# Container tags worth showing; the rest (encoder internals, iTunes noise) aren't.
FORMAT_TAGS = ('title', 'artist', 'album', 'date', 'creation_time', 'encoder', 'comment', 'description')

HDR_TRANSFERS = {'smpte2084': 'HDR10 (PQ)', 'arib-std-b67': 'HLG'}


class MediaInfoError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _rate(r):
    """'30000/1001' -> 29.97; '0/0' -> None."""
    try:
        f = Fraction(r)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return round(float(f), 3) if f > 0 else None


def _bit_depth(s):
    raw = _int(s.get('bits_per_raw_sample'))
    if raw:
        return raw
    m = re.search(r'p(\d+)', s.get('pix_fmt') or '')
    return int(m.group(1)) if m else (8 if s.get('pix_fmt') else None)


def _hdr(s):
    transfer = s.get('color_transfer')
    for side in s.get('side_data_list') or []:
        kind = (side.get('side_data_type') or '').lower()
        if 'dovi' in kind or 'dolby vision' in kind:
            return 'Dolby Vision'
    if transfer in HDR_TRANSFERS:
        return HDR_TRANSFERS[transfer]
    return None


def _stream(s):
    tags = {k.lower(): v for k, v in (s.get('tags') or {}).items()}
    disp = s.get('disposition') or {}
    out = {
        'index': s.get('index'),
        'type': s.get('codec_type'),
        'codec': s.get('codec_name'),
        'codec_long': s.get('codec_long_name'),
        'profile': s.get('profile'),
        'language': tags.get('language') if tags.get('language') not in (None, 'und') else None,
        'title': tags.get('title'),
        'default': bool(disp.get('default')),
        'forced': bool(disp.get('forced')),
        'bitrate': _int(s.get('bit_rate') or tags.get('bps')),
    }
    kind = s.get('codec_type')
    if kind == 'video':
        out.update({
            'width': _int(s.get('width')),
            'height': _int(s.get('height')),
            'aspect': s.get('display_aspect_ratio') if s.get('display_aspect_ratio') not in (None, '0:1', 'N/A') else None,
            'fps': _rate(s.get('avg_frame_rate')) or _rate(s.get('r_frame_rate')),
            'pix_fmt': s.get('pix_fmt'),
            'bit_depth': _bit_depth(s),
            'color_space': s.get('color_space'),
            'color_primaries': s.get('color_primaries'),
            'color_transfer': s.get('color_transfer'),
            'hdr': _hdr(s),
            'attached_pic': bool(disp.get('attached_pic')),
        })
    elif kind == 'audio':
        out.update({
            'channels': _int(s.get('channels')),
            'channel_layout': s.get('channel_layout'),
            'sample_rate': _int(s.get('sample_rate')),
        })
    return out


def summarize(probe: dict, path: Path) -> dict:
    """The info modal's shape from raw ffprobe JSON (pure, tested)."""
    fmt = probe.get('format') or {}
    tags = {k.lower(): v for k, v in (fmt.get('tags') or {}).items()}
    streams = [_stream(s) for s in probe.get('streams') or []]
    try:
        st = path.stat()
        size, mtime = st.st_size, st.st_mtime
    except OSError:
        size, mtime = _int(fmt.get('size')), None
    return {
        'file': {'name': path.name, 'path': str(path), 'size': size, 'modified': mtime},
        'container': {
            'format': fmt.get('format_name'),
            'format_long': fmt.get('format_long_name'),
            'duration': _float(fmt.get('duration')),
            'bitrate': _int(fmt.get('bit_rate')),
            'tags': {k: tags[k] for k in FORMAT_TAGS if tags.get(k)},
        },
        'streams': streams,
        'chapters': [
            {'start': _float(c.get('start_time')), 'end': _float(c.get('end_time')),
             'title': (c.get('tags') or {}).get('title')}
            for c in probe.get('chapters') or []
        ],
    }


def media_info(path) -> dict:
    """Probe a local file. Raises MediaInfoError (404 missing, 422 unreadable)."""
    path = Path(path)
    if not path.is_file():
        raise MediaInfoError('File not found', 404)
    try:
        res = subprocess.run(
            [FFPROBE_PATH, '-v', 'error', '-print_format', 'json',
             '-show_format', '-show_streams', '-show_chapters', str(path)],
            capture_output=True, timeout=PROBE_TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        raise MediaInfoError('Probing the file timed out', 504)
    except OSError as e:
        logger.warning('ffprobe failed on %s: %s', path, e)
        raise MediaInfoError('ffprobe is not available', 500)
    try:
        probe = json.loads(res.stdout.decode(errors='replace') or '{}')
    except json.JSONDecodeError:
        probe = {}
    if res.returncode != 0 and not probe.get('streams'):
        raise MediaInfoError('Not a media file ffprobe can read', 422)
    return summarize(probe, path)

"""Subtitle tracks for the web player, served as WebVTT.

A browser `<track>` only takes WebVTT, so everything is converted on the way
out: a sidecar `.srt` in pure Python (it is VTT with commas in the timings),
`.ass`/`.ssa` sidecars and tracks embedded in an MKV/MP4 through ffmpeg.
One format on the wire means the flat `<video>` and the VR renderer read the
same cues from the same TextTrack - the VR view draws them itself.

Track ids are opaque to the client: `f:<sidecar basename>` or `s:<n>` (the
n-th subtitle stream of the container). A sidecar id is validated against the
video's own folder and stem before anything is read, since it is joined onto a
path and comes from the request.
"""
import hashlib
import json
import logging
import re
import subprocess
from pathlib import Path

from backend.config import SCREENSHOTS_DIR
from backend.file_meta import FFMPEG_PATH, FFPROBE_PATH

logger = logging.getLogger(__name__)

SIDECAR_EXTS = ('.srt', '.vtt', '.ass', '.ssa')
# Text subtitle codecs ffmpeg can turn into WebVTT. Bitmap ones (PGS, DVD,
# dvb) would need OCR and are left out of the listing.
TEXT_CODECS = {'subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text', 'text', 'ttml', 'sami', 'microdvd', 'subviewer'}
CACHE_DIR = Path(SCREENSHOTS_DIR) / '.subs'
# Pulling a track out of a 50 GB MKV reads the whole container; it is cached,
# but the first time has to be allowed to take a while.
EXTRACT_TIMEOUT = 600
PROBE_TIMEOUT = 30

LANG_NAMES = {
    'en': 'English', 'eng': 'English', 'de': 'German', 'ger': 'German', 'deu': 'German',
    'fr': 'French', 'fre': 'French', 'fra': 'French', 'es': 'Spanish', 'spa': 'Spanish',
    'it': 'Italian', 'ita': 'Italian', 'pt': 'Portuguese', 'por': 'Portuguese',
    'nl': 'Dutch', 'dut': 'Dutch', 'nld': 'Dutch', 'ru': 'Russian', 'rus': 'Russian',
    'ja': 'Japanese', 'jpn': 'Japanese', 'zh': 'Chinese', 'chi': 'Chinese', 'zho': 'Chinese',
    'ko': 'Korean', 'kor': 'Korean', 'ar': 'Arabic', 'ara': 'Arabic', 'hi': 'Hindi', 'hin': 'Hindi',
    'ml': 'Malayalam', 'mal': 'Malayalam', 'ta': 'Tamil', 'tam': 'Tamil', 'sv': 'Swedish', 'swe': 'Swedish',
    'pl': 'Polish', 'pol': 'Polish', 'tr': 'Turkish', 'tur': 'Turkish', 'und': '',
}


class SubtitleError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# --- listing -----------------------------------------------------------------

def _sidecars(video):
    """Subtitle files next to the video whose name starts with its stem:
    `Movie.srt`, `Movie.en.srt`, `Movie.eng.forced.ass`."""
    stem = video.stem
    out = []
    try:
        names = sorted(p.name for p in video.parent.iterdir())
    except OSError:
        return out
    for name in names:
        p = video.parent / name
        if p.suffix.lower() not in SIDECAR_EXTS or not p.is_file():
            continue
        if not name.startswith(stem) or name == video.name:
            continue
        middle = name[len(stem):-len(p.suffix)].strip('. _-')
        parts = [x for x in re.split(r'[._ -]+', middle) if x]
        lang = next((x.lower() for x in parts if x.lower() in LANG_NAMES), None)
        forced = any(x.lower() in ('forced', 'sdh', 'hi') for x in parts)
        pretty = ' '.join(LANG_NAMES.get(x.lower(), x) for x in parts if x.lower() != 'und')
        label = pretty or f'{p.suffix[1:].upper()} file'
        out.append({
            'id': f'f:{name}', 'label': label, 'lang': lang, 'kind': 'sidecar',
            'format': p.suffix[1:].lower(), 'forced': forced, 'default': False,
        })
    return out


def _probe_streams(video):
    try:
        res = subprocess.run(
            [FFPROBE_PATH, '-v', 'error', '-print_format', 'json', '-show_streams',
             '-select_streams', 's', str(video)],
            capture_output=True, timeout=PROBE_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.warning('ffprobe failed on %s: %s', video, e)
        return []
    if res.returncode != 0:
        return []
    try:
        return json.loads(res.stdout.decode() or '{}').get('streams', [])
    except json.JSONDecodeError:
        return []


def _embedded(video):
    out = []
    for n, s in enumerate(_probe_streams(video)):
        codec = (s.get('codec_name') or '').lower()
        if codec not in TEXT_CODECS:
            continue
        tags = s.get('tags') or {}
        lang = (tags.get('language') or '').lower() or None
        title = tags.get('title') or ''
        disp = s.get('disposition') or {}
        label = title or LANG_NAMES.get(lang or '', '') or (lang or '').upper() or f'Track {n + 1}'
        if disp.get('forced') and 'forced' not in label.lower():
            label += ' (forced)'
        out.append({
            'id': f's:{n}', 'label': label, 'lang': lang if lang != 'und' else None,
            'kind': 'embedded', 'format': codec, 'forced': bool(disp.get('forced')),
            'default': bool(disp.get('default')),
        })
    return out


def list_tracks(video):
    """Every text subtitle available for a video file, sidecars first."""
    video = Path(video)
    if not video.is_file():
        raise SubtitleError('Video not found', 404)
    return _sidecars(video) + _embedded(video)


# --- rendering ---------------------------------------------------------------

_TIMING = re.compile(r'(\d+):(\d{2}):(\d{2})[,.](\d{1,3})')


def srt_to_vtt(text):
    """SubRip -> WebVTT. The cue timings get a dot instead of a comma, the
    numeric counters are kept as cue identifiers (which VTT allows), and a
    `{\\an8}`-style positioning code - meaningless to a browser - is dropped."""
    text = text.replace('\r\n', '\n').replace('\r', '\n').lstrip('﻿')
    lines = []
    for line in text.split('\n'):
        if '-->' in line:
            line = _TIMING.sub(lambda m: f'{m[1]}:{m[2]}:{m[3]}.{m[4].ljust(3, "0")}', line)
        else:
            line = re.sub(r'\{\\[^}]*\}', '', line)
        lines.append(line)
    body = '\n'.join(lines).strip('\n')
    return 'WEBVTT\n\n' + body + '\n'


def _read_text(path):
    data = path.read_bytes()
    for enc in ('utf-8-sig', 'utf-16', 'cp1252', 'latin-1'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', errors='replace')


def _cache_path(video, track_id):
    st = video.stat()
    key = f'{video}|{st.st_mtime_ns}|{st.st_size}|{track_id}'
    return CACHE_DIR / (hashlib.sha1(key.encode()).hexdigest() + '.vtt')


def _ffmpeg_vtt(args, timeout):
    cmd = [FFMPEG_PATH, '-v', 'error', '-nostdin', *args, '-f', 'webvtt', '-']
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise SubtitleError('Subtitle extraction timed out', 504)
    except OSError as e:
        raise SubtitleError(f'ffmpeg unavailable: {e}', 500)
    if res.returncode != 0 or not res.stdout.strip():
        err = res.stderr.decode(errors='replace').strip().splitlines()
        raise SubtitleError(err[-1] if err else 'Could not convert the subtitle', 500)
    return res.stdout


def _sidecar_path(video, name):
    """Resolve a `f:` id back to a file, refusing anything that isn't one of
    this video's own sidecars - the id is request input joined onto a path."""
    if not name or '/' in name or '\\' in name or name in ('.', '..'):
        raise SubtitleError('Bad subtitle track', 400)
    path = video.parent / name
    if (path.suffix.lower() not in SIDECAR_EXTS or not name.startswith(video.stem)
            or not path.is_file()):
        raise SubtitleError('Subtitle not found', 404)
    return path


def render_vtt(video, track_id):
    """The WebVTT text of one track. Conversions that need ffmpeg are cached
    under SCREENSHOTS_DIR/.subs keyed by the video's identity and the track,
    so a track embedded in a big MKV is demuxed once, not on every play."""
    video = Path(video)
    if not video.is_file():
        raise SubtitleError('Video not found', 404)
    kind, _, rest = (track_id or '').partition(':')

    if kind == 'f':
        sub = _sidecar_path(video, rest)
        ext = sub.suffix.lower()
        if ext == '.vtt':
            text = _read_text(sub)
            return text if text.lstrip().startswith('WEBVTT') else 'WEBVTT\n\n' + text
        if ext == '.srt':
            return srt_to_vtt(_read_text(sub))
        cached = _cache_path(sub, 'vtt')
        if cached.is_file():
            return cached.read_text(encoding='utf-8')
        out = _ffmpeg_vtt(['-i', str(sub)], timeout=60).decode('utf-8', errors='replace')
        _store(cached, out)
        return out

    if kind == 's' and rest.isdigit():
        cached = _cache_path(video, track_id)
        if cached.is_file():
            return cached.read_text(encoding='utf-8')
        out = _ffmpeg_vtt(['-i', str(video), '-map', f'0:s:{int(rest)}', '-vn', '-an'],
                          timeout=EXTRACT_TIMEOUT).decode('utf-8', errors='replace')
        _store(cached, out)
        return out

    raise SubtitleError('Bad subtitle track', 400)


def _store(cached, text):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_suffix('.tmp')
        tmp.write_text(text, encoding='utf-8')
        tmp.replace(cached)
    except OSError as e:
        logger.warning('could not cache subtitle %s: %s', cached, e)

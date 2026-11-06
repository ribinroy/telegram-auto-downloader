"""The library feed for VR headset players (HereSphere, DeoVR).

Both apps have a "web stream" button: given a URL they fetch JSON describing
a library and play the files themselves - with the headset's hardware
decoder, which is what an 8K HEVC file needs and what a browser doesn't
have. This module builds that JSON from the finished downloads; the routes
in web_app/routes/vr.py only serve it.

- **Access is a key in the URL** (`/vr/<key>/heresphere`, `/vr/<key>/deovr`).
  The apps can't do a JWT login, and typing a password on a headset is
  misery, so the key *is* the credential: 16 url-safe chars, kept in the
  `vr_feed` setting, regenerated or disabled from Settings → VR headset.
  Media URLs inside the feed carry a freshly minted media token (the same
  `typ: 'media'` token the browser uses), good for MEDIA_TOKEN_HOURS, so the
  stream routes need no change and a disabled key stops new feeds at once.
- **Two formats, one library.** HereSphere's (header
  `HereSphere-JSON-Version: 1`; `projection`/`stereo`/`fov`/`lens`,
  `duration` in ms, `subtitles[]`) and DeoVR's (`scenes[].list[]`,
  `screenType`/`stereoMode`/`is3d`, `videoLength` in s, no subtitles).
  Field names come from DeoVR's app doc and XBVR's HereSphere
  implementation - the de-facto reference, since the spec isn't published.
- **Projection** is the same guess the web player makes
  (`detect_projection` is a port of `utils/vr.ts`), plus the lens tags the
  web player can't use (MKX200/220, VRCA220, RF52, FISHEYE190 - the apps
  render fisheye properly). A manual pick in the web player lands in
  `downloads.vr_projection` and wins.
"""
import json
import logging
import re
import secrets
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

SETTING_KEY = 'vr_feed'
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.wmv', '.flv'}
LIBRARY_LIMIT = 500

# --- projection ---------------------------------------------------------------

PROJECTIONS = ('flat', '180-mono', '180-sbs', '180-tb', '360-mono', '360-sbs', '360-tb')


def _tag(words):
    return re.compile(r'(?:^|[^a-z0-9])(?:' + words + r')(?=$|[^a-z0-9])', re.I)


TAG_180 = _tag(r'180|vr180|mkx2[02]0|rf52|vrca220|fisheye(?:190)?|f180')
TAG_360 = _tag(r'360|vr360')
TAG_VR = _tag(r'vr|3d')
TAG_SBS = _tag(r'sbs|lr|3dh|hsbs|half-sbs')
TAG_TB = _tag(r'tb|ou|3dv|htb|hou|top-bottom')
TAG_MONO = _tag(r'mono|2d')
LENSES = [
    (_tag(r'mkx200'), 'MKX200', 200.0),
    (_tag(r'mkx220'), 'MKX220', 220.0),
    (_tag(r'vrca220'), 'VRCA220', 220.0),
    (_tag(r'rf52'), 'RF52', 190.0),
    (_tag(r'fisheye190'), 'FISHEYE190', 190.0),
    (_tag(r'fisheye'), 'FISHEYE', 180.0),
]


def _near(a, b):
    return abs(a - b) / b < 0.12


def detect_projection(name, aspect=None):
    """`(projection, lens, fov)` from a filename, the way the web player
    guesses it - tags first, the aspect ratio only to settle the layout once
    the name says VR at all. `lens` is None for equirectangular."""
    base = name.rsplit('/', 1)[-1]
    stem = re.sub(r'\.[a-z0-9]{2,4}$', '', base, flags=re.I)
    lens, fov = None, 180.0
    for rx, lens_name, lens_fov in LENSES:
        if rx.search(stem):
            lens, fov = lens_name, lens_fov
            break

    layout = '180' if TAG_180.search(stem) else '360' if TAG_360.search(stem) else None
    stereo = ('sbs' if TAG_SBS.search(stem) else 'tb' if TAG_TB.search(stem)
              else 'mono' if TAG_MONO.search(stem) else None)
    if not layout:
        if not TAG_VR.search(stem) and not stereo:
            return 'flat', None, fov
        layout = '360' if aspect and _near(aspect, 4) else '180'
    if not stereo:
        if aspect:
            if layout == '180':
                stereo = 'sbs' if _near(aspect, 2) else 'tb' if _near(aspect, 0.5) else 'mono'
            else:
                stereo = 'sbs' if _near(aspect, 4) else 'tb' if _near(aspect, 1) else 'mono'
        else:
            stereo = 'sbs' if layout == '180' else 'mono'
    return f'{layout}-{stereo}', lens, fov


def projection_for(download):
    """The projection a headset should use: the user's pick if there is one,
    else the filename guess (the lens still comes from the name)."""
    meta = download.get('file_meta') or {}
    video = meta.get('video') or {}
    aspect = None
    if video.get('width') and video.get('height'):
        aspect = video['width'] / video['height']
    guessed, lens, fov = detect_projection(download.get('file') or '', aspect)
    picked = download.get('vr_projection')
    projection = picked if picked in PROJECTIONS else guessed
    if projection == 'flat':
        lens = None
    return projection, lens, fov


def heresphere_geometry(projection, lens, fov):
    """HereSphere's `projection`/`stereo`/`fov`/`lens` for ours."""
    if projection == 'flat':
        return {'projection': 'perspective', 'stereo': 'mono', 'fov': 180.0, 'lens': 'Linear'}
    layout, stereo = projection.split('-')
    if lens:
        # HereSphere names the three lens profiles it has; the others are
        # plain fisheye at the lens's field of view.
        hs_lens = lens if lens in ('MKX200', 'MKX220', 'VRCA220') else 'Linear'
        return {'projection': 'fisheye', 'stereo': stereo, 'fov': fov, 'lens': hs_lens}
    return {
        'projection': 'equirectangular360' if layout == '360' else 'equirectangular',
        'stereo': stereo, 'fov': 180.0, 'lens': 'Linear',
    }


def deovr_geometry(projection, lens, fov):
    """DeoVR's `screenType`/`stereoMode`/`is3d` for ours."""
    if projection == 'flat':
        return {'screenType': 'flat', 'stereoMode': 'off', 'is3d': False}
    layout, stereo = projection.split('-')
    if lens == 'RF52':
        screen = 'rf52'
    elif lens in ('MKX200', 'MKX220', 'VRCA220'):
        screen = 'mkx200'
    elif lens:
        screen = 'fisheye'
    else:
        screen = 'sphere' if layout == '360' else 'dome'
    return {'screenType': screen, 'stereoMode': 'off' if stereo == 'mono' else stereo,
            'is3d': stereo != 'mono'}


# --- the key ----------------------------------------------------------------

def read_feed_config(db):
    raw = db.get_setting(SETTING_KEY)
    try:
        cfg = json.loads(raw) if raw else {}
    except ValueError:
        cfg = {}
    return cfg if isinstance(cfg, dict) else {}


def regenerate_key(db, username, include_secured=False):
    cfg = {
        'key': secrets.token_urlsafe(12),  # 16 chars; typed into a headset once
        'username': username,
        'include_secured': bool(include_secured),
        'created_at': datetime.utcnow().isoformat() + 'Z',
    }
    db.set_setting(SETTING_KEY, json.dumps(cfg))
    return cfg


def update_feed_config(db, **changes):
    cfg = read_feed_config(db)
    cfg.update(changes)
    db.set_setting(SETTING_KEY, json.dumps(cfg))
    return cfg


def disable_key(db):
    db.delete_setting(SETTING_KEY)


def check_key(db, key):
    """The feed config if `key` is the live one, else None."""
    cfg = read_feed_config(db)
    live = cfg.get('key')
    if not key or not live or not secrets.compare_digest(str(key), str(live)):
        return None
    return cfg


# --- the library --------------------------------------------------------------

def _is_video(download):
    name = (download.get('file') or '').lower()
    return any(name.endswith(ext) for ext in VIDEO_EXTENSIONS)


def library_downloads(db, annotate, include_secured=False, limit=LIBRARY_LIMIT):
    """Finished single-file videos still on disk, newest first; secured
    sources left out unless the key was made to include them. `annotate` is
    WebApp._annotate_downloads, which knows what is hidden."""
    from backend.web_app.helpers import local_copy_exists
    rows = [d for d in db.get_downloads_by_status('done')
            if _is_video(d) and not d.get('file_count')]
    rows.sort(key=lambda d: d.get('created_at') or '', reverse=True)
    annotate(rows)
    out = []
    for d in rows:
        if d.get('hidden') and not include_secured:
            continue
        if d.get('file_deleted') or not local_copy_exists(d):
            continue
        out.append(d)
        if len(out) >= limit:
            break
    return out


def groups(downloads):
    """Named lists the apps show as libraries: everything, VR only, per source."""
    named = [('All videos', downloads),
             ('VR', [d for d in downloads if projection_for(d)[0] != 'flat'])]
    by_source = {}
    for d in downloads:
        by_source.setdefault(d.get('downloaded_from') or 'telegram', []).append(d)
    for source, items in sorted(by_source.items()):
        named.append((source.capitalize() if source in ('telegram', 'vps') else source, items))
    return [(name, items) for name, items in named if items]


def _title(download):
    name = download.get('file') or f"Download {download.get('id')}"
    return re.sub(r'\.[a-z0-9]{2,4}$', '', name, flags=re.I)


def _date(value):
    if not value:
        return ''
    return str(value)[:10]


def _video_meta(download):
    meta = download.get('file_meta') or {}
    video = meta.get('video') or {}
    return {
        'duration': float(meta.get('duration') or 0),
        'width': int(video.get('width') or 0),
        'height': int(video.get('height') or 0),
        'size': int(download.get('total_bytes') or 0),
    }


class FeedUrls:
    """Absolute URLs for one response: the app needs them complete, and the
    media ones carry the token minted for this response."""

    def __init__(self, base, key, media_token):
        self.base = base.rstrip('/')
        self.key = key
        self.token = media_token

    def heresphere_item(self, download_id):
        return f'{self.base}/vr/{self.key}/heresphere/{download_id}'

    def deovr_item(self, download_id):
        return f'{self.base}/vr/{self.key}/deovr/{download_id}'

    def stream(self, download_id):
        return f'{self.base}/api/video/stream/{download_id}?token={self.token}'

    def thumb(self, download, thumbs):
        if thumbs:
            return f'{self.base}/api/thumbs/{download["id"]}/{thumbs[len(thumbs) // 2]}?token={self.token}'
        return ''

    def subtitle(self, download_id, track_id):
        from urllib.parse import quote
        return f'{self.base}/api/video/subtitle/{download_id}?track={quote(track_id)}&token={self.token}'


def heresphere_library(downloads, urls):
    return {
        'access': 1,
        'library': [{'name': name, 'list': [urls.heresphere_item(d['id']) for d in items]}
                    for name, items in groups(downloads)],
    }


def heresphere_video(download, urls, thumbs=(), subtitle_tracks=()):
    projection, lens, fov = projection_for(download)
    vm = _video_meta(download)
    height = vm['height']
    source = download.get('downloaded_from') or 'telegram'
    tags = [{'name': f'Source:{source}'}]
    if download.get('author'):
        tags.append({'name': f"Author:{download['author']}"})
    if projection != 'flat':
        tags.append({'name': f'Projection:{projection}'})
    return {
        'access': 1,
        'title': _title(download),
        'description': f"{source} · {_date(download.get('created_at'))}",
        'thumbnailImage': urls.thumb(download, thumbs),
        'dateReleased': _date(download.get('created_at')),
        'dateAdded': _date(download.get('created_at')),
        'duration': int(vm['duration'] * 1000),
        'isFavorite': False,
        **heresphere_geometry(projection, lens, fov),
        'subtitles': [
            {'name': t['label'], 'language': t.get('lang') or 'und',
             'url': urls.subtitle(download['id'], t['id'])}
            for t in subtitle_tracks
        ],
        'tags': tags,
        'media': [{
            'name': f"File {height}p" if height else 'File',
            'sources': [{
                'resolution': str(height) if height else '',
                'height': height, 'width': vm['width'], 'size': vm['size'],
                'url': urls.stream(download['id']),
            }],
        }],
        'writeFavorite': False, 'writeRating': False, 'writeTags': False, 'writeHSP': False,
    }


def heresphere_denied(message):
    return {'access': -1, 'library': [{'name': message, 'list': []}]}


def deovr_library(downloads, urls, thumbs_for):
    scenes = []
    for name, items in groups(downloads):
        scenes.append({'name': name, 'list': [{
            'title': _title(d),
            'videoLength': int(_video_meta(d)['duration']),
            'thumbnailUrl': urls.thumb(d, thumbs_for(d)),
            'video_url': urls.deovr_item(d['id']),
        } for d in items]})
    return {'scenes': scenes, 'authorized': '1'}


def deovr_video(download, urls, thumbs=()):
    projection, lens, fov = projection_for(download)
    vm = _video_meta(download)
    return {
        'encodings': [{'name': 'h264', 'videoSources': [
            {'resolution': vm['height'] or 1080, 'url': urls.stream(download['id'])},
        ]}],
        'title': _title(download),
        'id': download['id'],
        'videoLength': int(vm['duration']),
        **deovr_geometry(projection, lens, fov),
        'skipIntro': 0,
        'thumbnailUrl': urls.thumb(download, thumbs),
    }


def deovr_denied(message):
    return {'scenes': [{'name': message, 'list': []}], 'authorized': '-1'}


def mint_media_token(db, username, hours):
    """A media token for the feed's stream/thumb/subtitle URLs, as the key's
    owner - so revoking that user's sessions (token_version) also kills
    every feed token minted so far."""
    import jwt
    from backend.config import JWT_SECRET
    user = db.get_user_by_username(username) if username else None
    if not user:
        return None
    now = datetime.utcnow()
    return jwt.encode({
        'typ': 'media', 'user_id': user.id, 'tv': user.token_version,
        'iat': now, 'exp': now + timedelta(hours=hours),
    }, JWT_SECRET, algorithm='HS256')

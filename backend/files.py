"""Live filesystem access for the built-in file explorer.

Every call in here hits the disk: there is no index and no cache, so what the
UI renders is what the drive holds at that moment (a file dropped in over SMB
shows up on the next listing, a pulled USB disk disappears from the roots).

Reads are allowed anywhere the service account can reach - browsing every
attached HDD is the point of the feature. Writes are the dangerous half and go
through `guard_write()`, which refuses the OS's own directories: a mis-click in
a browser tab must never be able to unlink /usr. Data disks mounted outside /
(the /mnt, /media, /srv... case) are always writable, since that is exactly
where a media library lives.
"""
import hashlib
import json
import os
import shutil
import stat as stat_module
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import datetime, timezone
from pathlib import Path

from backend.config import (
    BASE_DIR, DOWNLOAD_DIR, SCREENSHOTS_DIR, EXPLORER_READONLY, THUMB_WORKERS,
)
from backend.rename import unique_name


class FsError(Exception):
    """A user-facing filesystem error; `status` becomes the HTTP status."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------------
# Mounts / roots
# --------------------------------------------------------------------------

# Kernel and virtual filesystems. No real bytes live on any of them, and
# listing ~40 of them as "drives" would bury the two HDDs the user came for.
PSEUDO_FS = {
    'autofs', 'binfmt_misc', 'bpf', 'cgroup', 'cgroup2', 'configfs', 'debugfs',
    'devpts', 'devtmpfs', 'efivarfs', 'fuse.gvfsd-fuse', 'fuse.portal',
    'fusectl', 'hugetlbfs', 'mqueue', 'nsfs', 'overlay', 'proc', 'pstore',
    'ramfs', 'rpc_pipefs', 'securityfs', 'selinuxfs', 'squashfs', 'sysfs',
    'tmpfs', 'tracefs',
}

# Root-filesystem directories that belong to the distribution. Refused for
# every write operation; still browsable.
PROTECTED_ROOTS = (
    '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32',
    '/proc', '/run', '/sbin', '/sys', '/usr', '/var',
)


def _read_mounts():
    """[(device, mountpoint, fstype)] from /proc/mounts, never raising."""
    out = []
    try:
        with open('/proc/mounts', 'r') as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                device = parts[0].replace('\\040', ' ')
                mountpoint = parts[1].replace('\\040', ' ')
                out.append((device, mountpoint, parts[2]))
    except OSError:
        pass
    return out


def _usage(path):
    """{total, used, free} for the filesystem holding `path`, or None."""
    try:
        total, used, free = shutil.disk_usage(str(path))
        return {'total': total, 'used': used, 'free': free}
    except OSError:
        return None


def _mountpoint_for(path):
    """The deepest mount point containing `path` ('/' when none is deeper)."""
    p = str(path)
    best = '/'
    for _device, mountpoint, _fstype in _read_mounts():
        if mountpoint == '/':
            continue
        base = mountpoint.rstrip('/')
        if p == mountpoint or p == base or p.startswith(base + '/'):
            if len(base) > len(best.rstrip('/')):
                best = mountpoint
    return best


def describe_root(path, label, kind, group, note=None):
    """One sidebar place with live capacity, or None if it is not a directory."""
    try:
        resolved = str(Path(path).expanduser().resolve())
    except OSError:
        return None
    if not os.path.isdir(resolved):
        return None
    return {
        'path': resolved,
        'label': label,
        'kind': kind,
        'group': group,
        'note': note,
        'device': None,
        'fstype': None,
        'usage': _usage(resolved),
        'writable': os.access(resolved, os.W_OK),
    }


def list_roots():
    """Sidebar places straight off the filesystem: every mounted disk first,
    then the general-purpose folders.

    Read fresh from /proc/mounts on every call, so plugging in a drive only
    costs the user a refresh. DownLee's own configured destinations are added
    on top of this by the route, which has the database at hand.
    """
    roots, seen = [], set()

    def add(path, label, kind, group, note=None, device=None, fstype=None):
        root = describe_root(path, label, kind, group, note)
        if not root or root['path'] in seen:
            return
        seen.add(root['path'])
        root['device'], root['fstype'] = device, fstype
        roots.append(root)

    for device, mountpoint, fstype in _read_mounts():
        if fstype in PSEUDO_FS:
            continue
        # Snap/appimage loop mounts, container layers and the OS's own
        # partitions (/boot, /boot/efi...) are noise in a media browser.
        if mountpoint.startswith('/snap'):
            continue
        if any(mountpoint == r or mountpoint.startswith(r + '/') for r in PROTECTED_ROOTS):
            continue
        label = 'Filesystem' if mountpoint == '/' else (Path(mountpoint).name or mountpoint)
        add(mountpoint, label, 'disk', 'drive', device=device, fstype=fstype)

    add(Path.home(), 'Home', 'home', 'folder')
    add(DOWNLOAD_DIR, 'Downloads', 'downloads', 'folder')

    return roots


# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

def resolve_path(raw, must_exist=True, follow=True):
    """Turn a client-supplied path into an absolute Path.

    `follow=False` resolves the parent but keeps the final component as
    written, so deleting or renaming a symlink acts on the link itself rather
    than on whatever it points at.
    """
    raw = (raw or '').strip()
    if not raw:
        raise FsError('path is required')
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise FsError('Path must be absolute')
    try:
        p = p.resolve() if follow else (p.parent.resolve() / p.name)
    except OSError as e:
        raise FsError(str(e))
    if must_exist and not os.path.lexists(p):
        raise FsError('Path not found', 404)
    return p


def guard_write(path):
    """Refuse writes to the OS's own directories. Raises FsError."""
    if EXPLORER_READONLY:
        raise FsError('The file explorer is in read-only mode', 403)
    p = str(path)
    if p == '/':
        raise FsError('Refusing to modify the filesystem root', 403)
    # PROTECTED_ROOTS is checked *before* the data-disk shortcut below: /boot
    # (and /var, /home on some layouts) is very often its own mount, and
    # letting "not on /" mean "fair game" waved the bootloader straight through.
    for prefix in PROTECTED_ROOTS:
        if p == prefix or p.startswith(prefix + '/'):
            raise FsError(f'{prefix} belongs to the operating system and is read-only here', 403)
    if _mountpoint_for(path) != '/':
        return  # a mounted data disk - exactly what this feature is for


def guard_target(path):
    """guard_write() plus a refusal to unlink/rename a mount point itself."""
    guard_write(path)
    if os.path.ismount(str(path)):
        raise FsError(f'{path} is a mount point - unmount it instead', 403)


# --------------------------------------------------------------------------
# Entries
# --------------------------------------------------------------------------

VIDEO_EXT = {'.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv', '.wmv',
             '.mpg', '.mpeg', '.ts', '.m2ts', '.3gp', '.ogv'}
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico',
             '.tiff', '.tif', '.heic', '.avif'}
AUDIO_EXT = {'.mp3', '.flac', '.wav', '.aac', '.ogg', '.opus', '.m4a', '.wma', '.alac'}
ARCHIVE_EXT = {'.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.iso', '.tgz'}
DOC_EXT = {'.pdf', '.epub', '.mobi', '.doc', '.docx', '.odt', '.xls', '.xlsx',
           '.ods', '.ppt', '.pptx', '.odp'}
TEXT_EXT = {'.txt', '.md', '.log', '.csv', '.json', '.xml', '.yml', '.yaml',
            '.ini', '.conf', '.cfg', '.toml', '.srt', '.vtt', '.nfo', '.sh',
            '.py', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.sql', '.env'}

# Text preview is a read-into-memory, so it is capped well below "a log file
# somebody let grow to 4 GB".
TEXT_PREVIEW_MAX = 2 * 1024 * 1024


def kind_for(name, is_dir=False):
    if is_dir:
        return 'folder'
    ext = Path(name).suffix.lower()
    if ext in VIDEO_EXT:
        return 'video'
    if ext in IMAGE_EXT:
        return 'image'
    if ext in AUDIO_EXT:
        return 'audio'
    if ext in ARCHIVE_EXT:
        return 'archive'
    if ext in DOC_EXT:
        return 'document'
    if ext in TEXT_EXT:
        return 'text'
    return 'file'


def _iso(ts):
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace('+00:00', 'Z')


def _entry_from_stat(path, name, st, is_dir, is_link, broken=False):
    return {
        'name': name,
        'path': str(path),
        'is_dir': is_dir,
        'is_link': is_link,
        'broken': broken,
        'hidden': name.startswith('.'),
        'size': 0 if is_dir else (st.st_size if st else 0),
        'modified': _iso(st.st_mtime if st else None),
        'mode': stat_module.filemode(st.st_mode) if st else None,
        'kind': kind_for(name, is_dir),
        'ext': Path(name).suffix.lower().lstrip('.'),
    }


def _entry(dir_entry):
    """Build an entry dict from an os.DirEntry, tolerating broken links."""
    is_link = dir_entry.is_symlink()
    try:
        is_dir = dir_entry.is_dir(follow_symlinks=True)
        broken = False
    except OSError:
        is_dir, broken = False, is_link
    try:
        st = dir_entry.stat(follow_symlinks=not broken)
    except OSError:
        st, broken = None, True
    return _entry_from_stat(Path(dir_entry.path), dir_entry.name, st, is_dir, is_link, broken)


def stat_entry(path):
    """Entry dict for a single path (used by rename/properties responses)."""
    p = Path(path)
    is_link = p.is_symlink()
    try:
        st = p.stat()
        is_dir, broken = p.is_dir(), False
    except OSError:
        st, is_dir, broken = None, False, True
    return _entry_from_stat(p, p.name or str(p), st, is_dir, is_link, broken)


def list_dir(raw_path=None, show_hidden=False):
    """Live, non-recursive listing of a directory."""
    path = resolve_path(raw_path or str(DOWNLOAD_DIR))
    if not path.is_dir():
        raise FsError('Not a directory')

    entries = []
    try:
        with os.scandir(path) as it:
            for de in it:
                if not show_hidden and de.name.startswith('.'):
                    continue
                entries.append(_entry(de))
    except PermissionError:
        raise FsError('Permission denied', 403)
    except OSError as e:
        raise FsError(str(e))

    entries.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))
    parent = str(path.parent)
    return {
        'path': str(path),
        'parent': None if path.parent == path else parent,
        'name': path.name or str(path),
        'entries': entries,
        'writable': os.access(path, os.W_OK) and not EXPLORER_READONLY,
        'usage': _usage(path),
        'mount': _mountpoint_for(path),
        # Only advertised once it exists, so the sidebar never links to a
        # trash folder that was never created.
        'trash': str(trash) if (trash := trash_dir_for(path)).exists() else None,
    }


# --------------------------------------------------------------------------
# Mutations
# --------------------------------------------------------------------------

def make_dir(raw_parent, name):
    parent = resolve_path(raw_parent)
    if not parent.is_dir():
        raise FsError('Not a directory')
    name = _safe_name(name)
    guard_write(parent / name)
    target = parent / name
    if target.exists():
        raise FsError(f'"{name}" already exists here', 409)
    try:
        target.mkdir()
    except OSError as e:
        raise FsError(str(e))
    return stat_entry(target)


def _safe_name(name):
    """A single path component - never a traversal, never a separator."""
    name = (name or '').strip().strip('\x00')
    if not name or name in ('.', '..') or '/' in name or '\\' in name:
        raise FsError('Invalid name')
    return name


def rename(raw_path, new_name):
    path = resolve_path(raw_path, follow=False)
    guard_target(path)
    name = _safe_name(new_name)
    target = path.parent / name
    if target == path:
        return stat_entry(path)
    if target.exists():
        raise FsError(f'"{name}" already exists here', 409)
    try:
        path.rename(target)
    except OSError as e:
        raise FsError(str(e))
    return stat_entry(target)


def trash_dir_for(path):
    """Per-mount trash, so a delete stays a rename instead of a 50 GB copy."""
    mount = _mountpoint_for(path)
    base = Path(mount) / '.downlee-trash'
    if mount == '/':
        # Nothing writable is guaranteed at /, so root-fs deletes are parked
        # next to the app instead.
        base = Path(BASE_DIR) / '.trash'
    return base


def delete(raw_paths, permanent=False):
    """Delete files/folders. Default is a move to the mount's trash folder."""
    results = []
    for raw in raw_paths:
        path = resolve_path(raw, follow=False)
        try:
            guard_target(path)
            if permanent:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink()
                results.append({'path': str(path), 'trashed': False})
            else:
                trash = trash_dir_for(path)
                trash.mkdir(parents=True, exist_ok=True)
                stamp = time.strftime('%Y%m%d-%H%M%S')
                name = unique_name(trash, f'{stamp}-{path.name}')
                shutil.move(str(path), str(trash / name))
                results.append({'path': str(path), 'trashed': True, 'trash_path': str(trash / name)})
        except FsError as e:
            results.append({'path': str(path), 'error': e.message})
        except OSError as e:
            results.append({'path': str(path), 'error': str(e)})
    return results


def transfer(raw_paths, raw_dest, move=False):
    """Copy or move a selection into `dest`, resolving name clashes."""
    dest = resolve_path(raw_dest)
    if not dest.is_dir():
        raise FsError('Destination is not a directory')
    guard_write(dest)

    results = []
    for raw in raw_paths:
        source = resolve_path(raw, follow=False)
        try:
            if move:
                guard_target(source)
            if str(dest).startswith(str(source).rstrip('/') + '/'):
                raise FsError(f'Cannot move "{source.name}" into itself')
            name = unique_name(dest, source.name)
            target = dest / name
            if move:
                shutil.move(str(source), str(target))
            elif source.is_dir() and not source.is_symlink():
                shutil.copytree(str(source), str(target), symlinks=True)
            else:
                shutil.copy2(str(source), str(target), follow_symlinks=False)
            results.append({'path': str(source), 'target': str(target)})
        except FsError as e:
            results.append({'path': str(source), 'error': e.message})
        except (OSError, shutil.Error) as e:
            results.append({'path': str(source), 'error': str(e)})
    return results


def save_upload(raw_dest, filename, stream):
    """Write an uploaded file into `dest` without clobbering anything."""
    dest = resolve_path(raw_dest)
    if not dest.is_dir():
        raise FsError('Destination is not a directory')
    guard_write(dest)
    name = unique_name(dest, _safe_name(Path(filename or '').name))
    target = dest / name
    try:
        stream.save(str(target))
    except OSError as e:
        raise FsError(str(e))
    return stat_entry(target)


# --------------------------------------------------------------------------
# Search / size
# --------------------------------------------------------------------------

def search(raw_root, query, limit=500, timeout=15.0, show_hidden=False):
    """Recursive name search under `root`.

    Bounded by both a result cap and a wall-clock deadline: the root of a
    20 TB array is a perfectly reasonable thing to search from, and the caller
    is a web request that must not hang on it.
    """
    root = resolve_path(raw_root)
    if not root.is_dir():
        raise FsError('Not a directory')
    needle = (query or '').strip().lower()
    if len(needle) < 2:
        raise FsError('Search needs at least 2 characters')

    deadline = time.monotonic() + timeout
    results, truncated = [], False
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        if not show_hidden:
            dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        for name in dirnames + filenames:
            if not show_hidden and name.startswith('.'):
                continue
            if needle not in name.lower():
                continue
            full = Path(dirpath) / name
            try:
                results.append(stat_entry(full))
            except OSError:
                continue
            if len(results) >= limit:
                truncated = True
                break
        if truncated:
            break
        if time.monotonic() > deadline:
            truncated = True
            break
    return {'root': str(root), 'query': query, 'entries': results, 'truncated': truncated}


def dir_size(raw_path, timeout=20.0):
    """Recursive size of a folder, bounded by a deadline (partial if hit)."""
    path = resolve_path(raw_path)
    if not path.is_dir():
        st = path.stat()
        return {'path': str(path), 'size': st.st_size, 'files': 1, 'dirs': 0, 'partial': False}

    deadline = time.monotonic() + timeout
    total, files, dirs, partial = 0, 0, 0, False
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        dirs += len(dirnames)
        for name in filenames:
            try:
                total += os.lstat(os.path.join(dirpath, name)).st_size
                files += 1
            except OSError:
                continue
        if time.monotonic() > deadline:
            partial = True
            break
    return {'path': str(path), 'size': total, 'files': files, 'dirs': dirs, 'partial': partial}


def read_text(raw_path, max_bytes=TEXT_PREVIEW_MAX):
    """Decoded head of a text file for the preview pane."""
    path = resolve_path(raw_path)
    if path.is_dir():
        raise FsError('Not a file')
    size = path.stat().st_size
    with open(path, 'rb') as f:
        raw = f.read(max_bytes)
    return {
        'path': str(path),
        'text': raw.decode('utf-8', errors='replace'),
        'truncated': size > len(raw),
        'size': size,
    }


# --------------------------------------------------------------------------
# Thumbnails
# --------------------------------------------------------------------------

THUMB_CACHE = Path(SCREENSHOTS_DIR) / '.explorer'
THUMB_MAX = 480          # long edge of a still; one tile of a contact sheet
THUMB_VERSION = 2        # bump to orphan (and prune) every cached entry

# A video preview is a 2x2 contact sheet, not a single frame. Two reasons:
# a fixed "5 seconds in" lands on a fade-in, a studio card or plain black on
# most films, and four frames spread through the runtime say what a clip
# actually is. The client shows one tile and scrubs the others on hover, so
# it is also one request instead of four.
SHEET_COLS, SHEET_ROWS = 2, 2
SHEET_AT = (0.2, 0.4, 0.6, 0.8)  # fractions of the duration
QUICK_AT = 0.4                   # the first-pass single frame


def _thumb_key(path, st):
    raw = f'v{THUMB_VERSION}:{path}:{st.st_mtime_ns}:{st.st_size}'.encode()
    return hashlib.sha1(raw).hexdigest() + '.jpg'


def _write_sidecar(cached, source, st, layout, stage='final'):
    """Record which file a thumbnail came from, and in what shape.

    The cache name is a one-way hash, so without this a cleanup pass could
    never tell whether a thumbnail's source still exists. `version`/`layout`
    let a format change (a still becoming a contact sheet) sweep the old
    entries instead of leaving them cached forever behind a key nobody asks
    for. Best-effort: a thumbnail that fails to get one is treated as stale.

    `stage` is 'quick' for a video's first-pass preview (one frame, tiled into
    the sheet's shape) that the idle upgrader will replace with the real
    four-frame sheet, and 'final' for everything else.
    """
    try:
        cached.with_suffix('.json').write_text(json.dumps({
            'path': str(source), 'mtime_ns': st.st_mtime_ns, 'size': st.st_size,
            'version': THUMB_VERSION, 'layout': layout, 'stage': stage,
        }))
    except OSError:
        pass


def prune_thumb_cache():
    """Delete explorer thumbnails whose source file is gone, changed or stale.

    Run by the sync-thumbnails job. Each thumbnail is checked against its
    sidecar; one that has no sidecar (written before sidecars existed, or a
    half-finished write) counts as stale and goes too - it costs one ffmpeg
    run to come back the next time someone looks at that folder. So does one
    written by an older THUMB_VERSION, which nothing will ever request again.
    """
    stats = {'checked': 0, 'deleted': 0, 'kept': 0, 'freed': 0}
    if not THUMB_CACHE.is_dir():
        return stats

    for thumb in THUMB_CACHE.glob('*.jpg'):
        stats['checked'] += 1
        sidecar = thumb.with_suffix('.json')
        try:
            meta = json.loads(sidecar.read_text())
            st = os.stat(meta['path'])
            stale = (st.st_mtime_ns != meta.get('mtime_ns')
                     or st.st_size != meta.get('size')
                     or meta.get('version') != THUMB_VERSION)
        except (OSError, ValueError, KeyError, TypeError):
            stale = True
        if not stale:
            stats['kept'] += 1
            continue
        try:
            stats['freed'] += thumb.stat().st_size
            thumb.unlink(missing_ok=True)
            sidecar.unlink(missing_ok=True)
            stats['deleted'] += 1
        except OSError:
            continue

    # Sidecars whose thumbnail is already gone, and temp files an ffmpeg run
    # that died mid-write left behind.
    for leftover in (*THUMB_CACHE.glob('*.json'), *THUMB_CACHE.glob('*.tmp')):
        if leftover.suffix == '.json' and leftover.with_suffix('.jpg').exists():
            continue
        try:
            leftover.unlink(missing_ok=True)
        except OSError:
            pass
    return stats


# --- generation pool ------------------------------------------------------
#
# Two problems the pool solves, neither of which more browser tabs can.
#
# A grid of 100 videos issues 100 thumbnail requests. The browser caps itself
# at ~6 concurrent connections per origin, so without `warm_thumbs()` the work
# arrives six at a time however idle the machine is; with it, one request hands
# the whole visible page over and the pool runs it at its own width. The other
# way round, nothing stopped 100 requests from starting 100 ffmpeg processes on
# a box that is also downloading - the pool is the ceiling as well as the floor.
#
# The in-flight map is the other half: two viewers opening the same folder used
# to run the same ffmpeg twice, both writing the same output path. Now the
# second waits on the first's future.

_thumb_pool = None
_thumb_inflight = {}
_thumb_lock = threading.Lock()

# Cache name -> when its generation failed (an unreadable container, a codec
# ffmpeg can't decode, a download that is still arriving). A miss is not
# written to disk, so without this every grid view would re-run the same
# doomed ffmpeg - up to three 60s attempts - on each request. Failures expire
# after FAIL_RETRY_AFTER rather than sticking, because the commonest cause is a
# file still being downloaded: once it finishes it deserves another go, and a
# stalled download never changes the (mtime, size) key that would force one.
_thumb_failed = {}
FAIL_RETRY_AFTER = 600

# A file written to this recently is probably still arriving (a download, a
# copy in progress). ffmpeg would only fail on it, or worse, succeed on a
# truncated head and cache that; skip it and let a later view try.
SETTLING_SECONDS = 60


def _recently_failed(name):
    at = _thumb_failed.get(name)
    if at is None:
        return False
    if time.time() - at < FAIL_RETRY_AFTER:
        return True
    _thumb_failed.pop(name, None)
    return False


def _still_arriving(st):
    return time.time() - st.st_mtime < SETTLING_SECONDS

# Returned by thumbnail(wait=...) when the preview is still being made.
PENDING = object()


def _pool():
    global _thumb_pool
    if _thumb_pool is None:
        _thumb_pool = ThreadPoolExecutor(
            max_workers=THUMB_WORKERS, thread_name_prefix='thumb')
    return _thumb_pool


def _submit(cached, fn, *args):
    """Run `fn` on the pool, or join the run already making this same file."""
    key = cached.name
    with _thumb_lock:
        future = _thumb_inflight.get(key)
        fresh = future is None
        if fresh:
            future = _pool().submit(fn, *args)
            _thumb_inflight[key] = future
    if fresh:
        # Registered outside the lock: an already-finished future runs its
        # callback inline, and _forget() wants the same lock.
        future.add_done_callback(lambda _f, k=key: _forget(k))
    return future


def _forget(key):
    with _thumb_lock:
        _thumb_inflight.pop(key, None)


def _thumb_target(raw_path):
    """(source path, cache path, kind, stat) for a thumbnailable file, or None."""
    path = resolve_path(raw_path)
    if path.is_dir():
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    kind = kind_for(path.name)
    if kind not in ('image', 'video'):
        return None
    return path, THUMB_CACHE / _thumb_key(str(path), st), kind, st


def thumbnail(raw_path, wait=None):
    """Path to a cached JPEG preview for an image or video, or None.

    Images are a single scaled frame; videos are a 2x2 contact sheet. Keyed by
    (path, mtime, size), so replacing a file in place invalidates its preview
    without anyone having to clear a cache.

    `wait` bounds how long to block on a preview still being made, returning
    PENDING past it. The HTTP route needs that: a browser runs ~6 requests per
    origin, and a grid of 8K videos each holding its connection open for a
    minute of ffmpeg starves everything else in the tab - the video the user
    just clicked never even gets sent.
    """
    target = _thumb_target(raw_path)
    if target is None:
        return None
    path, cached, kind, st = target
    if cached.exists():
        return cached
    if _recently_failed(cached.name) or _still_arriving(st):
        return None
    THUMB_CACHE.mkdir(parents=True, exist_ok=True)
    future = _submit(cached, _generate, path, cached, kind, st)
    try:
        return future.result(timeout=wait)
    except FutureTimeout:
        return PENDING


def warm_thumbs(raw_paths):
    """Queue previews for a batch of files without waiting for them.

    What makes the pool worth having: the explorer hands over every video on
    the page it just rendered in one request, and by the time the individual
    <img> requests arrive - six at a time, as the browser allows - the files
    are either built or being built, and nothing is generated twice.
    """
    stats = {'queued': 0, 'cached': 0, 'skipped': 0}
    for raw in raw_paths:
        try:
            target = _thumb_target(raw)
        except FsError:
            target = None
        if target is None:
            stats['skipped'] += 1
            continue
        path, cached, kind, st = target
        if cached.exists():
            stats['cached'] += 1
            continue
        if _recently_failed(cached.name) or _still_arriving(st):
            stats['skipped'] += 1
            continue
        THUMB_CACHE.mkdir(parents=True, exist_ok=True)
        _submit(cached, _generate, path, cached, kind, st)
        stats['queued'] += 1
    return stats


# --- first pass, then the real sheet when the box is idle --------------------
#
# A video's first preview is one frame (_video_quick): on an 8K file that is
# ~2s against ~7s for the four-frame sheet, so a folder fills in about four
# times sooner. The sheet follows once nothing is left to snapshot and the CPU
# is idle, and only for files in a folder someone still has open - "open"
# meaning the grid polled thumb_status() for it within PRESENCE_SECONDS. The
# poll is the presence signal; there is no other notion of a viewer here.

UPGRADE_TICK = 3          # seconds between upgrader checks
UPGRADE_IDLE = 0.5        # CPU idle fraction over the last tick needed to start one
PRESENCE_SECONDS = 30     # how long after its last poll a folder counts as open

# cache name -> (source path, cache path, stat, last polled). Insertion order
# is grid order, so a folder upgrades top to bottom.
_upgrade_queue = {}
_upgrader = None


def _sidecar(cached):
    try:
        return json.loads(cached.with_suffix('.json').read_text())
    except (OSError, ValueError):
        return None


def thumb_status(raw_paths):
    """Where each path's preview stands, for the grid's poll.

    'ready' (final), 'quick' (first pass; now queued for a sheet), 'pending'
    (being made), 'waiting' (not made yet, or held back - still arriving, or a
    recent failure that will be retried), 'none' (never will be: not an image
    or video, or gone).
    """
    now = time.time()
    states = {}
    wants_upgrade = False
    for raw in raw_paths:
        try:
            target = _thumb_target(raw)
        except FsError:
            target = None
        if target is None:
            states[raw] = 'none'
            continue
        path, cached, kind, st = target
        if cached.exists():
            if (_sidecar(cached) or {}).get('stage') == 'quick':
                states[raw] = 'quick'
                with _thumb_lock:
                    _upgrade_queue[cached.name] = (path, cached, st, now)
                wants_upgrade = True
            else:
                states[raw] = 'ready'
        elif cached.name in _thumb_inflight:
            states[raw] = 'pending'
        else:
            states[raw] = 'waiting'
    if wants_upgrade:
        _ensure_upgrader()
    return states


def _cpu_sample():
    """(idle, total) jiffies from /proc/stat; iowait counts as busy - a disk
    being waited on is exactly when a sheet's four seeks would hurt."""
    try:
        with open('/proc/stat') as f:
            fields = [int(x) for x in f.readline().split()[1:]]
        return fields[3], sum(fields)
    except (OSError, ValueError, IndexError):
        return None


def _idle_since(prev):
    cur = _cpu_sample()
    if prev is None or cur is None or cur[1] <= prev[1]:
        return 0.0, cur
    return (cur[0] - prev[0]) / (cur[1] - prev[1]), cur


def _upgrade_step(idle):
    """One upgrader decision. Returns True if it built (or settled) a sheet."""
    now = time.time()
    with _thumb_lock:
        for name, entry in list(_upgrade_queue.items()):
            if now - entry[3] > PRESENCE_SECONDS:
                del _upgrade_queue[name]      # folder closed: forget its files
        if _thumb_inflight or not _upgrade_queue or idle < UPGRADE_IDLE:
            return False
        # Most recently polled first, in grid order within that poll.
        name = max(_upgrade_queue, key=lambda k: _upgrade_queue[k][3])
        path, cached, st, _seen = _upgrade_queue.pop(name)
    _upgrade(path, cached, st)
    return True


def _upgrade_loop():
    prev = _cpu_sample()
    while True:
        time.sleep(UPGRADE_TICK)
        idle, prev = _idle_since(prev)
        try:
            if _upgrade_step(idle):
                prev = _cpu_sample()          # don't count our own sheet next tick
        except Exception:
            pass                              # never let one bad file end the thread


def _ensure_upgrader():
    global _upgrader
    with _thumb_lock:
        if _upgrader is None or not _upgrader.is_alive():
            _upgrader = threading.Thread(target=_upgrade_loop, name='thumb-upgrade',
                                         daemon=True)
            _upgrader.start()


def _upgrade(path, cached, st):
    """Replace a quick preview with the four-frame sheet, in place.

    If the sheet can't be made the quick frame stays and is marked final, so
    the upgrader doesn't return to it every time the folder is opened.
    """
    meta = _sidecar(cached)
    if not cached.exists() or (meta or {}).get('stage') != 'quick':
        return cached
    tmp = cached.with_name(f'{cached.stem}.up.tmp')
    try:
        if _video_sheet(path, tmp, _video_duration(path)):
            os.replace(tmp, cached)
        _write_sidecar(cached, path, st, '2x2')
    except Exception:
        pass
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    return cached


def upgrade_thumb(raw_path):
    """Synchronously upgrade one quick preview (the upgrader's work, callable)."""
    target = _thumb_target(raw_path)
    if target is None:
        return None
    path, cached, _kind, st = target
    return _upgrade(path, cached, st)


def _generate(path, cached, kind, st):
    """Build one cache entry. Runs on the pool; never raises."""
    if cached.exists():      # a queued warm-up the foreground request beat to it
        return cached
    # ffmpeg and Pillow both write the output incrementally, so they write to a
    # temp name and get moved into place: a reader either sees no thumbnail or
    # a whole one, never the half a concurrent request used to be served.
    # `.tmp` carries no format, hence the explicit `-f image2` on every
    # ffmpeg run below.
    tmp = cached.with_suffix('.tmp')
    try:
        stage = 'final'
        if kind == 'image':
            made = _image_thumb(path, tmp)
        else:
            made, stage = _video_quick(path, tmp)
        if made != tmp:
            if made is None:
                _thumb_failed[cached.name] = time.time()
            return made      # None, or the original file (no Pillow)
        os.replace(tmp, cached)
        _write_sidecar(cached, path, st, '1x1' if kind == 'image' else '2x2', stage)
        return cached
    except Exception:
        _thumb_failed[cached.name] = time.time()
        return None
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _image_thumb(path, out):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return path  # no Pillow: hand back the original, the browser scales it
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((THUMB_MAX, THUMB_MAX))
            im.convert('RGB').save(out, 'JPEG', quality=80)
        return out
    except Exception:
        return None


def _video_duration(path):
    from backend.file_meta import FFPROBE_PATH
    try:
        proc = subprocess.run(
            [FFPROBE_PATH, '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=nw=1:nk=1', str(path)],
            capture_output=True, timeout=20, text=True,
        )
        return float(proc.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _video_sheet(path, out, duration):
    """A 2x2 contact sheet from four points spread through the runtime.

    Each point is its own ffmpeg, all four at once, joined with Pillow. Every
    grab decodes exactly one keyframe (_ONE_KEYFRAME), so the cost is that one
    decode plus the disk seek to reach it - and on a spinning disk the seek is
    as much of it as the decode. Measured on an 8K 10-bit HEVC VR file on this
    box: ~2s of CPU per keyframe, whatever the thread count; one process with
    four inputs took 14.7s, because it works through its inputs one after the
    other, while four processes took 7.4s. (Decoding up to the exact timestamp
    instead, as this used to, meant up to 600 8K frames per point: it never
    finished inside the timeout.)

    Without Pillow the four inputs go through one ffmpeg and xstack instead -
    slower, but no new dependency.
    """
    from backend.file_meta import FFMPEG_PATH
    if duration and duration > 1:
        seeks = [f'{duration * frac:.3f}' for frac in SHEET_AT]
        try:
            from PIL import Image  # noqa: F401
            have_pillow = True
        except ImportError:
            have_pillow = False
        if have_pillow:
            if _parallel_sheet(FFMPEG_PATH, path, seeks, out):
                return out
        else:
            inputs, filters, labels = [], [], []
            for i, seek in enumerate(seeks):
                inputs += [*_ONE_KEYFRAME, '-ss', seek, '-i', str(path)]
                filters.append(f'[{i}:v]scale={THUMB_MAX}:-2,setsar=1,format=yuv420p[t{i}]')
                labels.append(f'[t{i}]')
            filters.append(
                f'{"".join(labels)}xstack=inputs={len(SHEET_AT)}'
                ':layout=0_0|w0_0|0_h0|w0_h0[sheet]')
            if _run_ffmpeg([FFMPEG_PATH, '-y', '-loglevel', 'error', *inputs,
                            '-filter_complex', ';'.join(filters),
                            '-map', '[sheet]', '-frames:v', '1', '-q:v', '4',
                            '-f', 'image2', str(out)], out):
                return out

    return None


def _video_quick(path, out):
    """First-pass video preview: one frame, tiled into the sheet's shape.

    A quarter of a sheet's work - one keyframe instead of four - so opening a
    folder of 8K files fills the whole grid before any single file gets its
    full treatment. Returns (out or None, stage): 'quick' when a sheet can
    follow, 'final' when it can't (no duration to spread four seeks over).

    Tiled rather than served as a lone frame so every video preview is the
    same shape and the client never has to know which one it got.
    """
    from backend.file_meta import FFMPEG_PATH
    duration = _video_duration(path)
    sheetable = bool(duration and duration > 1)
    seeks = [['-ss', f'{duration * QUICK_AT:.3f}']] if sheetable else []
    # A fixed 5s when the length is unknown, then from the top for a clip
    # shorter than that.
    for seek in (*seeks, ['-ss', '5'], []):
        if _run_ffmpeg([FFMPEG_PATH, '-y', '-loglevel', 'error',
                        *_ONE_KEYFRAME, *seek, '-i', str(path),
                        '-frames:v', '1', '-vf', f'scale={THUMB_MAX}:-2',
                        '-f', 'image2', str(out)], out):
            return _tile_single(out), ('quick' if sheetable else 'final')
    return None, 'final'


def _parallel_sheet(ffmpeg, path, seeks, out):
    """Grab one frame per seek concurrently and tile them into `out`.

    All four or nothing: a sheet with a hole in it would read as a broken
    preview, so any failed grab sends the caller to its single-frame fallback.
    """
    frames = [out.with_name(f'{out.stem}.{i}.tmp') for i in range(len(seeks))]

    def grab(i):
        return _run_ffmpeg([ffmpeg, '-y', '-loglevel', 'error', *_ONE_KEYFRAME,
                            '-ss', seeks[i], '-i', str(path), '-frames:v', '1',
                            '-vf', f'scale={THUMB_MAX}:-2', '-f', 'image2',
                            str(frames[i])], frames[i])

    try:
        # Per-sheet threads rather than more pool work: the pool bounds how
        # many files are in progress, and these only ever wait on ffmpeg.
        with ThreadPoolExecutor(max_workers=len(seeks)) as ex:
            if not all(ex.map(grab, range(len(seeks)))):
                return False
        from PIL import Image
        tiles = []
        for f in frames:
            with Image.open(f) as im:
                tiles.append(im.convert('RGB'))
        w, h = tiles[0].size
        sheet = Image.new('RGB', (w * SHEET_COLS, h * SHEET_ROWS))
        for i, tile in enumerate(tiles):
            if tile.size != (w, h):
                tile = tile.resize((w, h))
            sheet.paste(tile, ((i % SHEET_COLS) * w, (i // SHEET_COLS) * h))
        sheet.save(out, 'JPEG', quality=80)
        return True
    except Exception:
        return False
    finally:
        for f in frames:
            try:
                f.unlink(missing_ok=True)
            except OSError:
                pass


# Per-input options: decode exactly one frame - the keyframe the seek lands on
# - on one thread. By default ffmpeg decodes from that keyframe up to the exact
# timestamp, and frame threading keeps a frame per thread in flight; on an 8K
# HEVC file that was ~1.4 GB and several cores per ffmpeg, four inputs each,
# times the pool width. The keyframe is at most a GOP away from the mark,
# which is invisible in a 480px tile.
_ONE_KEYFRAME = ['-threads', '1', '-skip_frame', 'nokey', '-noaccurate_seek']


def _background():
    """preexec_fn: previews yield the CPU to playback and downloads."""
    try:
        os.nice(19)
    except OSError:
        pass


# Lowest best-effort IO priority, when util-linux is there, so playback off the
# same spinning disk goes first. Not the idle class: that waits for the disk
# to go quiet and measured 6.8s against 3.0s for one cold 8K frame.
_IONICE = ['ionice', '-c', '2', '-n', '7'] if shutil.which('ionice') else []


def _run_ffmpeg(cmd, out):
    # 60s, against ~14s measured for the slowest thing on this box (a 4K AV1
    # sheet). The old single-frame limit of 20s would have timed that out; much
    # more than this and one pathological file holds a pool worker for minutes.
    try:
        proc = subprocess.run([*_IONICE, *cmd], capture_output=True, timeout=60,
                              preexec_fn=_background)
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0 and out.exists() and out.stat().st_size > 0


def _tile_single(out):
    """Repeat a single frame into the 2x2 grid a video preview is expected to be."""
    try:
        from PIL import Image
        with Image.open(out) as im:
            frame = im.convert('RGB')
            sheet = Image.new('RGB', (frame.width * SHEET_COLS, frame.height * SHEET_ROWS))
            for row in range(SHEET_ROWS):
                for col in range(SHEET_COLS):
                    sheet.paste(frame, (col * frame.width, row * frame.height))
        sheet.save(out, 'JPEG', quality=80)
    except Exception:
        pass  # leave the single frame; it renders as the first tile, zoomed
    return out

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
import os
import shutil
import stat as stat_module
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from backend.config import BASE_DIR, DOWNLOAD_DIR, SCREENSHOTS_DIR, EXPLORER_READONLY
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


def list_roots():
    """Places for the explorer sidebar: shortcuts first, then real disks.

    Read fresh from /proc/mounts on every call, so plugging in a drive only
    costs the user a refresh.
    """
    roots = []
    seen = set()

    def add(path, label, kind, device=None, fstype=None):
        try:
            resolved = str(Path(path).expanduser().resolve())
        except OSError:
            return
        if resolved in seen or not os.path.isdir(resolved):
            return
        seen.add(resolved)
        roots.append({
            'path': resolved,
            'label': label,
            'kind': kind,
            'device': device,
            'fstype': fstype,
            'usage': _usage(resolved),
            'writable': os.access(resolved, os.W_OK),
        })

    add(Path.home(), 'Home', 'home')
    add(DOWNLOAD_DIR, 'Downloads', 'downloads')

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
        add(mountpoint, label, 'disk', device=device, fstype=fstype)

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
    if _mountpoint_for(path) != '/':
        return  # a mounted data disk - exactly what this feature is for
    for prefix in PROTECTED_ROOTS:
        if p == prefix or p.startswith(prefix + '/'):
            raise FsError(f'{prefix} belongs to the operating system and is read-only here', 403)


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
THUMB_MAX = 480


def _thumb_key(path, st):
    raw = f'{path}:{st.st_mtime_ns}:{st.st_size}'.encode()
    return hashlib.sha1(raw).hexdigest() + '.jpg'


def thumbnail(raw_path):
    """Path to a cached JPEG preview for an image or video, or None.

    Keyed by (path, mtime, size), so replacing a file in place invalidates its
    thumbnail without anyone having to clear a cache.
    """
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

    THUMB_CACHE.mkdir(parents=True, exist_ok=True)
    cached = THUMB_CACHE / _thumb_key(str(path), st)
    if cached.exists():
        return cached

    if kind == 'image':
        return _image_thumb(path, cached)
    return _video_thumb(path, cached)


def _image_thumb(path, cached):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return path  # no Pillow: hand back the original, the browser scales it
    try:
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            im.thumbnail((THUMB_MAX, THUMB_MAX))
            im.convert('RGB').save(cached, 'JPEG', quality=80)
        return cached
    except Exception:
        return None


def _video_thumb(path, cached):
    from backend.file_meta import FFMPEG_PATH
    try:
        proc = subprocess.run(
            [FFMPEG_PATH, '-y', '-loglevel', 'error', '-ss', '5', '-i', str(path),
             '-frames:v', '1', '-vf', f'scale={THUMB_MAX}:-2', str(cached)],
            capture_output=True, timeout=20,
        )
        if proc.returncode == 0 and cached.exists() and cached.stat().st_size:
            return cached
        # Clips shorter than the seek offset need a seek-to-zero retry.
        proc = subprocess.run(
            [FFMPEG_PATH, '-y', '-loglevel', 'error', '-i', str(path),
             '-frames:v', '1', '-vf', f'scale={THUMB_MAX}:-2', str(cached)],
            capture_output=True, timeout=20,
        )
        return cached if cached.exists() and cached.stat().st_size else None
    except (OSError, subprocess.SubprocessError):
        return None

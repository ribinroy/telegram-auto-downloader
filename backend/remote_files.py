"""The VPS as a drive in the file explorer, over SFTP.

`files.py` is deliberately pure local filesystem - that invariant is what keeps
it simple - so the remote half lives here and mirrors the parts of its surface
the explorer actually calls. The route layer picks between the two on a path
prefix; everything else in the stack (the URL, the breadcrumb, selection, the
clipboard) treats a path as an opaque string and needs no idea which side it
came from.

Remote paths carry a `vps:` prefix, e.g. `vps:/home6/user/downloads`. Entries
come back in exactly the shape `files.py` produces, prefix included, so the
frontend renders a remote folder with the same components as a local one.

Scope is deliberately read-mostly. Listing, searching, sizing, previewing text
and deleting map cleanly onto SFTP. Copying a file *down* is not implemented
here at all: that is `vps_handler.start_download()`, which already gives a
download record, live progress, resume and the watchdog - reimplementing it as
a blocking copy inside a web request would be a strictly worse version.
Thumbnails are not offered remotely on purpose; a grid view would pull hundreds
of files across the internet to make JPEGs out of them.
"""
import posixpath
import stat as stat_module
import time

from backend.files import FsError, _iso, kind_for
from backend.web_app.vps import load_vps_credentials, vps_session

PREFIX = 'vps:'

# The quota read behind a remote listing's capacity bar. Cheap on a warm
# connection, but pointless to repeat for every folder a user clicks through.
_QUOTA_TTL = 60
_quota_cache = {'at': 0.0, 'usage': None}


# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

def is_remote(raw) -> bool:
    return isinstance(raw, str) and raw.startswith(PREFIX)


def any_remote(raws) -> bool:
    return any(is_remote(r) for r in (raws or []))


def tag(path: str) -> str:
    """Local-looking remote path -> the prefixed form the UI carries."""
    return PREFIX + path


def strip(raw: str) -> str:
    """Prefixed path -> the plain POSIX path to send over SFTP.

    `vps:~` is the sidebar root: it means "wherever this login lands", which
    only the far end can resolve, so it becomes an empty path and `_clean`
    turns it into the login home.
    """
    if not is_remote(raw):
        return raw
    path = raw[len(PREFIX):]
    if path in ('', '~'):
        return ''
    return path


def _clean(sftp, raw=None):
    """Resolve a request path against the remote box (login home by default)."""
    path = strip(raw or '').strip()
    try:
        return sftp.normalize(path) if path else sftp.normalize('.')
    except IOError:
        raise FsError('Not found on the VPS', 404)


def _home(sftp):
    """The login's home directory - the top of the browsable remote tree."""
    try:
        return sftp.normalize('.')
    except IOError:
        return '/'


def _io_error(e, what):
    """Map an SFTP IOError to a user-facing FsError.

    Errno matters here: on a shared seedbox the directory *above* your home is
    deliberately unreadable, and reporting that as "not found" sends you
    hunting for a missing folder that is really just someone else's business.
    """
    import errno
    if getattr(e, 'errno', None) == errno.EACCES:
        return FsError(f'Permission denied on the VPS ({what})', 403)
    return FsError(f'{what}: {e}', 404)


# --------------------------------------------------------------------------
# Entries
# --------------------------------------------------------------------------

def _entry(parent, name, attr, is_dir=None, is_link=False):
    full = posixpath.join(parent, name) if parent else name
    if is_dir is None:
        is_dir = bool(attr and stat_module.S_ISDIR(attr.st_mode))
    ext = posixpath.splitext(name)[1].lower().lstrip('.')
    return {
        'name': name,
        'path': tag(full),
        'is_dir': is_dir,
        'is_link': is_link,
        'broken': attr is None,
        'hidden': name.startswith('.'),
        'size': 0 if is_dir else ((attr.st_size or 0) if attr else 0),
        'modified': _iso(attr.st_mtime if attr else None),
        'mode': stat_module.filemode(attr.st_mode) if attr else None,
        'kind': kind_for(name, is_dir),
        'ext': ext,
        # Marks the row as living on the other side, so the UI can drop the
        # actions that only make sense locally.
        'remote': True,
    }


def stat_entry(raw_path):
    with vps_session() as (_client, sftp):
        path = _clean(sftp, raw_path)
        try:
            attr = sftp.stat(path)
        except IOError:
            raise FsError('Not found on the VPS', 404)
        return _entry(posixpath.dirname(path.rstrip('/')) or '/',
                      posixpath.basename(path.rstrip('/')) or path, attr)


# --------------------------------------------------------------------------
# Roots
# --------------------------------------------------------------------------

def list_roots(usage=None):
    """The VPS as a sidebar drive, or nothing when it is not configured.

    No SSH is done here - the explorer's root list is fetched on every page
    load and must not wait on a login across the internet. The capacity bar is
    filled in by the first listing instead.
    """
    creds = load_vps_credentials()
    if not creds:
        return []
    return [{
        'path': PREFIX + '~',
        'label': creds['host'],
        'kind': 'vps',
        'group': 'drive',
        'note': f"{creds['username']}@{creds['host']} · SFTP",
        'device': None,
        'fstype': 'sftp',
        'usage': usage,
        'writable': False,
        'remote': True,
    }]


def _quota_usage(client):
    """Account quota as the sidebar's {total, used, free, percent}, cached."""
    now = time.time()
    if _quota_cache['usage'] and now - _quota_cache['at'] < _QUOTA_TTL:
        return _quota_cache['usage']
    from backend.web_app.vps import _parse_quota, _parse_df
    try:
        _, out, err = client.exec_command(
            'quota -w 2>/dev/null; echo "@@DF@@"; df -Pk "$HOME" 2>/dev/null', timeout=15)
        text = out.read().decode(errors='replace') + err.read().decode(errors='replace')
    except Exception:
        return None
    quota_txt, _, df_txt = text.partition('@@DF@@')
    parsed = _parse_quota(quota_txt)
    if parsed and parsed[1]:
        used, total = parsed[0], parsed[1]
    else:
        vol = _parse_df(df_txt)
        if not vol:
            return None
        used, total = vol['used'], vol['used'] + vol['avail']
    usage = {
        'total': total, 'used': used, 'free': max(0, total - used),
        'percent': round(used / total * 100, 1) if total else None,
    }
    _quota_cache.update(at=now, usage=usage)
    return usage


# --------------------------------------------------------------------------
# Listing
# --------------------------------------------------------------------------

def list_dir(raw_path=None, show_hidden=False):
    with vps_session() as (client, sftp):
        path = _clean(sftp, raw_path)
        try:
            attrs = sftp.listdir_attr(path)
        except IOError as e:
            raise _io_error(e, 'could not list the remote folder')

        entries = []
        for attr in attrs:
            name = attr.filename
            if name in ('.', '..'):
                continue
            if not show_hidden and name.startswith('.'):
                continue
            is_link = stat_module.S_ISLNK(attr.st_mode)
            if is_link:
                # listdir_attr does not follow links, so a symlinked folder
                # would otherwise be listed (and sorted) as a file.
                try:
                    attr = sftp.stat(posixpath.join(path, name))
                except IOError:
                    entries.append(_entry(path, name, None, is_dir=False, is_link=True))
                    continue
            entries.append(_entry(path, name, attr, is_link=is_link))

        entries.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))
        # The login home is the top of the tree. Above it is the provider's
        # shared /homeN, which the account cannot list - offering an "up" that
        # can only fail is worse than not offering one.
        home = _home(sftp)
        at_top = path in ('/', '', home)
        parent = posixpath.dirname(path.rstrip('/')) or '/'
        return {
            'path': tag(path),
            'parent': None if at_top else tag(parent),
            'name': posixpath.basename(path.rstrip('/')) or path,
            'entries': entries,
            # Phase one is read-mostly: no remote rename/mkdir/upload, so the
            # toolbar's write actions stay off rather than failing on click.
            'writable': False,
            'usage': _quota_usage(client),
            'mount': None,
            'trash': None,
            'remote': True,
            # Where the browsable tree starts, so the breadcrumb doesn't offer
            # crumbs for the provider's shared /homeN above it.
            'home': tag(home),
        }


# --------------------------------------------------------------------------
# Search / size / preview
# --------------------------------------------------------------------------

def search(raw_root, query, limit=500, timeout=15.0, show_hidden=False):
    """Recursive name search, bounded by a result cap and a deadline.

    Each directory level is a network round-trip, so the deadline matters far
    more than it does locally - "search from the home dir" over SFTP can walk
    for minutes.
    """
    needle = (query or '').strip().lower()
    if len(needle) < 2:
        raise FsError('Search needs at least 2 characters')

    deadline = time.monotonic() + timeout
    results, truncated = [], False
    with vps_session() as (_client, sftp):
        root = _clean(sftp, raw_root)
        queue = [root]
        while queue:
            if time.monotonic() > deadline:
                truncated = True
                break
            current = queue.pop(0)
            try:
                attrs = sftp.listdir_attr(current)
            except IOError:
                continue
            for attr in attrs:
                name = attr.filename
                if name in ('.', '..') or (not show_hidden and name.startswith('.')):
                    continue
                is_dir = stat_module.S_ISDIR(attr.st_mode)
                if is_dir:
                    queue.append(posixpath.join(current, name))
                if needle in name.lower():
                    results.append(_entry(current, name, attr, is_dir=is_dir))
                    if len(results) >= limit:
                        truncated = True
                        break
            if truncated:
                break
    return {'root': tag(root), 'query': query, 'entries': results, 'truncated': truncated}


def dir_size(raw_path, timeout=20.0):
    """Recursive size via `du -sb`, which is one round-trip instead of a walk."""
    with vps_session() as (client, sftp):
        path = _clean(sftp, raw_path)
        try:
            attr = sftp.stat(path)
        except IOError:
            raise FsError('Not found on the VPS', 404)
        if not stat_module.S_ISDIR(attr.st_mode):
            return {'path': tag(path), 'size': attr.st_size or 0,
                    'files': 1, 'dirs': 0, 'partial': False}

        quoted = "'" + path.replace("'", "'\\''") + "'"
        _, out, _err = client.exec_command(
            f'du -sb {quoted} 2>/dev/null; echo "@@N@@"; '
            f'find {quoted} -type f 2>/dev/null | wc -l; '
            f'find {quoted} -mindepth 1 -type d 2>/dev/null | wc -l',
            timeout=timeout)
        text = out.read().decode(errors='replace')
        du_txt, _, counts = text.partition('@@N@@')
        try:
            size = int(du_txt.split()[0])
        except (IndexError, ValueError):
            raise FsError('Could not measure the remote folder')
        nums = [int(n) for n in counts.split() if n.isdigit()]
        return {
            'path': tag(path), 'size': size,
            'files': nums[0] if nums else 0,
            'dirs': nums[1] if len(nums) > 1 else 0,
            'partial': False,
        }


def read_text(raw_path, max_bytes=65536):
    with vps_session() as (_client, sftp):
        path = _clean(sftp, raw_path)
        try:
            attr = sftp.stat(path)
            if stat_module.S_ISDIR(attr.st_mode):
                raise FsError('Not a file')
            with sftp.open(path, 'rb') as f:
                raw = f.read(max_bytes)
        except IOError as e:
            raise FsError(f'Could not read the remote file: {e}', 404)
        return {
            'path': tag(path),
            'text': raw.decode('utf-8', errors='replace'),
            'truncated': (attr.st_size or 0) > len(raw),
            'size': attr.st_size or 0,
        }


# --------------------------------------------------------------------------
# Mutations
# --------------------------------------------------------------------------

def delete(raw_paths, permanent=False):
    """Remove remote files/folders.

    Always permanent: the local side moves to a per-mount `.downlee-trash`,
    which only works because the trash sits on the same filesystem as the file.
    There is no such guarantee on the VPS, and silently inventing a trash
    directory in someone's seedbox home would be worse than being explicit -
    the UI says "permanently" for remote deletes.
    """
    removed, errors = [], []
    with vps_session() as (_client, sftp):
        def rmtree(path):
            for attr in sftp.listdir_attr(path):
                child = posixpath.join(path, attr.filename)
                if stat_module.S_ISDIR(attr.st_mode):
                    rmtree(child)
                else:
                    sftp.remove(child)
            sftp.rmdir(path)

        for raw in raw_paths or []:
            try:
                path = _clean(sftp, raw)
                attr = sftp.stat(path)
                if stat_module.S_ISDIR(attr.st_mode):
                    rmtree(path)
                else:
                    sftp.remove(path)
                removed.append(tag(path))
            except Exception as e:
                errors.append({'path': raw, 'error': str(e)})
    return {'removed': removed, 'errors': errors, 'permanent': True}

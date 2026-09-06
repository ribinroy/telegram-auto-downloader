r"""Filename rewrite rules.

User-defined regexes rewrite a download's filename **before the transfer
starts**, so the file is written under its final name from the first byte.
Nothing is renamed mid-flight, nothing has to be undone if a transfer is
interrupted, and no partial file is ever orphaned under an old name.

The same chain can be replayed over already-downloaded files from
Settings -> Renaming ("apply to existing"), which is the only path that touches
files on disk - and it only considers completed downloads, so it can never race
a running transfer.

Rules match against the filename **stem** - the extension is split off first
and reattached afterwards, so it can never be mangled. That matters more than
it sounds: the most natural "dots to spaces" rule, `(?<=\w)\.(?=\w)`, would
otherwise turn `Movie.mkv` into `Movie mkv` and break playback. Patterns
therefore target `.1080p` or `-GROUP`, not `.1080p.` or `-GROUP.mkv`.
"""
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path

logger = logging.getLogger(__name__)

# Illegal in a path component on Windows and/or meaningful to a path parser.
# Stripped rather than rejected, so a rule that produces "Movie: Part 2" still
# yields something usable.
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

MAX_NAME_BYTES = 255          # ext4 and friends
MAX_PATTERN_LENGTH = 500
# A user regex can backtrack catastrophically; without a ceiling a bad pattern
# would wedge whichever thread ran it.
REGEX_TIMEOUT_SECONDS = 2.0

_regex_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='regex')

# Compiled rules, rebuilt only when a rule actually changes.
_rules_cache = {'token': None, 'rules': []}
_rules_lock = threading.Lock()


class RenameError(Exception):
    """Raised with a user-facing message when a name can't be used."""


class InvalidPattern(Exception):
    """A rule's regex or replacement won't compile."""


# --------------------------------------------------------------------------
# Names
# --------------------------------------------------------------------------

def sanitize_filename(name: str, fallback_ext: str = '') -> str:
    """Turn arbitrary text into a safe basename.

    Restores the extension when the rules stripped it, so a rewritten video
    stays playable and MIME-detectable.
    """
    name = _ILLEGAL.sub('', (name or '')).strip().strip('.').strip()
    if not name or name in ('.', '..'):
        raise RenameError('Rules produced an empty name')

    if fallback_ext and not Path(name).suffix:
        name = name + fallback_ext

    # Trim the stem, never the extension.
    if len(name.encode('utf-8')) > MAX_NAME_BYTES:
        suffix = Path(name).suffix
        stem = name[:len(name) - len(suffix)]
        budget = MAX_NAME_BYTES - len(suffix.encode('utf-8'))
        while len(stem.encode('utf-8')) > budget and stem:
            stem = stem[:-1]
        name = (stem or 'file') + suffix

    return name


def unique_name(directory: Path, name: str) -> str:
    """A free filename in `directory`, suffixing " (2)", " (3)"... on collision.

    Bulk runs are unattended, so a clash must resolve to something rather than
    abort the batch.
    """
    if not (directory / name).exists():
        return name
    stem, suffix = Path(name).stem, Path(name).suffix
    for n in range(2, 1000):
        candidate = f"{stem} ({n}){suffix}"
        if not (directory / candidate).exists():
            return candidate
    return name


# --------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------

def validate_rule(pattern: str, replacement: str = ''):
    """Compile a rule the way the engine will, with a readable error.

    Called on save, so a broken rule can never reach the download path.
    """
    if not pattern:
        raise InvalidPattern('Pattern cannot be empty')
    if len(pattern) > MAX_PATTERN_LENGTH:
        raise InvalidPattern(f'Pattern is too long (max {MAX_PATTERN_LENGTH} characters)')
    try:
        compiled = re.compile(pattern)
    except re.error as e:
        raise InvalidPattern(f'Invalid regex: {e}')

    # Surfaces bad backreferences (\9 with one group) now, not at download time.
    try:
        compiled.sub(replacement or '', '')
    except re.error as e:
        raise InvalidPattern(f'Invalid replacement: {e}')
    return compiled


def _load_rules():
    """Enabled rules, compiled, in application order. Cached by change token."""
    from backend.database import get_db

    db = get_db()
    token = db.get_rename_rules_token()
    with _rules_lock:
        if _rules_cache['token'] == token:
            return _rules_cache['rules']

    compiled = []
    for rule in db.get_rename_rules(enabled_only=True):
        try:
            compiled.append((rule, re.compile(rule['pattern'])))
        except re.error as e:
            logger.error("Skipping rename rule %s (bad regex): %s", rule.get('id'), e)

    with _rules_lock:
        _rules_cache['token'] = token
        _rules_cache['rules'] = compiled
    return compiled


def invalidate_rules_cache():
    """Force a reload on the next apply (called after any rule edit)."""
    with _rules_lock:
        _rules_cache['token'] = None


def _sub_with_timeout(compiled, replacement, text):
    """One substitution, abandoned if the pattern backtracks forever."""
    future = _regex_executor.submit(compiled.sub, replacement, text)
    try:
        return future.result(timeout=REGEX_TIMEOUT_SECONDS)
    except FutureTimeout:
        # The worker keeps spinning until the process exits, but the request
        # is not held hostage by one bad pattern.
        raise InvalidPattern('Pattern took too long to evaluate')


def apply_rules(filename: str, source: str = None, rules=None):
    """Run the chain over a filename.

    Rules see the stem only; the extension is split off here and reattached at
    the end, so no pattern can accidentally destroy it. Returns
    (new_name, applied) where `applied` names the rules that changed something.
    `rules` overrides the stored set (used by the test endpoint to preview an
    unsaved rule).
    """
    if not filename:
        return filename, []

    original = filename
    suffix = Path(filename).suffix
    current = filename[:len(filename) - len(suffix)] if suffix else filename
    applied = []

    for rule, compiled in (rules if rules is not None else _load_rules()):
        if rule.get('source') and rule['source'] != (source or ''):
            continue
        try:
            if not compiled.search(current):
                continue
            result = _sub_with_timeout(compiled, rule.get('replacement') or '', current)
        except (InvalidPattern, re.error) as e:
            logger.error("Rename rule %s skipped: %s", rule.get('id'), e)
            continue

        if result != current:
            applied.append(rule.get('name') or rule.get('pattern'))
            current = result
        if rule.get('stop_on_match'):
            break

    if not applied:
        return original, []

    # Tidy the separators a substitution usually leaves behind.
    current = re.sub(r'\s{2,}', ' ', current).strip(' .-_')

    if not current:
        # A rule wiped the whole name. Reattaching the extension would leave a
        # file called "mkv.mkv"; keeping the original is the safer failure.
        logger.warning("Rename rules emptied the name for %r; keeping it", original)
        return original, []

    try:
        current = sanitize_filename(current + suffix, fallback_ext=suffix)
    except RenameError:
        logger.warning("Rename rules produced an unusable name for %r; keeping it", original)
        return original, []

    return (original, []) if current == original else (current, applied)


def preview_rules(filename: str, source: str = None, rules=None) -> dict:
    """What the chain would do to this name, touching nothing."""
    new_name, applied = apply_rules(filename, source, rules=rules)
    return {'original': filename, 'new': new_name,
            'changed': new_name != filename, 'applied': applied}


def rename_for_download(filename: str, source: str = None) -> str:
    """Entry point for the handlers: the name a new download should use.

    Always sanitizes, whether or not a rule fired. The input is attacker-
    influenced - a Telegram attachment name, a remote SFTP basename, a yt-dlp
    title - and every caller joins the result onto a directory, so a name
    carrying `/` or `..` must never reach the filesystem.

    Never raises: a broken rule must not stop a download from starting.
    """
    try:
        new_name, applied = apply_rules(filename, source)
        if applied:
            logger.info("Rename rules: %r -> %r (%s)", filename, new_name, ', '.join(applied))
        return sanitize_filename(new_name, fallback_ext=Path(filename).suffix)
    except Exception as e:
        logger.error("Rename rules failed for %r, falling back: %s", filename, e)
        try:
            return sanitize_filename(filename, fallback_ext=Path(filename).suffix)
        except RenameError:
            # Nothing usable survives (e.g. the name was just dots). Anything
            # returned here is joined onto a directory, so it must be inert -
            # `Path('..').name` is '..', which is exactly what can't escape.
            return 'download'


# --------------------------------------------------------------------------
# Applying to files already on disk
# --------------------------------------------------------------------------

def find_current_path(download: dict):
    """Where a download's file actually is right now, or None."""
    from backend.web_app.helpers import candidate_file_paths
    file_name = download.get('file')
    if not file_name:
        return None
    for path in candidate_file_paths(download, file_name):
        if path.exists():
            return path
    return None


def apply_to_existing(dry_run: bool = True, limit: int = None) -> dict:
    """Replay the rule chain over completed downloads.

    Only `done` downloads are considered, so this can never race a transfer in
    progress. Returns the per-file plan (or result), so the UI can show a diff
    before anything is touched.
    """
    from backend.database import get_db

    db = get_db()
    results = []
    renamed = skipped = failed = 0

    for download in db.get_all_downloads():
        if download.get('status') != 'done' or download.get('file_deleted'):
            continue

        current_name = download.get('file') or ''
        new_name, applied = apply_rules(current_name, download.get('downloaded_from'))
        if not applied:
            continue

        entry = {
            'id': download['id'],
            'from': current_name,
            'to': new_name,
            'applied': applied,
            'source': download.get('downloaded_from'),
        }

        current_path = find_current_path(download)
        if not current_path:
            entry['status'] = 'missing'
            entry['note'] = 'File not found on disk'
            skipped += 1
            results.append(entry)
            continue

        final_name = unique_name(current_path.parent, new_name)
        if final_name != new_name:
            entry['to'] = final_name
            entry['note'] = 'Renamed to avoid a name collision'

        if dry_run:
            entry['status'] = 'would_rename'
        else:
            try:
                os.replace(current_path, current_path.parent / final_name)
                db.update_download_by_id(download['id'], file=final_name)
                entry['status'] = 'renamed'
                renamed += 1
                _emit_renamed(download['id'], download.get('message_id'), final_name)
            except OSError as e:
                entry['status'] = 'failed'
                entry['note'] = str(e)
                failed += 1

        results.append(entry)
        if limit and len(results) >= limit:
            break

    return {
        'dry_run': dry_run,
        'total': len(results),
        'renamed': renamed,
        'skipped': skipped,
        'failed': failed,
        'items': results,
    }


def _emit_renamed(download_id, message_id, new_name):
    """Tell connected clients the name changed."""
    try:
        from backend.web_app import get_socketio
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:renamed', {
                'id': download_id,
                'message_id': str(message_id) if message_id else None,
                'file': new_name,
            })
    except Exception as e:
        logger.debug("Could not emit rename event: %s", e)

"""
VPS (SSH/SFTP) download handler.

Downloads files from a remote VPS to the local DOWNLOAD_DIR over SFTP, mirroring
the source folder structure under DOWNLOAD_DIR/VPS. paramiko is synchronous, so
each download runs in its own daemon thread (not the asyncio loop).

Also runs an hourly autoSync scheduler that watches folders flagged auto_sync and
auto-downloads files that appear after sync was enabled.
"""
import os
import json
import time
import stat as stat_module
import posixpath
import logging
import asyncio
import threading
from datetime import datetime
from pathlib import Path

from backend.config import DOWNLOAD_DIR
from backend.database import get_db, generate_uuid
from backend import metrics
from backend.file_meta import poll_and_extract_meta, is_video_file

logger = logging.getLogger(__name__)

SYNC_INTERVAL_SECONDS = 3600  # check autoSync folders hourly

# Bounded transfer window: paramiko's get()/prefetch()/readv() issue read
# requests for the WHOLE file up front and buffer responses in memory ahead
# of the consumer, which balloons to gigabytes on large files. Instead we
# read in batches of pipelined requests and fully drain each batch, so at
# most TRANSFER_BATCH * TRANSFER_CHUNK bytes (8 MiB) are in flight.
TRANSFER_CHUNK = 1 << 17  # 128 KiB per request
TRANSFER_BATCH = 64       # concurrent requests per batch


# Per-file decisions in a folder pull (`downloads.file_status` values). A
# paused file holds the pull back (it ends `paused`); a skipped one is left
# out, so the pull can finish `done` without it.
FILE_STATES = ('paused', 'skipped')


class _FileSkipped(Exception):
    """The file being transferred was paused or skipped: keep its bytes, move on."""


class _Cancelled(Exception):
    """Raised inside the SFTP progress callback to abort a download."""


class VpsDownloader:
    def __init__(self, download_tasks, loop=None):
        self.download_tasks = download_tasks
        self.loop = loop
        self.threads = {}      # message_id -> threading.Thread
        self.clients = {}      # message_id -> active transfer's SSHClient (for forced abort)
        self.cancelled = set()  # message_ids requested to stop
        # local file -> message_id of the transfer writing it. A whole-torrent
        # pull can reach a file that a per-file pull of the same torrent is
        # still fetching; two writers appending to one partial would corrupt it.
        self.writing = {}
        self.plans = {}  # message_id -> running transfer's _plan() + 'current' file
        # message_id -> {path: 'paused'|'skipped'} for a running folder pull;
        # the transfer reads this live, the DB (`file_status`) keeps it.
        self.file_status = {}
        self.writing_lock = threading.Lock()
        # autoSync baseline: folder path -> set of filenames already accounted for
        self._seen = {}
        self._seen_lock = threading.Lock()

    # --- SFTP helpers -----------------------------------------------------
    def _open_sftp(self, timeout=15):
        """Open an SSH+SFTP session using saved credentials. Caller closes client."""
        from backend.web_app import open_vps_sftp
        return open_vps_sftp(timeout=timeout)

    # --- WebSocket emit helpers (mirror ytdlp_handler) --------------------
    def emit_progress(self, message_id, progress, downloaded_bytes, total_bytes, speed, pending_time):
        from backend.web_app import get_socketio, get_web_app
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:progress', {
                'message_id': message_id,
                'progress': progress,
                'downloaded_bytes': downloaded_bytes,
                'total_bytes': total_bytes,
                'speed': speed,
                'pending_time': pending_time,
            })
            web_app = get_web_app()
            if web_app:
                web_app.emit_stats()

    def emit_status(self, message_id, status, error=None):
        from backend.web_app import get_socketio, get_web_app
        socketio = get_socketio()
        if socketio:
            data = {'message_id': message_id, 'status': status}
            if error:
                data['error'] = error
            socketio.emit('download:status', data)
            web_app = get_web_app()
            if web_app:
                web_app.emit_stats()

    def emit_file_count(self, message_id, file_count):
        """A folder pull now knows how many files it holds - the list shows
        its per-file view from this, without waiting for a refetch."""
        from backend.web_app import get_socketio
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:files', {'message_id': message_id, 'file_count': file_count})

    def emit_new_download(self, download):
        from backend.web_app import get_socketio, get_web_app
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:new', download)
            web_app = get_web_app()
            if web_app:
                web_app.emit_stats()

    # --- Download ---------------------------------------------------------
    def start_download(self, remote_path: str, size: int = 0, dest: str = None) -> dict:
        """Create a download record and kick off the SFTP transfer in a thread.

        Works for both files and directories (directories are downloaded
        recursively, preserving structure). `dest` overrides the local
        destination base folder (else it's resolved from the 'vps' spec)."""
        db = get_db()
        remote_path = (remote_path or "").strip()
        if not remote_path:
            return {"error": "remote path is required"}
        existing = db.get_vps_downloads_for_path(remote_path)
        if existing:
            from backend.web_app.helpers import local_copy_exists
            if any(d.get("status") != "done" or local_copy_exists(d) for d in existing):
                return {"error": "This item is already downloaded"}
            # Pulled before, but the local copy has been deleted since: retire
            # the stale record(s) so the new pull is the only row for this path.
            # (autoSync never gets here - it skips any path with a live record,
            # so deleting a file locally doesn't make it come back on its own.)
            from backend.web_app import get_web_app
            web_app = get_web_app()
            for d in existing:
                db.delete_download_by_id(d["id"])
                if web_app:
                    web_app.emit_deleted(d.get("message_id"))

        message_id = generate_uuid()
        filename = posixpath.basename(remote_path.rstrip("/")) or remote_path
        # Applied up front so the transfer writes straight to the final name.
        from backend.rename import rename_for_download
        filename = rename_for_download(filename, 'vps')

        # Running, or waiting its turn in the download queue
        from backend.download_queue import admit
        new_download, started = admit('vps', lambda status, position: db.add_download(
            file=filename,
            status=status,
            progress=0,
            speed=0,
            error=None,
            downloaded_bytes=0,
            total_bytes=size or 0,
            pending_time=None,
            message_id=message_id,
            downloaded_from='vps',
            url=remote_path,
            author=None,
            # Remembered so a resume lands in the same folder as the partial
            # file: `dest` (a torrent client's local folder) can't be derived
            # from the 'vps' spec later on. A queued pull is started through
            # resume too, so it depends on this as well.
            dest_base=dest,
            queue_position=position,
        ))
        self.emit_new_download(new_download)
        if started:
            metrics.record_download_started('vps')
            self._spawn(remote_path, message_id, dest)
        elif not size:
            # Waiting with no size (a folder - the browser lists no recursive
            # size): measure it now, so the header's "to download" total and
            # ETA count it before its turn comes.
            threading.Thread(target=self._measure_waiting,
                             args=(message_id, remote_path), daemon=True).start()
        return new_download

    def _measure_waiting(self, message_id: str, remote_path: str):
        """Fill in total_bytes for a waiting pull that arrived without one.

        Only while it is still waiting with no size: once the transfer starts
        its own plan sets the real figure, and that must not be overwritten.
        """
        try:
            from backend.remote_files import dir_size
            size = int(dir_size(remote_path).get('size') or 0)
        except Exception as e:
            logger.debug("Could not size waiting VPS pull %s: %s", remote_path, e)
            return
        if size <= 0:
            return
        db = get_db()
        dl = db.get_download_by_message_id(message_id)
        if not dl or dl.get('status') != 'waiting' or (dl.get('total_bytes') or 0):
            return
        db.update_download_by_message_id(message_id, total_bytes=size)
        self.emit_progress(message_id, 0, dl.get('downloaded_bytes') or 0, size, 0, None)

    def resume_download(self, message_id: str) -> bool:
        """Resume a stopped/failed VPS download from where it left off,
        reusing the same record (no restart from zero)."""
        db = get_db()
        dl = db.get_download_by_message_id(message_id)
        if not dl or dl.get('downloaded_from') != 'vps' or not dl.get('url'):
            return False
        # Already running?
        existing = self.threads.get(message_id)
        if existing and existing.is_alive():
            return True
        self.cancelled.discard(message_id)
        db.update_download_by_message_id(message_id, status='downloading', speed=0, error=None)
        self.emit_status(message_id, 'downloading')
        self._spawn(dl['url'], message_id, dl.get('dest_base'))
        return True

    def _spawn(self, remote_path: str, message_id: str, dest: str = None):
        thread = threading.Thread(
            target=self._download, args=(remote_path, message_id, dest), daemon=True
        )
        self.threads[message_id] = thread
        self.download_tasks[message_id] = thread
        thread.start()

    def _local_destination(self, remote_path: str, base: Path = None, strip_prefix: str = None,
                           local_name: str = None) -> Path:
        """Map a remote file to its local path under `base` (default DOWNLOAD_DIR/VPS).

        `strip_prefix` is the remote directory the download was rooted at; the file
        is placed relative to it, so the requested item's parent dirs are not
        recreated locally (e.g. /home/user/xyz under destination a/b/c → a/b/c/xyz, not
        a/b/c/home/user/xyz). Without it, the full remote path is mirrored.

        `local_name` renames the *top-level* item the download was rooted at -
        the file itself for a single-file pull, or the containing folder for a
        directory pull (so `Season 1/ep01.mkv` becomes `Show S01/ep01.mkv`, not
        `Season 1/Show S01`). The local name is otherwise taken from the remote
        path, so a rename rule would be silently undone here.
        """
        if strip_prefix:
            rel = posixpath.relpath(remote_path, strip_prefix)
        else:
            rel = remote_path.lstrip("/")
        if local_name:
            parts = rel.split('/')
            parts[0] = local_name
            rel = '/'.join(parts)
        return (base or (DOWNLOAD_DIR / "VPS")) / rel

    def _walk(self, sftp, root, out):
        """Recursively collect (remote_file, size) tuples under a directory."""
        for attr in sftp.listdir_attr(root):
            if attr.filename in (".", ".."):
                continue
            full = posixpath.join(root, attr.filename)
            if stat_module.S_ISDIR(attr.st_mode):
                self._walk(sftp, full, out)
            else:
                out.append((full, attr.st_size or 0))

    def _plan(self, sftp, remote_path: str, message_id: str, dest: str = None) -> dict:
        """Work out what a pull of `remote_path` consists of: every remote file
        with its size and the local path it lands at. Shared by the transfer
        itself and the per-file view, so the two can't disagree about where a
        file goes. -> {files: [(remote, size, local)], is_dir, src}"""
        from backend.utils import resolve_spec, spec_folder
        db = get_db()
        # Destination base: an explicit `dest` (e.g. a torrent client's
        # configured local folder), else the watched folder's destination
        # (or the 'vps' source mapping), else DOWNLOAD_DIR/VPS
        if dest:
            base = Path(dest)
        else:
            spec = resolve_spec('vps', path=remote_path)
            base = spec_folder(spec, DOWNLOAD_DIR / "VPS")

        # Place files relative to the requested item's parent dir, so a file
        # /home/user/xyz lands at <base>/xyz and a folder /home/user/dir at
        # <base>/dir/... — not under the full remote path.
        strip_prefix = posixpath.dirname(remote_path.rstrip("/"))

        # `src` is where the bytes are read from. A file pulled from a torrent
        # that hasn't finished is recorded by its final path but still sits
        # in the client's temp dir - so on "no such file", look there.
        src = remote_path
        try:
            st = sftp.stat(remote_path)
        except FileNotFoundError:
            from backend.web_app.torrent import locate_torrent_file
            src = locate_torrent_file(remote_path, sftp)
            if not src:
                raise
            st = sftp.stat(src)
            strip_prefix = posixpath.dirname(src.rstrip("/"))
        is_dir = stat_module.S_ISDIR(st.st_mode)

        # The record's name already carries any rewrite from start_download;
        # honour it for single files (a directory pull keeps its tree, and
        # the rule applies to the top-level folder name).
        record = db.get_download_by_message_id(message_id) or {}
        local_name = record.get('file') or None
        if local_name == posixpath.basename(remote_path.rstrip('/')):
            local_name = None

        remote_files = []  # (remote_file, size)
        if is_dir:
            self._walk(sftp, src, remote_files)
        else:
            remote_files.append((src, st.st_size or 0))
        files = [(rfile, rsize, self._local_destination(rfile, base, strip_prefix, local_name))
                 for rfile, rsize in remote_files]
        if is_dir:
            # A file already pulled on its own carries its renamed name: count
            # that copy (and resume it) rather than fetch it again beside it.
            from backend.web_app.helpers import existing_variant
            files = [(rfile, rsize, existing_variant(lp)) for rfile, rsize, lp in files]
        root = self._local_destination(src, base, strip_prefix, local_name)
        return {'files': files, 'is_dir': is_dir, 'src': src, 'local_name': local_name, 'root': root}

    def file_listing(self, download: dict) -> dict:
        """Every file of a VPS pull with how far along it is locally - the
        per-file view of a folder (multi-file torrent) transfer.

        A running transfer answers from its own plan (no SFTP round trip, and
        it knows which file it is on). Otherwise the plan is rebuilt over the
        pooled SFTP session, so a stopped or failed pull still shows what is
        left. With the VPS unreachable - or the files gone from it - only the
        local side can be listed, and every file there reads as `on_disk`.

        -> {source: live|vps|local, is_dir, error?, files: [{path, size,
            local_size, state: done|downloading|partial|pending|paused|skipped|on_disk,
            local_path (set once the file is whole)}]}"""
        message_id = download.get('message_id')
        plan = self.plans.get(message_id)
        source, error = 'live', None
        if plan is None:
            source = 'vps'
            try:
                from backend.web_app.vps import vps_session
                with vps_session() as (_client, sftp):
                    plan = self._plan(sftp, download.get('url') or '', message_id, download.get('dest_base'))
                if plan['is_dir'] and download.get('file_count') != len(plan['files']):
                    get_db().update_download_by_message_id(message_id, file_count=len(plan['files']))
            except Exception as e:
                plan, error = None, str(e) or e.__class__.__name__
        if plan is None:
            return {'source': 'local', 'error': error, **self._local_listing(download)}

        running = source == 'live'
        current = plan.get('current') if running else None
        decided = dict(self.file_status.get(message_id) or download.get('file_status') or {})
        root = plan['root']
        out = []
        for _rfile, size, lp in plan['files']:
            try:
                local_size = lp.stat().st_size if lp.exists() else 0
            except OSError:
                local_size = 0
            rel = lp.relative_to(root).as_posix() if plan['is_dir'] else lp.name
            if lp.exists() and local_size >= size:
                state = 'done'
            elif decided.get(rel) in FILE_STATES:
                state = decided[rel]
            elif current is not None and lp == current:
                state = 'downloading'
            elif local_size > 0:
                state = 'partial'
            else:
                state = 'pending'
            # Where it is on the home server, once it's whole - the view button
            # streams it from there
            local_path = str(lp) if state == 'done' else None
            out.append({'path': rel, 'size': size, 'local_size': local_size, 'state': state,
                        'local_path': local_path})
        return {'source': source, 'error': None, 'is_dir': plan['is_dir'], 'files': out}

    def set_files_status(self, download: dict, paths, status) -> dict:
        """Mark files of a folder pull `paused` or `skipped`, or clear them
        (`status=None`) so they are fetched again. Saved on the record (so a
        resume, retry or queue start honours it) and, while the transfer runs,
        applied to it live: marking the file it is on stops that file there and
        moves on. -> {file_status, running}"""
        if status is not None and status not in FILE_STATES:
            raise ValueError(f"Unknown file status: {status}")
        message_id = download.get('message_id')
        paths = {p for p in (paths or []) if isinstance(p, str) and p}
        current = dict(download.get('file_status') or {})
        for path in paths:
            if status is None:
                current.pop(path, None)
            else:
                current[path] = status
        get_db().update_download_by_message_id(
            message_id, file_status=json.dumps(current, sort_keys=True) if current else None)
        live = self.file_status.get(message_id)
        if live is not None:
            for path in paths:
                if status is None:
                    live.pop(path, None)
                else:
                    live[path] = status
        thread = self.threads.get(message_id)
        return {'file_status': current, 'running': bool(thread and thread.is_alive())}

    def remaining(self, download: dict):
        """What is left of a pull that isn't running, judged against the VPS:
        `('done', wanted_bytes)` when every file not skipped is here,
        `('paused', ...)` when every one still missing is paused, otherwise
        `(None, ...)` - also when the VPS side is out of reach."""
        listing = self.file_listing(download)
        if listing['source'] == 'local':
            return None, 0
        wanted = [f for f in listing['files'] if f['state'] != 'skipped']
        wanted_bytes = sum(f['size'] for f in wanted)
        unfinished = [f for f in wanted if f['state'] != 'done']
        if not unfinished:
            return 'done', wanted_bytes
        if all(f['state'] == 'paused' for f in unfinished):
            return 'paused', wanted_bytes
        return None, wanted_bytes

    def _local_listing(self, download: dict) -> dict:
        """What of a pull is on the home server, without the VPS to compare
        against: sizes are local, so nothing can be called partial."""
        from backend.web_app.helpers import candidate_file_paths
        name = download.get('file') or ''
        root = next((p for p in candidate_file_paths(download, name) if p.exists()), None) if name else None
        if root is None:
            return {'is_dir': bool(download.get('file_count')), 'files': []}
        if root.is_file():
            size = root.stat().st_size
            return {'is_dir': False, 'files': [
                {'path': root.name, 'size': size, 'local_size': size, 'state': 'on_disk',
                 'local_path': str(root)}]}
        files = []
        for dirpath, _dirs, names in os.walk(root):
            for n in sorted(names):
                p = Path(dirpath) / n
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                files.append({'path': p.relative_to(root).as_posix(), 'size': size,
                              'local_size': size, 'state': 'on_disk', 'local_path': str(p)})
        files.sort(key=lambda f: f['path'])
        return {'is_dir': True, 'files': files}

    def _download(self, remote_path: str, message_id: str, dest: str = None):
        db = get_db()
        start_time = datetime.now()
        client = None
        try:
            client, sftp = self._open_sftp()
            self.clients[message_id] = client
            plan = self._plan(sftp, remote_path, message_id, dest)
            is_dir, local_name = plan['is_dir'], plan['local_name']
            files = plan['files']  # (remote_file, size, local_path)
            plan['current'] = None
            self.plans[message_id] = plan
            root = plan['root']

            def rel(lp):
                return lp.relative_to(root).as_posix() if is_dir else lp.name

            # The same dict the file-status route edits while this runs
            record = db.get_download_by_message_id(message_id) or {}
            decided = self.file_status.setdefault(message_id, {})
            decided.update(record.get('file_status') or {})

            def flag(lp):
                return decided.get(rel(lp))

            def total():
                # Skipped files aren't part of what this pull has to fetch
                return sum(size for _r, size, lp in files if flag(lp) != 'skipped')

            total_bytes = total()
            if is_dir:
                db.update_download_by_message_id(message_id, file_count=len(files))
                self.emit_file_count(message_id, len(files))

            # Resume: count bytes already present locally. Files already whole
            # are skipped by _transfer_file; partial ones continue from their size.
            transferred = [0]
            counted = {}  # local path -> bytes of it already in `transferred`
            for rfile, rsize, lp in files:
                if lp.exists():
                    ls = lp.stat().st_size
                    counted[lp] = min(ls, rsize) if rsize else ls
                    if flag(lp) != 'skipped':
                        transferred[0] += counted[lp]

            state = {'last_update': 0.0, 'last_bytes': transferred[0], 'last_time': start_time.timestamp()}

            def bump(delta):
                transferred[0] += delta
                if message_id in self.cancelled:
                    raise _Cancelled()
                if decided.get(plan.get('current_rel')) in FILE_STATES:
                    raise _FileSkipped()
                now = time.time()
                if now - state['last_update'] < 1:
                    return
                total_bytes = total()  # moves when a file is skipped mid-run
                elapsed = now - state['last_time']
                speed = ((transferred[0] - state['last_bytes']) / elapsed / 1024) if elapsed > 0 else 0  # KB/s
                progress = (transferred[0] / total_bytes * 100) if total_bytes else 0
                pending_time = ((total_bytes - transferred[0]) / 1024 / speed) if speed > 0 else None
                state['last_update'] = now
                state['last_bytes'] = transferred[0]
                state['last_time'] = now
                db.update_download_by_message_id(
                    message_id, progress=progress, downloaded_bytes=transferred[0],
                    total_bytes=total_bytes, speed=speed, pending_time=pending_time,
                )
                self.emit_progress(message_id, progress, transferred[0], total_bytes, speed, pending_time)

            def complete(lp, rsize):
                try:
                    return lp.exists() and lp.stat().st_size >= rsize
                except OSError:
                    return False

            # Passes over the files: a paused one is skipped (mid-file too -
            # bump raises), and a file resumed after its turn went by is picked
            # up by the next pass. Bounded so a file that never completes
            # can't spin this forever.
            for _pass in range(len(files) + 1):
                for rfile, rsize, lp in files:
                    if message_id in self.cancelled:
                        raise _Cancelled()
                    if flag(lp) in FILE_STATES or complete(lp, rsize):
                        continue
                    plan['current'], plan['current_rel'] = lp, rel(lp)
                    lp.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        if self._claim(lp, message_id):
                            # Another transfer finished (or advanced) this file while we
                            # waited: count what it wrote, then fetch only what's left.
                            now_ls = lp.stat().st_size if lp.exists() else 0
                            now_ls = min(now_ls, rsize) if rsize else now_ls
                            if now_ls > counted.get(lp, 0):
                                bump(now_ls - counted.get(lp, 0))
                        self._transfer_file(sftp, rfile, lp, rsize, bump)
                        counted[lp] = rsize
                    except _FileSkipped:
                        counted[lp] = lp.stat().st_size if lp.exists() else 0
                        logger.info(f"[vps] File {flag(lp) or 'skipped'}, moving on: {rfile}")
                    finally:
                        self._release(lp, message_id)
                        plan['current'] = plan['current_rel'] = None
                if all(complete(lp, rsize) or flag(lp) in FILE_STATES for _r, rsize, lp in files):
                    break

            sftp.close()

            total_bytes = total()
            left = [lp for _r, rsize, lp in files if flag(lp) != 'skipped' and not complete(lp, rsize)]
            if left:
                # Files are still missing, so the pull isn't done. When every
                # one of them is paused that was the user's call, and the pull
                # itself reads as paused (never auto-resumed, like a paused
                # Telegram download); otherwise it stopped short and a retry
                # carries on.
                status = 'paused' if all(flag(lp) == 'paused' for lp in left) else 'stopped'
                have = sum(min(lp.stat().st_size, rsize) for _r, rsize, lp in files
                           if flag(lp) != 'skipped' and lp.exists())
                db.update_download_by_message_id(
                    message_id, status=status, speed=0, pending_time=None,
                    downloaded_bytes=have, total_bytes=total_bytes,
                    progress=(have / total_bytes * 100) if total_bytes else 0,
                )
                self.emit_status(message_id, status)
                metrics.record_download_stopped('vps')
                logger.info(f"[vps] Download {status} with {len(left)} file(s) left: {remote_path}")
                return

            db.update_download_by_message_id(
                message_id, status='done', progress=100, speed=0,
                pending_time=0, downloaded_bytes=total_bytes, total_bytes=total_bytes,
            )
            self.emit_status(message_id, 'done')
            metrics.record_download_completed('vps', total_bytes, (datetime.now() - start_time).total_seconds())
            logger.info(f"[vps] Download completed: {remote_path} ({len(files)} file(s))")

            if not is_dir and is_video_file(self._local_destination(remote_path, local_name=local_name).name) and self.loop:
                asyncio.run_coroutine_threadsafe(poll_and_extract_meta(message_id), self.loop)

        except _Cancelled:
            # Keep partial files so the download can resume later.
            logger.info(f"[vps] Download stopped (partial kept): {remote_path}")
            db.update_download_by_message_id(message_id, status='stopped', speed=0)
            self.emit_status(message_id, 'stopped')
            metrics.record_download_stopped('vps')
        except Exception as e:
            if message_id in self.cancelled:
                # stop_download() force-closed the connection mid-transfer;
                # report it as a stop, not a failure.
                logger.info(f"[vps] Download stopped (partial kept): {remote_path}")
                db.update_download_by_message_id(message_id, status='stopped', speed=0)
                self.emit_status(message_id, 'stopped')
                metrics.record_download_stopped('vps')
            else:
                # Keep partial files so a retry can resume.
                logger.error(f"[vps] Download error for {remote_path}: {e}")
                db.update_download_by_message_id(message_id, status='failed', speed=0, error=str(e))
                self.emit_status(message_id, 'failed', str(e))
                metrics.record_download_failed('vps', 'exception')
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass
            self.clients.pop(message_id, None)
            self.plans.pop(message_id, None)
            self.file_status.pop(message_id, None)
            self.cancelled.discard(message_id)
            self.threads.pop(message_id, None)
            self.download_tasks.pop(message_id, None)

    def _claim(self, local: Path, message_id: str) -> bool:
        """Take the right to write `local`, waiting while another transfer
        holds it. Returns whether it had to wait. Raises _Cancelled if this
        download is stopped meanwhile."""
        key = str(local)
        waited = False
        while True:
            with self.writing_lock:
                owner = self.writing.get(key)
                if owner is None or owner == message_id or owner not in self.threads:
                    self.writing[key] = message_id
                    return waited
            if message_id in self.cancelled:
                raise _Cancelled()
            waited = True
            time.sleep(1)

    def _release(self, local: Path, message_id: str):
        with self.writing_lock:
            if self.writing.get(str(local)) == message_id:
                self.writing.pop(str(local), None)

    def _transfer_file(self, sftp, remote, local: Path, rsize: int, bump):
        """Copy a remote file to local, resuming from the local file's size.

        Reads concurrent ranged requests in bounded batches (see
        TRANSFER_CHUNK/TRANSFER_BATCH) so memory stays flat regardless of
        file size, for both fresh and resumed downloads."""
        start_offset = 0
        if local.exists():
            ls = local.stat().st_size
            if rsize and ls >= rsize:
                return  # already complete
            start_offset = ls
        if not rsize:
            rsize = sftp.stat(remote).st_size or 0

        rf = sftp.open(remote, 'rb')
        try:
            with open(local, 'ab' if start_offset else 'wb') as lf:
                if rsize:
                    offsets = range(start_offset, rsize, TRANSFER_CHUNK)
                    for i in range(0, len(offsets), TRANSFER_BATCH):
                        batch = [(off, min(TRANSFER_CHUNK, rsize - off))
                                 for off in offsets[i:i + TRANSFER_BATCH]]
                        for data in rf.readv(batch):
                            lf.write(data)
                            bump(len(data))  # raises _Cancelled if stopped
                else:
                    # Size unknown: plain sequential reads until EOF
                    rf.seek(start_offset)
                    while True:
                        data = rf.read(TRANSFER_CHUNK)
                        if not data:
                            break
                        lf.write(data)
                        bump(len(data))
        finally:
            rf.close()

    def stop_download(self, message_id: str, timeout: float = 15.0) -> bool:
        """Stop an in-flight VPS download and wait until the transfer thread
        has actually exited (partial files are kept for resume).

        The thread normally aborts at its next progress callback; if it is
        stuck in a blocking SFTP call (stalled connection, long directory
        walk), its SSH connection is force-closed to unblock it.
        Returns True once the download is no longer running."""
        thread = self.threads.get(message_id)
        if not thread or not thread.is_alive():
            self.cancelled.discard(message_id)
            return True
        self.cancelled.add(message_id)
        thread.join(2.0)
        if thread.is_alive():
            client = self.clients.get(message_id)
            if client:
                try:
                    client.close()  # aborts blocking SFTP I/O in the transfer thread
                except Exception:
                    pass
            thread.join(timeout)
        return not thread.is_alive()

    # --- Remote delete ----------------------------------------------------
    def _rmtree(self, sftp, path):
        """Recursively delete a remote directory over SFTP."""
        for attr in sftp.listdir_attr(path):
            if attr.filename in (".", ".."):
                continue
            full = posixpath.join(path, attr.filename)
            if stat_module.S_ISDIR(attr.st_mode):
                self._rmtree(sftp, full)
            else:
                sftp.remove(full)
        sftp.rmdir(path)

    def delete_remote(self, remote_path: str):
        """Permanently delete a file or directory on the VPS over SFTP."""
        remote_path = (remote_path or "").strip()
        if not remote_path:
            raise ValueError("remote path is required")
        client, sftp = self._open_sftp()
        try:
            st = sftp.stat(remote_path)
            if stat_module.S_ISDIR(st.st_mode):
                self._rmtree(sftp, remote_path)
            else:
                sftp.remove(remote_path)
            logger.info(f"[vps] Deleted remote path: {remote_path}")
        finally:
            try:
                sftp.close()
            finally:
                client.close()

    # --- autoSync ---------------------------------------------------------
    def snapshot_folder(self, path: str):
        """Record the current files in a folder as baseline (called when autoSync is enabled)."""
        try:
            client, sftp = self._open_sftp()
            try:
                names = self._list_files(sftp, path)
            finally:
                sftp.close()
                client.close()
            with self._seen_lock:
                self._seen[path] = set(names)
            logger.info(f"[vps] autoSync baseline for {path}: {len(names)} file(s)")
        except Exception as e:
            logger.error(f"[vps] Failed to snapshot {path}: {e}")

    def forget_folder(self, path: str):
        with self._seen_lock:
            self._seen.pop(path, None)

    def _list_files(self, sftp, path):
        """Return filenames (non-recursive, files only) in a remote folder."""
        names = []
        for attr in sftp.listdir_attr(path):
            if attr.filename in (".", ".."):
                continue
            if not stat_module.S_ISDIR(attr.st_mode):
                names.append(attr.filename)
        return names

    def start_autosync(self):
        """Start the hourly autoSync daemon thread."""
        thread = threading.Thread(target=self._sync_loop, daemon=True)
        thread.start()

    def _sync_loop(self):
        while True:
            time.sleep(SYNC_INTERVAL_SECONDS)
            try:
                self.sync_once()
            except Exception as e:
                logger.error(f"[vps] autoSync cycle failed: {e}")

    def sync_once(self):
        """Scan autoSync folders for the current connection; download new files."""
        from backend.web_app import load_vps_credentials
        db = get_db()
        creds = load_vps_credentials()
        if not creds:
            return
        folders = [
            f for f in db.get_vps_watch_folders()
            if f.get('auto_sync')
            and f.get('host') == creds['host']
            and f.get('username') == creds['username']
            and (f.get('port') or 22) == creds['port']
        ]
        if not folders:
            return
        client = None
        try:
            client, sftp = self._open_sftp()
            for folder in folders:
                path = folder['path']
                try:
                    names = self._list_files(sftp, path)
                except Exception as e:
                    logger.error(f"[vps] autoSync cannot list {path}: {e}")
                    continue
                with self._seen_lock:
                    first_sight = path not in self._seen
                    seen = self._seen.setdefault(path, set())
                    if first_sight:
                        # Establish baseline without downloading existing files
                        seen.update(names)
                        continue
                    new_names = [n for n in names if n not in seen]
                    seen.update(names)
                for name in new_names:
                    remote = posixpath.join(path, name)
                    if db.vps_download_exists(remote):
                        continue
                    try:
                        size = sftp.stat(remote).st_size
                    except Exception:
                        size = 0
                    logger.info(f"[vps] autoSync downloading new file: {remote}")
                    self.start_download(remote, size)
        except Exception as e:
            logger.error(f"[vps] autoSync connection failed: {e}")
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass

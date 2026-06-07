"""
VPS (SSH/SFTP) download handler.

Downloads files from a remote VPS to the local DOWNLOAD_DIR over SFTP, mirroring
the source folder structure under DOWNLOAD_DIR/VPS. paramiko is synchronous, so
each download runs in its own daemon thread (not the asyncio loop).

Also runs an hourly autoSync scheduler that watches folders flagged auto_sync and
auto-downloads files that appear after sync was enabled.
"""
import os
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


class _Cancelled(Exception):
    """Raised inside the SFTP progress callback to abort a download."""


class VpsDownloader:
    def __init__(self, download_tasks, loop=None):
        self.download_tasks = download_tasks
        self.loop = loop
        self.threads = {}      # message_id -> threading.Thread
        self.cancelled = set()  # message_ids requested to stop
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

    def emit_new_download(self, download):
        from backend.web_app import get_socketio, get_web_app
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:new', download)
            web_app = get_web_app()
            if web_app:
                web_app.emit_stats()

    # --- Download ---------------------------------------------------------
    def start_download(self, remote_path: str, size: int = 0) -> dict:
        """Create a download record and kick off the SFTP transfer in a thread."""
        db = get_db()
        remote_path = (remote_path or "").strip()
        if not remote_path:
            return {"error": "remote path is required"}
        if db.vps_download_exists(remote_path):
            return {"error": "This file is already downloaded"}

        message_id = generate_uuid()
        filename = posixpath.basename(remote_path.rstrip("/")) or remote_path

        new_download = db.add_download(
            file=filename,
            status='downloading',
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
        )
        metrics.record_download_started('vps')
        self.emit_new_download(new_download)

        thread = threading.Thread(
            target=self._download, args=(remote_path, message_id), daemon=True
        )
        self.threads[message_id] = thread
        self.download_tasks[message_id] = thread
        thread.start()
        return new_download

    def _local_destination(self, remote_path: str) -> Path:
        """Mirror the remote folder structure under DOWNLOAD_DIR/VPS."""
        rel = remote_path.lstrip("/")
        return DOWNLOAD_DIR / "VPS" / rel

    def _download(self, remote_path: str, message_id: str):
        db = get_db()
        start_time = datetime.now()
        client = None
        local_path = self._local_destination(remote_path)
        try:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            client, sftp = self._open_sftp()

            # Resolve total size (use stat if not known)
            try:
                total_bytes = sftp.stat(remote_path).st_size
            except Exception:
                total_bytes = 0

            last_update = [0.0]
            last_bytes = [0]
            last_time = [start_time.timestamp()]

            def callback(transferred, total):
                if message_id in self.cancelled:
                    raise _Cancelled()
                now = time.time()
                if now - last_update[0] < 1:
                    return
                elapsed = now - last_time[0]
                speed = ((transferred - last_bytes[0]) / elapsed / 1024) if elapsed > 0 else 0  # KB/s
                tot = total or total_bytes
                progress = (transferred / tot * 100) if tot else 0
                pending_time = ((tot - transferred) / 1024 / speed) if speed > 0 else None
                last_update[0] = now
                last_bytes[0] = transferred
                last_time[0] = now
                db.update_download_by_message_id(
                    message_id, progress=progress, downloaded_bytes=transferred,
                    total_bytes=tot, speed=speed, pending_time=pending_time,
                )
                self.emit_progress(message_id, progress, transferred, tot, speed, pending_time)

            sftp.get(remote_path, str(local_path), callback=callback)
            sftp.close()

            final_size = local_path.stat().st_size if local_path.exists() else (total_bytes or 0)
            db.update_download_by_message_id(
                message_id, status='done', progress=100, speed=0,
                pending_time=0, downloaded_bytes=final_size, total_bytes=final_size,
            )
            self.emit_status(message_id, 'done')
            metrics.record_download_completed('vps', final_size, (datetime.now() - start_time).total_seconds())
            logger.info(f"[vps] Download completed: {remote_path}")

            if is_video_file(local_path.name) and self.loop:
                asyncio.run_coroutine_threadsafe(poll_and_extract_meta(message_id), self.loop)

        except _Cancelled:
            logger.info(f"[vps] Download cancelled: {remote_path}")
            self._cleanup_partial(local_path)
            db.update_download_by_message_id(message_id, status='stopped', speed=0)
            self.emit_status(message_id, 'stopped')
            metrics.record_download_stopped('vps')
        except Exception as e:
            logger.error(f"[vps] Download error for {remote_path}: {e}")
            self._cleanup_partial(local_path)
            db.update_download_by_message_id(message_id, status='failed', speed=0, error=str(e))
            self.emit_status(message_id, 'failed', str(e))
            metrics.record_download_failed('vps', 'exception')
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass
            self.cancelled.discard(message_id)
            self.threads.pop(message_id, None)
            self.download_tasks.pop(message_id, None)

    def _cleanup_partial(self, local_path: Path):
        try:
            if local_path.exists():
                local_path.unlink()
        except Exception:
            pass

    def stop_download(self, message_id: str):
        """Request cancellation of an in-flight VPS download."""
        self.cancelled.add(message_id)

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

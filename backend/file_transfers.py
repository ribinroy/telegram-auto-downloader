"""Background copy/move jobs for the file explorer.

A paste used to be one blocking request: the browser showed a spinner and
nothing else for however long 40 GB took to cross between disks, and a closed
tab gave no way back to it. Each paste is now a TransferJob running on its own
daemon thread. The route waits a moment (so a small paste still feels instant)
and otherwise hands back the job, which the explorer polls for progress.

Jobs live in memory only. A copy is not resumable across a restart anyway -
the thread doing it is gone - and the partial target it leaves is an ordinary
file the user can see and delete.
"""
import os
import shutil
import threading
import time
import uuid
from collections import deque

from backend import files as fs

CHUNK = 4 * 1024 * 1024
# Finished jobs stay listed this long, so the details modal can still say what
# happened after the fact ("2 failed: permission denied").
KEEP_FINISHED_SECONDS = 600
SPEED_WINDOW = 3.0
ACTIVE = ('preparing', 'running')

_jobs = {}
_lock = threading.Lock()


class TransferJob:
    def __init__(self, paths, dest, move):
        self.id = uuid.uuid4().hex[:12]
        self.paths = list(paths)
        self.dest = str(dest)
        self.move = bool(move)
        self.status = 'preparing'
        self.total_bytes = 0
        self.done_bytes = 0
        self.total_files = 0
        self.done_files = 0
        self.items_total = len(self.paths)
        self.items_done = 0
        self.current_item = None
        self.current_file = None
        self.current_file_size = 0
        self.current_file_done = 0
        self.results = []
        self.error = None
        self.started_at = time.time()
        self.finished_at = None
        # Whether a page has shown the outcome yet. A job that finishes while
        # no tab is open (or mid-reload) stays unacknowledged, so the explorer
        # still surfaces it on its next load instead of it finishing silently.
        self.acknowledged = False
        self._cancel = threading.Event()
        self._finished = threading.Event()
        self._samples = deque()
        self._mu = threading.Lock()

    # --- called from the copy ---------------------------------------------

    def cancelled(self):
        return self._cancel.is_set()

    def begin_item(self, source):
        if self._cancel.is_set():
            raise fs.TransferCancelled()
        with self._mu:
            if self.current_item is not None:
                self.items_done += 1
            self.current_item = str(source)

    def copy_file(self, src, dst, *, follow_symlinks=True):
        """shutil.copy2 with a byte counter and a cancel check per chunk."""
        if self._cancel.is_set():
            raise fs.TransferCancelled()
        if not follow_symlinks and os.path.islink(src):
            os.symlink(os.readlink(src), dst)
            self._file_done(0)
            return dst
        if os.path.isdir(dst):
            dst = os.path.join(dst, os.path.basename(src))
        size = os.path.getsize(src)
        with self._mu:
            self.current_file = str(src)
            self.current_file_size = size
            self.current_file_done = 0
        with open(src, 'rb') as fin, open(dst, 'wb') as fout:
            while True:
                if self._cancel.is_set():
                    raise fs.TransferCancelled()
                chunk = fin.read(CHUNK)
                if not chunk:
                    break
                fout.write(chunk)
                self._add_bytes(len(chunk))
        shutil.copystat(src, dst)
        self._file_done(size)
        return dst

    def _add_bytes(self, n):
        now = time.monotonic()
        with self._mu:
            self.done_bytes += n
            self.current_file_done += n
            self._samples.append((now, self.done_bytes))
            while self._samples and now - self._samples[0][0] > SPEED_WINDOW:
                self._samples.popleft()

    def _file_done(self, _size):
        with self._mu:
            self.done_files += 1

    # --- control -----------------------------------------------------------

    def cancel(self):
        self._cancel.set()

    def wait(self, timeout):
        return self._finished.wait(timeout)

    @property
    def finished(self):
        return self._finished.is_set()

    def run(self):
        try:
            dest = fs.transfer_dest(self.dest)
            total_bytes, total_files = fs.transfer_plan(
                self.paths, dest, self.move, cancelled=self.cancelled)
            with self._mu:
                self.total_bytes, self.total_files = total_bytes, total_files
                self.status = 'running'
            self.results = fs.transfer(self.paths, self.dest, move=self.move, job=self)
            if self._cancel.is_set() or any(r.get('cancelled') for r in self.results):
                self.status = 'cancelled'
            elif any(r.get('error') for r in self.results):
                # Partly done is still "failed" for the badge; results say which.
                self.status = 'failed' if all(r.get('error') for r in self.results) else 'partial'
            else:
                self.status = 'done'
        except fs.TransferCancelled:
            self.status = 'cancelled'
        except fs.FsError as e:
            self.status, self.error = 'failed', e.message
        except Exception as e:  # never leave a job "running" with no thread behind it
            self.status, self.error = 'failed', str(e)
        finally:
            with self._mu:
                if self.current_item is not None and self.status != 'cancelled':
                    self.items_done = self.items_total
                self.current_file = None
            self.finished_at = time.time()
            self._finished.set()

    # --- view ----------------------------------------------------------------

    def speed(self):
        """Bytes/s over the last few seconds; 0 once nothing has moved lately."""
        with self._mu:
            if len(self._samples) < 2 or time.monotonic() - self._samples[-1][0] > SPEED_WINDOW:
                return 0
            (t0, b0), (t1, b1) = self._samples[0], self._samples[-1]
            return (b1 - b0) / (t1 - t0) if t1 > t0 else 0

    def snapshot(self):
        speed = self.speed()
        with self._mu:
            remaining = max(self.total_bytes - self.done_bytes, 0)
            errors = [r for r in self.results if r.get('error') and not r.get('cancelled')]
            return {
                'id': self.id,
                'move': self.move,
                'paths': self.paths,
                'dest': self.dest,
                'status': self.status,
                'total_bytes': self.total_bytes,
                'done_bytes': self.done_bytes,
                'total_files': self.total_files,
                'done_files': self.done_files,
                'items_total': self.items_total,
                'items_done': self.items_done,
                'current_item': self.current_item,
                'current_file': self.current_file,
                'current_file_size': self.current_file_size,
                'current_file_done': self.current_file_done,
                'speed': round(speed),
                'eta': round(remaining / speed) if speed > 0 and self.status == 'running' else None,
                'started_at': self.started_at,
                'finished_at': self.finished_at,
                'results': [r for r in self.results if not r.get('error')],
                'errors': errors,
                'error': self.error,
                'acknowledged': self.acknowledged,
            }


def start(paths, dest, move=False):
    """Validate the destination (FsError on a bad one, so the route can 400
    before any thread exists) and start the job."""
    fs.transfer_dest(dest)
    job = TransferJob(paths, dest, move)
    with _lock:
        _prune()
        _jobs[job.id] = job
    threading.Thread(target=job.run, name=f'file-transfer-{job.id}', daemon=True).start()
    return job


def _prune():
    cutoff = time.time() - KEEP_FINISHED_SECONDS
    for jid in [j.id for j in _jobs.values() if j.finished_at and j.finished_at < cutoff]:
        _jobs.pop(jid, None)


def get(job_id):
    with _lock:
        return _jobs.get(job_id)


def list_jobs():
    """Running first, then finished, newest first within each."""
    with _lock:
        _prune()
        jobs = list(_jobs.values())
    jobs.sort(key=lambda j: (j.finished, -j.started_at))
    return [j.snapshot() for j in jobs]


def dismiss(job_id):
    """Forget a finished job. A running one has to be cancelled first."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return False
        if not job.finished:
            raise fs.FsError('Cancel the transfer before dismissing it', 409)
        _jobs.pop(job_id, None)
        return True


def acknowledge(job_ids):
    """Mark finished jobs' outcomes as seen. Running ones are left alone -
    there is nothing to acknowledge until they end."""
    n = 0
    with _lock:
        for jid in job_ids or []:
            job = _jobs.get(jid)
            if job is not None and job.finished and not job.acknowledged:
                job.acknowledged = True
                n += 1
    return n


def clear():
    with _lock:
        _jobs.clear()

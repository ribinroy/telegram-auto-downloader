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
# Per-file states are kept for this many files. Past it the job still counts
# every byte and file; only the listing stops growing (and says so).
MAX_TRACKED_FILES = 20000
FILE_STATES = ('pending', 'copying', 'paused', 'done', 'failed', 'skipped', 'cancelled')
# 'paused': only paused files are left, and the job waits for them.
ACTIVE = ('preparing', 'running', 'paused')

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
        # The plan, one dict per file (state, error), plus a lookup by source
        # path - the path copytree/shutil.move hand to copy_file.
        self._files = []
        self._by_path = {}
        self.files_truncated = False
        self._item_index = -1
        # Per-file pause. A paused file is set aside (bytes kept) instead of
        # holding up the rest; once resumed, the second pass (_drain) picks it
        # up where it stopped. The job only finishes when nothing is set aside.
        self._paused = set()
        self._deferred = {}      # src -> {'dst', 'item'}
        self._sources = {}       # item -> source of a cross-disk move, deleted once complete
        self._item_failed = set()
        self._wake = threading.Condition(self._mu)

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
            self._item_index += 1

    def end_item(self, error=None, cancelled=False):
        """Settle the current item's files once transfer() is done with it."""
        with self._mu:
            if error or cancelled:
                self._item_failed.add(self._item_index)
            for f in self._files:
                if f['item'] != self._item_index:
                    continue
                if cancelled:
                    # The partial target is removed, files already copied included
                    if f['state'] != 'failed':
                        f['state'] = 'cancelled'
                elif f['state'] == 'pending' and f['path'] not in self._deferred:
                    if f['rename'] and error is None:
                        f['state'] = 'done'
                    else:
                        f['state'] = 'skipped'
                        if error:
                            f['error'] = error

    def _set_file(self, src, state, error=None):
        f = self._by_path.get(str(src))
        if f is not None:
            f['state'] = state
            if error:
                f['error'] = error

    def copy_file(self, src, dst, *, follow_symlinks=True):
        """shutil.copy2 with a byte counter, a cancel check and a pause check
        per chunk. A paused file returns as if copied - copytree moves on - and
        is left to the second pass."""
        if self._cancel.is_set():
            raise fs.TransferCancelled()
        if not follow_symlinks and os.path.islink(src):
            os.symlink(os.readlink(src), dst)
            self._file_done(0)
            return dst
        if os.path.isdir(dst):
            dst = os.path.join(dst, os.path.basename(src))
        src, dst = str(src), str(dst)
        with self._mu:
            if src in self._paused:
                self._defer(src, dst)
                return dst
        self._copy_from(src, dst, 0)
        return dst

    def _copy_from(self, src, dst, offset):
        """Copy src into dst from `offset` on. True when complete, False when
        the file was paused part-way (it is then set aside)."""
        size = os.path.getsize(src)
        with self._mu:
            self.current_file = src
            self.current_file_size = size
            self.current_file_done = offset
            self._set_file(src, 'copying')
        try:
            with open(src, 'rb') as fin, open(dst, 'ab' if offset else 'wb') as fout:
                if offset:
                    fin.seek(offset)
                while True:
                    if self._cancel.is_set():
                        raise fs.TransferCancelled()
                    if src in self._paused:
                        with self._mu:
                            self._defer(src, dst)
                        return False
                    chunk = fin.read(CHUNK)
                    if not chunk:
                        break
                    fout.write(chunk)
                    self._add_bytes(len(chunk))
            shutil.copystat(src, dst)
        except OSError as e:
            # copytree notes this one down and carries on with the next file
            with self._mu:
                self._set_file(src, 'failed', e.strerror or str(e))
            raise
        with self._mu:
            self._deferred.pop(src, None)
            self._set_file(src, 'done')
            if self.current_file == src:
                self.current_file = None
        self._file_done(size)
        return True

    def _defer(self, src, dst):
        """(lock held) Set a paused file aside for the second pass."""
        entry = self._deferred.get(src)
        item = entry['item'] if entry else self._item_index
        self._deferred[src] = {'dst': dst, 'item': item}
        self._set_file(src, 'paused')
        if self.current_file == src:
            self.current_file = None

    def release_source(self, source):
        """A cross-disk move's copy has run: delete the source now, or - with
        files of it still set aside - once the second pass has them."""
        with self._mu:
            item = self._item_index
            if any(d['item'] == item for d in self._deferred.values()):
                self._sources[item] = str(source)
                return
        fs.remove_source(source)

    def set_paused(self, paths, paused):
        """Pause or resume files of this job. Returns how many changed.
        A file being copied stops within one chunk, its bytes kept."""
        changed = 0
        with self._mu:
            if self.finished:
                return 0
            for p in paths or []:
                f = self._by_path.get(p)
                if f is None or f['rename']:
                    continue
                if paused and f['state'] in ('pending', 'copying'):
                    self._paused.add(p)
                    if f['state'] == 'pending':
                        f['state'] = 'paused'
                    changed += 1
                elif not paused and f['state'] == 'paused':
                    self._paused.discard(p)
                    f['state'] = 'pending'
                    changed += 1
            self._wake.notify_all()
        return changed

    def _drain(self):
        """Second pass: copy set-aside files as they are resumed, waiting
        (status 'paused') while every one left is paused. A cancel discards
        their partial copies."""
        while True:
            with self._mu:
                while not self._cancel.is_set():
                    ready = [p for p in self._deferred if p not in self._paused]
                    if ready or not self._deferred:
                        break
                    self.status = 'paused'
                    self._wake.wait(1.0)
                if self._cancel.is_set() or not self._deferred:
                    break
                self.status = 'running'
                src = ready[0]
                entry = self._deferred[src]
            dst, item = entry['dst'], entry['item']
            try:
                offset = os.path.getsize(dst) if os.path.exists(dst) else 0
                if not self._copy_from(src, dst, offset):
                    continue
            except fs.TransferCancelled:
                break
            except OSError as e:
                with self._mu:
                    self._deferred.pop(src, None)
                    self._set_file(src, 'failed', e.strerror or str(e))
                    self._item_failed.add(item)
                    self.results.append({'path': src, 'error': e.strerror or str(e)})
            self._release_if_complete(item)

        if self._cancel.is_set():
            with self._mu:
                left = list(self._deferred.items())
                self._deferred.clear()
                for src, _entry in left:
                    self._set_file(src, 'cancelled')
                if left and not any(r.get('cancelled') for r in self.results):
                    self.results.append({'path': left[0][0], 'error': 'Cancelled', 'cancelled': True})
            for _src, entry in left:
                try:
                    os.unlink(entry['dst'])
                except OSError:
                    pass
        with self._mu:
            self.status = 'running'

    def _release_if_complete(self, item):
        with self._mu:
            source = self._sources.get(item)
            if source is None or any(d['item'] == item for d in self._deferred.values()):
                return
            self._sources.pop(item)
            if item in self._item_failed:
                return      # a file of it failed: keep the source, like shutil.move would
        try:
            fs.remove_source(source)
        except OSError as e:
            with self._mu:
                self.results.append({'path': source, 'error': f"Copied, but the source couldn't be removed: {e}"})

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
        with self._mu:
            self._cancel.set()
            self._wake.notify_all()

    def wait(self, timeout):
        return self._finished.wait(timeout)

    @property
    def finished(self):
        return self._finished.is_set()

    def run(self):
        try:
            dest = fs.transfer_dest(self.dest)
            plan = fs.transfer_plan(self.paths, dest, self.move, cancelled=self.cancelled)
            with self._mu:
                copies = [e for e in plan if not e['rename']]
                self.total_bytes = sum(e['size'] for e in copies)
                self.total_files = len(copies)
                self._files = [dict(e, state='pending') for e in plan[:MAX_TRACKED_FILES]]
                self._by_path = {f['path']: f for f in self._files}
                self.files_truncated = len(plan) > MAX_TRACKED_FILES
                self.status = 'running'
            self.results = fs.transfer(self.paths, self.dest, move=self.move, job=self)
            self._drain()
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
                # Never reached: an item that failed early, or everything after
                # a cancel.
                for f in self._files:
                    if f['state'] in ('pending', 'copying', 'paused'):
                        f['state'] = 'skipped'
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

    def file_listing(self):
        """The planned files and how far each got, in plan order."""
        with self._mu:
            counts = dict.fromkeys(FILE_STATES, 0)
            files = []
            for f in self._files:
                counts[f['state']] += 1
                row = {'path': f['path'], 'rel': f['rel'], 'size': f['size'],
                       'state': f['state'], 'rename': f['rename']}
                if f.get('error'):
                    row['error'] = f['error']
                if f['state'] == 'copying':
                    row['done'] = self.current_file_done
                files.append(row)
            return {'id': self.id, 'status': self.status, 'files': files,
                    'counts': counts, 'truncated': self.files_truncated}

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

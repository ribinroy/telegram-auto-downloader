"""Download queue: how many local downloads run at once, and who goes next.

A home line split twenty ways finishes nothing quickly, so local downloads
(Telegram, yt-dlp and VPS->home SFTP pulls - not torrents, which run on the
VPS) are capped. A download that arrives while every slot is taken is created
with status ``waiting`` and a ``queue_position``; when a slot frees, the first
waiting download that fits starts.

There is no queue table. The queue *is* the waiting rows of ``downloads``,
ordered by ``queue_position``, so it cannot drift from the downloads it
describes: anything that moves a row out of ``waiting`` (start, stop, delete)
also clears its position (``_apply_download_update`` in the database layer).

- **Limits** are one global cap plus an optional cap per source
  (``download_limits`` setting). A slot is free when both have room, so a
  per-source cap that is full skips that source's waiting items rather than
  blocking the ones behind them.
- **Starting a waiting download is a resume.** ``backend/resume.py`` already
  knows how to start each handler's download from its record (Telegram
  re-fetches the message), so a queued download goes through the same code
  path as the retry button and the network watchdog.
- **Admission happens under one lock** together with creating the record, so
  two downloads arriving at once can't both see the last free slot.
- The ``QueueRunner`` thread starts waiting downloads as slots free. It ticks
  every few seconds (a download can finish in any of a dozen places in three
  handlers, and polling the database is simpler than hooking all of them), and
  ``kick()`` wakes it at once after anything that obviously frees a slot.
- Lowering a limit never stops a running download; it only holds back the
  next ones.
"""
import json
import logging
import threading

from backend.database import get_db

logger = logging.getLogger(__name__)

SETTINGS_KEY = 'download_limits'
SOURCES = ('telegram', 'ytdlp', 'vps')
DEFAULT_LIMITS = {'global': 3, 'telegram': None, 'ytdlp': None, 'vps': None}
MAX_LIMIT = 20
TICK_SECONDS = 3

_lock = threading.RLock()
_wake = threading.Event()


# --- limits ------------------------------------------------------------------

def get_limits():
    """{global: int, telegram/ytdlp/vps: int or None (no cap of its own)}."""
    limits = dict(DEFAULT_LIMITS)
    try:
        stored = json.loads(get_db().get_setting(SETTINGS_KEY) or '{}')
    except (TypeError, ValueError):
        stored = {}
    for key in limits:
        if key in stored:
            limits[key] = stored[key]
    return limits


def _clean_limit(value, allow_none):
    if value in (None, '') and allow_none:
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise ValueError('Limits must be whole numbers')
    if not 1 <= value <= MAX_LIMIT:
        raise ValueError(f'Limits must be between 1 and {MAX_LIMIT}')
    return value


def set_limits(changes):
    """Update some limits (a per-source None removes that cap). Raises
    ValueError on a bad value; returns the full limits."""
    limits = get_limits()
    for key, value in (changes or {}).items():
        if key not in limits:
            raise ValueError(f'Unknown limit: {key}')
        limits[key] = _clean_limit(value, allow_none=key != 'global')
    get_db().set_setting(SETTINGS_KEY, json.dumps(limits))
    kick()  # a raised limit frees slots right now
    _notify()
    return limits


# --- state -------------------------------------------------------------------

def source_of(download):
    from backend.resume import source_of as _source_of
    return _source_of(download)


def active_counts():
    """{total, telegram, ytdlp, vps}: downloads currently holding a slot."""
    counts = {s: 0 for s in SOURCES}
    for d in get_db().get_downloads_by_status('downloading'):
        counts[source_of(d)] += 1
    counts['total'] = sum(counts[s] for s in SOURCES)
    return counts


def _has_room(source, counts, limits):
    if counts['total'] >= limits['global']:
        return False
    cap = limits.get(source)
    return cap is None or counts[source] < cap


def _source_ready(source):
    """Whether that handler can start a download right now. A waiting
    Telegram download can't start before Telethon is connected; trying would
    only fail it, so the queue waits instead."""
    from backend.web_app import get_web_app
    web = get_web_app()
    if not web:
        return False
    if source == 'vps':
        return bool(web.vps_downloader)
    if source == 'ytdlp':
        return bool(web.ytdlp_downloader and web.event_loop)
    tg = web.telegram_downloader
    try:
        return bool(tg and tg.loop and tg.client and tg.client.is_connected())
    except Exception:  # noqa: BLE001 - a half-built client is just "not ready"
        return False


def snapshot():
    """The queue as the UI shows it: limits, what is running, who waits.

    Waiting downloads carry the computed `hidden` flag like the downloads
    list does, so the page can keep a secured source's filenames out of the
    queue panel unless secured items are being shown."""
    from backend.web_app import get_web_app
    db = get_db()
    order = db.get_queue_order()
    running = [d for d in order if d['status'] == 'downloading']
    waiting = [d for d in order if d['status'] == 'waiting']
    web = get_web_app()
    if web:
        waiting = web._annotate_downloads(waiting) if waiting else waiting
        running = web._annotate_downloads(running) if running else running
    return {
        'limits': get_limits(),
        'max_limit': MAX_LIMIT,
        'active': active_counts(),
        'running': running,
        'waiting': waiting,
        # What "resume all" would bring back
        'resumable': len(_resumable()),
    }


# --- admission ---------------------------------------------------------------

def admit(source, create):
    """Create a new download either running or queued.

    `create(status, queue_position)` makes the record and returns it; it runs
    under the queue lock, so the slot it was given can't be handed out twice.
    Returns (download, started): when `started` is False the caller must not
    start the transfer - the runner will, through resume, when it's this
    download's turn."""
    with _lock:
        limits = get_limits()
        counts = active_counts()
        # A newcomer doesn't jump a waiting download that could take this slot
        waiting_fits = any(
            _has_room(source_of(w), counts, limits) and _source_ready(source_of(w))
            for w in get_db().get_waiting_downloads())
        if _has_room(source, counts, limits) and not waiting_fits:
            # Running downloads hold a rank too, so a later reorder can put
            # a waiting one ahead of this one
            return create('downloading', get_db().next_queue_position()), True
        download = create('waiting', get_db().next_queue_position())
    _notify()
    return download, False


def admit_existing(download):
    """For a retry/resume of an existing record: 'start' if it may run now
    (its row is already marked downloading, so the slot is held), otherwise
    'queued' (the row is now waiting at the back of the line)."""
    db = get_db()
    message_id = download.get('message_id')
    with _lock:
        source = source_of(download)
        if _has_room(source, active_counts(), get_limits()):
            db.update_download_by_message_id(
                message_id, status='downloading', speed=0, error=None,
                queue_position=db.next_queue_position())
            return 'start'
        db.update_download_by_message_id(
            message_id, status='waiting', speed=0, error=None,
            queue_position=db.next_queue_position())
    _emit_status(message_id, 'waiting')
    _notify()
    return 'queued'


def _run_set(rows, limits):
    """Which of `rows` (in queue order) the limits let run: walk the order and
    take each one that still fits, as pump() does. Running downloads count as
    ready; a waiting one only if its handler can start it."""
    counts = {s: 0 for s in SOURCES}
    counts['total'] = 0
    chosen = set()
    for row in rows:
        source = source_of(row)
        ready = row['status'] == 'downloading' or _source_ready(source)
        if ready and _has_room(source, counts, limits):
            chosen.add(row['message_id'])
            counts[source] += 1
            counts['total'] += 1
    return chosen


def reorder(ordered_message_ids, requeue_one=None):
    """Set the order of the whole line - running downloads included - first
    to run first.

    Dragging a waiting download above a running one means "this one before
    that one": the running one goes back to waiting (bytes kept - every
    handler resumes) and the waiting one takes its slot. Only as many are
    bumped as waiting ones were promoted, lowest-ranked first, so a download
    started past the limit with "start now" isn't knocked out by an unrelated
    reorder. `requeue_one(message_id)` is the route's stop-and-requeue
    (returns an error or None)."""
    from concurrent.futures import ThreadPoolExecutor
    db = get_db()
    with _lock:
        rows = db.set_queue_positions(ordered_message_ids)
        run = _run_set(rows, get_limits())
        promoted = [r for r in rows if r['status'] == 'waiting' and r['message_id'] in run]
        outranked = [r for r in rows if r['status'] == 'downloading' and r['message_id'] not in run]
        bump = list(reversed(outranked))[:len(promoted)] if requeue_one else []
    errors = []
    if bump:
        with ThreadPoolExecutor(max_workers=min(8, len(bump))) as pool:
            results = list(pool.map(lambda r: (r, requeue_one(r['message_id'])), bump))
        errors = [{'message_id': r['message_id'], 'file': r['file'], 'error': e} for r, e in results if e]
    pump()  # fills the freed slots, in the new order
    _notify()
    return {**snapshot(), 'requeued': len(bump) - len(errors), 'errors': errors}


def start_now(message_id):
    """Start one waiting download immediately, past the limits. Returns
    (ok, error)."""
    db = get_db()
    with _lock:
        download = db.get_download_by_message_id(message_id)
        if not download or download.get('deleted_at'):
            return False, 'Download not found'
        if download.get('status') != 'waiting':
            return False, f"It is {download.get('status')}, not waiting"
        if not _source_ready(source_of(download)):
            return False, 'That downloader is not ready yet'
        _claim(download)
    _start(download)
    return True, None


def _resumable():
    """Stopped and paused downloads - decisions the user can undo in bulk.
    Failed ones are left out: a failure has a reason, and its own retry."""
    db = get_db()
    rows = db.get_downloads_by_status('stopped') + db.get_downloads_by_status('paused')
    return sorted(rows, key=lambda d: d.get('created_at') or '')


def stop_all(stop_one):
    """Stop every waiting and running download. `stop_one(message_id)` is the
    route's single-download stop (returns an error or None).

    The waiting line is emptied first, under the lock, so the runner can't
    start one of them in the gap left by the first running download stopping.
    Running ones are then stopped in parallel - a VPS stop waits for its
    transfer thread, and doing ten of those in a row would take minutes."""
    from concurrent.futures import ThreadPoolExecutor
    db = get_db()
    errors = []
    with _lock:
        waiting = db.get_waiting_downloads()
        for download in waiting:
            error = stop_one(download['message_id'])
            if error:
                errors.append({'message_id': download['message_id'], 'file': download['file'], 'error': error})
    running = db.get_downloads_by_status('downloading')
    if running:
        with ThreadPoolExecutor(max_workers=min(8, len(running))) as pool:
            results = list(pool.map(lambda d: (d, stop_one(d['message_id'])), running))
        errors += [{'message_id': d['message_id'], 'file': d['file'], 'error': e}
                   for d, e in results if e]
    _notify()
    return {'stopped': len(waiting) + len(running) - len(errors), 'errors': errors}


def resume_all():
    """Queue every stopped/paused download, oldest first; the runner then
    starts as many as the limits allow. Going through the queue rather than
    resuming them directly is the point - "resume all" on twenty downloads
    must not start twenty at once. Returns how many were queued."""
    db = get_db()
    with _lock:
        rows = _resumable()
        position = db.next_queue_position()
        for offset, download in enumerate(rows):
            db.update_download_by_message_id(
                download['message_id'], status='waiting', speed=0, error=None,
                queue_position=position + offset)
    for download in rows:
        _emit_status(download['message_id'], 'waiting')
    kick()
    _notify()
    return len(rows)


# --- running -----------------------------------------------------------------

def _claim(download):
    """Mark a waiting download as running (holding a slot) before its
    transfer starts, so the next admission already counts it."""
    get_db().update_download_by_message_id(
        download['message_id'], status='downloading', speed=0, error=None)
    _emit_status(download['message_id'], 'downloading')


def _start(download):
    """Start a claimed download on a worker thread (a Telegram start waits on
    a message fetch). If the handler refuses, fail it honestly rather than
    leaving a 'downloading' row with nothing behind it."""
    def run():
        from backend.resume import resume_download
        try:
            ok = resume_download(download, count_retry=False)
        except Exception as e:  # noqa: BLE001 - logged and recorded below
            logger.warning("queued download %s failed to start: %s", download.get('message_id'), e)
            ok = False
        if not ok:
            get_db().update_download_by_message_id(
                download['message_id'], status='failed', speed=0,
                error="Couldn't start this download from the queue")
            _emit_status(download['message_id'], 'failed')
        _notify()

    _run_in_background(run)


def _run_in_background(fn):
    threading.Thread(target=fn, daemon=True, name='queue-start').start()


def pump():
    """Start waiting downloads, in order, while slots are free. Returns how
    many were started."""
    started = []
    with _lock:
        limits = get_limits()
        counts = active_counts()
        for download in get_db().get_waiting_downloads():
            if counts['total'] >= limits['global']:
                break
            source = source_of(download)
            if not _has_room(source, counts, limits) or not _source_ready(source):
                continue  # skip it; something behind it may fit
            _claim(download)
            counts[source] += 1
            counts['total'] += 1
            started.append(download)
    for download in started:
        _start(download)
    if started:
        _notify()
    return len(started)


def kick():
    """Wake the runner now instead of on its next tick."""
    _wake.set()


class QueueRunner(threading.Thread):
    """Starts waiting downloads as slots free up."""

    def __init__(self, interval: int = TICK_SECONDS):
        super().__init__(daemon=True, name='download-queue')
        self.interval = interval

    def run(self):
        while True:
            try:
                pump()
            except Exception as e:  # a runner that dies silently strands the queue
                logger.error("download queue tick failed: %s", e)
            _wake.wait(self.interval)
            _wake.clear()


# --- notifications -----------------------------------------------------------

def _emit_status(message_id, status):
    from backend.web_app import get_web_app
    web = get_web_app()
    if web:
        try:
            web.emit_status(message_id, status)
        except Exception:  # noqa: BLE001 - a dropped event is resynced on reconnect
            pass


def _notify():
    """Tell open pages the queue changed; they refetch /api/queue."""
    from backend.web_app import get_socketio
    try:
        sio = get_socketio()
        if sio:
            sio.emit('queue:changed', {})
    except Exception:  # noqa: BLE001
        pass

"""Maintenance jobs and the scheduler that can run them unattended.

The job bodies live here rather than in the route so that the same code backs
both the "Run now" button and a scheduled run - a scheduled job that drifted
away from its manual counterpart would be the worst kind of bug to chase.

Schedules are one JSON blob in the settings table (`job_schedules`), keyed by
job id: a time of day, the weekdays it applies to, and the outcome of the last
run. The scheduler is a daemon thread that wakes every 30s; wall-clock time is
the server's local time.
"""
import json
import logging
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from backend.database import get_db

logger = logging.getLogger(__name__)

SETTINGS_KEY = 'job_schedules'
TICK_SECONDS = 30
# Monday=0 .. Sunday=6, matching datetime.weekday().
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]


# --------------------------------------------------------------------------
# Job bodies
# --------------------------------------------------------------------------

def run_sync_thumbnails():
    """Generate missing download thumbnails, clear orphans, fix DB counts, and
    prune the file explorer's thumbnail cache."""
    import asyncio as _asyncio
    from backend.config import SCREENSHOTS_DIR
    from backend.file_meta import (
        find_file, is_video_file, generate_thumbnails as gen_thumbs,
        probe_video, extract_meta,
    )
    from backend.files import prune_thumb_cache

    db = get_db()
    downloads = db.get_all_downloads()
    completed = [d for d in downloads if d['status'] == 'done' and not d.get('deleted_at')]

    stats = {
        'generated': 0,
        'skipped': 0,
        'orphan_deleted': 0,
        'db_count_fixed': 0,
        'meta_extracted': 0,
        'no_duration': 0,
        'not_video': 0,
        'failed': 0,
        # File-explorer thumbnail cache (filled in at the end)
        'explorer_pruned': 0,
        'explorer_kept': 0,
        'explorer_freed': 0,
    }

    loop = _asyncio.new_event_loop()
    try:
        for dl in completed:
            file_name = dl.get('file')
            if not file_name or not is_video_file(file_name):
                stats['not_video'] += 1
                continue

            dl_id = dl['id']
            thumb_dir = SCREENSHOTS_DIR / str(dl_id)
            has_thumbs = thumb_dir.exists() and any(thumb_dir.glob('*.jpg'))
            file_path = find_file(file_name, dl.get('downloaded_from'), dl.get('url'))

            # File missing, thumbnails exist -> delete orphans
            if not file_path and has_thumbs:
                shutil.rmtree(thumb_dir, ignore_errors=True)
                db.update_download_by_id(dl_id, thumb_count=0)
                stats['orphan_deleted'] += 1
                continue

            # File missing, no thumbnails -> skip
            if not file_path:
                continue

            # File exists, thumbnails exist -> sync DB count
            if has_thumbs:
                actual_count = len([f for f in thumb_dir.iterdir() if f.suffix == '.jpg'])
                if dl.get('thumb_count') != actual_count:
                    db.update_download_by_id(dl_id, thumb_count=actual_count)
                    stats['db_count_fixed'] += 1
                stats['skipped'] += 1
                continue

            # File exists, thumbnails missing -> generate
            duration = None
            file_meta = dl.get('file_meta')
            if file_meta:
                duration = file_meta.get('duration') if isinstance(file_meta, dict) else None

            if not duration:
                probe_data = loop.run_until_complete(probe_video(str(file_path)))
                if probe_data:
                    meta = extract_meta(probe_data)
                    if meta.get('video'):
                        db.update_download_by_id(dl_id, file_meta=json.dumps(meta))
                        duration = meta.get('duration')
                        stats['meta_extracted'] += 1

            if not duration or duration <= 0:
                stats['no_duration'] += 1
                continue

            count = loop.run_until_complete(gen_thumbs(dl_id, str(file_path), duration))
            if count:
                stats['generated'] += 1
            else:
                stats['failed'] += 1
    finally:
        loop.close()

    # The explorer's own thumbnail cache is keyed by path, not by download id,
    # so it needs its own sweep: drop anything whose source file has since been
    # deleted, moved or replaced.
    explorer = prune_thumb_cache()
    stats['explorer_pruned'] = explorer['deleted']
    stats['explorer_kept'] = explorer['kept']
    stats['explorer_freed'] = explorer['freed']
    return stats


def run_ytdlp_upgrade():
    """pip-install --upgrade yt-dlp into the venv. Raises on failure."""
    from backend.ytdlp_handler import YtdlpDownloader

    ytdlp = YtdlpDownloader.YTDLP_PATH
    venv_pip = str(Path(__file__).parent.parent / 'venv' / 'bin' / 'pip')

    def version():
        return subprocess.run([ytdlp, '--version'], capture_output=True,
                              text=True, timeout=10).stdout.strip()

    old_ver = version()
    result = subprocess.run([venv_pip, 'install', '--upgrade', 'yt-dlp'],
                            capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip()[:500] or 'pip failed')
    new_ver = version()
    return {'old_version': old_ver, 'new_version': new_ver, 'upgraded': old_ver != new_ver}


def _summarize_sync(stats):
    parts = []
    for key, label in (('generated', 'generated'), ('orphan_deleted', 'orphans removed'),
                       ('db_count_fixed', 'counts fixed'), ('explorer_pruned', 'explorer thumbs pruned')):
        if stats.get(key):
            parts.append(f"{stats[key]} {label}")
    return ', '.join(parts) or 'nothing to do'


def _summarize_ytdlp(result):
    if result.get('upgraded'):
        return f"upgraded {result.get('old_version')} -> {result.get('new_version')}"
    return f"already up to date ({result.get('new_version')})"


JOBS = {
    'sync_thumbnails': {
        'label': 'Sync thumbnails',
        'run': run_sync_thumbnails,
        'summarize': _summarize_sync,
    },
    'ytdlp_upgrade': {
        'label': 'Upgrade yt-dlp',
        'run': run_ytdlp_upgrade,
        'summarize': _summarize_ytdlp,
    },
}


# --------------------------------------------------------------------------
# Schedules
# --------------------------------------------------------------------------

_write_lock = threading.Lock()


def read_schedules():
    """Every known job's schedule, defaults filled in for unconfigured ones."""
    raw = get_db().get_setting(SETTINGS_KEY)
    stored = {}
    if raw:
        try:
            stored = json.loads(raw) or {}
        except (ValueError, TypeError):
            logger.warning("job_schedules setting is not valid JSON; ignoring it")

    schedules = {}
    for job_id in JOBS:
        entry = stored.get(job_id) or {}
        schedules[job_id] = {
            'enabled': bool(entry.get('enabled')),
            'time': entry.get('time') or '03:00',
            'days': entry.get('days') if isinstance(entry.get('days'), list) else ALL_DAYS,
            'last_run': entry.get('last_run'),
            'last_status': entry.get('last_status'),
            'last_summary': entry.get('last_summary'),
            # Slots at or before this are treated as already handled - see
            # save_schedule(). Kept apart from last_run so the UI never shows a
            # run that did not happen.
            'armed_at': entry.get('armed_at'),
        }
    return schedules


def _persist(schedules):
    with _write_lock:
        get_db().set_setting(SETTINGS_KEY, json.dumps(schedules))


def parse_time(value):
    """'HH:MM' -> (hour, minute). Raises ValueError on anything else."""
    hour, _, minute = (value or '').partition(':')
    try:
        hour, minute = int(hour), int(minute)
    except ValueError:
        raise ValueError('Time must look like HH:MM')
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError('Time must be between 00:00 and 23:59')
    return hour, minute


def save_schedule(job_id, enabled=None, at=None, days=None):
    """Update one job's schedule. Returns the stored entry.

    Any save re-arms the schedule: a slot that already passed today belonged to
    the schedule the user just replaced, so it is marked handled. Without this,
    enabling a job at 22:00 with a 03:00 time - or moving the time earlier -
    would fire it on the spot instead of tomorrow, which is never what the
    person clicking meant.
    """
    if job_id not in JOBS:
        raise KeyError(job_id)

    schedules = read_schedules()
    entry = schedules[job_id]

    if at is not None:
        hour, minute = parse_time(at)
        entry['time'] = f'{hour:02d}:{minute:02d}'
    if days is not None:
        cleaned = sorted({int(d) for d in days if 0 <= int(d) <= 6})
        if not cleaned:
            raise ValueError('Pick at least one day')
        entry['days'] = cleaned
    if enabled is not None:
        entry['enabled'] = bool(enabled)
    if entry['enabled']:
        now = datetime.now()
        slot = _slot_today(entry, now)
        if slot and slot <= now:
            entry['armed_at'] = slot.isoformat()

    schedules[job_id] = entry
    _persist(schedules)
    return entry


def _slot_today(entry, now):
    try:
        hour, minute = parse_time(entry.get('time'))
    except (ValueError, TypeError):
        return None
    return now.replace(hour=hour, minute=minute, second=0, microsecond=0)


def next_run(entry, now=None):
    """When this schedule fires next, or None if it is off/invalid."""
    if not entry.get('enabled'):
        return None
    days = entry.get('days') or ALL_DAYS
    now = now or datetime.now()
    slot = _slot_today(entry, now)
    if not slot:
        return None
    for offset in range(0, 8):
        candidate = slot + timedelta(days=offset)
        if candidate.weekday() in days and candidate > now:
            return candidate
    return None


def _is_due(entry, now):
    if not entry.get('enabled'):
        return False
    if now.weekday() not in (entry.get('days') or ALL_DAYS):
        return False
    slot = _slot_today(entry, now)
    if not slot or now < slot:
        return False
    for stamp in (entry.get('last_run'), entry.get('armed_at')):
        if not stamp:
            continue
        try:
            if datetime.fromisoformat(stamp) >= slot:
                return False
        except ValueError:
            continue
    return True


def run_job(job_id, record=True):
    """Run a job by id and, by default, record the outcome on its schedule.

    Used by both the API's "Run now" and the scheduler, so the two can never
    drift apart. Raises whatever the job raises; the caller decides how loud to
    be about it.
    """
    job = JOBS[job_id]
    started = datetime.now()
    try:
        result = job['run']()
    except Exception as e:
        if record:
            _record(job_id, started, 'error', str(e)[:300])
        raise
    if record:
        _record(job_id, started, 'ok', job['summarize'](result))
    return result


def _record(job_id, when, status, summary):
    schedules = read_schedules()
    schedules[job_id].update({
        'last_run': when.isoformat(),
        'last_status': status,
        'last_summary': summary,
    })
    _persist(schedules)


class JobScheduler(threading.Thread):
    """Daemon thread that fires due jobs.

    A slot that passed while the service was down still runs on the next tick
    after startup: on a home server "the 3 AM sweep never happened because you
    rebooted at 2:55" is worse than it running a few minutes late.
    """

    def __init__(self, interval=TICK_SECONDS):
        super().__init__(daemon=True, name='job-scheduler')
        self.interval = interval
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()

    def run(self):
        # A moment's grace so the first tick doesn't race database init.
        time.sleep(5)
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001 - the thread must survive
                logger.warning("job scheduler tick failed: %s", e)
            self._stop.wait(self.interval)

    def tick(self, now=None):
        now = now or datetime.now()
        for job_id, entry in read_schedules().items():
            if not _is_due(entry, now):
                continue
            logger.info("running scheduled job %s", job_id)
            print(f"⏰ Running scheduled job: {JOBS[job_id]['label']}")
            try:
                run_job(job_id)
            except Exception as e:  # noqa: BLE001 - one bad job must not stop the rest
                logger.warning("scheduled job %s failed: %s", job_id, e)
                print(f"⚠️  Scheduled job {job_id} failed: {e}")

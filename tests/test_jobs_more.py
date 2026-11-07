"""The job bodies behind "Run now" and the scheduler, with ffprobe/ffmpeg
and pip faked; the schedule store's arming rules; and a scheduler tick that
keeps going past a job that blows up."""
import json
from datetime import datetime

import pytest

from backend import jobs
from backend.config import DOWNLOAD_DIR, SCREENSHOTS_DIR


# --- sync_thumbnails ------------------------------------------------------------

@pytest.fixture
def fake_media(monkeypatch):
    """Scripted ffprobe/ffmpeg and a no-op explorer cache prune."""
    calls = {'probe': [], 'thumbs': []}
    state = {'probe': {'streams': [{'codec_type': 'video', 'width': 1, 'height': 1}],
                       'format': {'duration': '30'}},
             'thumbs': 10}

    async def probe(path):
        calls['probe'].append(path)
        return state['probe']

    async def gen(download_id, path, duration):
        calls['thumbs'].append((download_id, duration))
        return state['thumbs']

    monkeypatch.setattr('backend.file_meta.probe_video', probe)
    monkeypatch.setattr('backend.file_meta.generate_thumbnails', gen)
    monkeypatch.setattr('backend.files.prune_thumb_cache',
                        lambda: {'deleted': 2, 'kept': 5, 'freed': 1024})
    calls['state'] = state
    return calls


def thumbs_of(download_id, n):
    d = SCREENSHOTS_DIR / str(download_id)
    d.mkdir(parents=True, exist_ok=True)
    for i in range(1, n + 1):
        (d / f'{i}.jpg').write_bytes(b'x')
    return d


def test_sync_thumbnails_handles_every_case_in_one_sweep(db, fake_media):
    on_disk = ['has-thumbs.mkv', 'needs-thumbs.mkv', 'needs-meta.mkv']
    for name in on_disk:
        (DOWNLOAD_DIR / name).write_bytes(b'x')

    not_video = db.add_download(file='doc.pdf', status='done', message_id='s-1')
    orphan = db.add_download(file='gone.mkv', status='done', message_id='s-2')
    missing = db.add_download(file='also-gone.mkv', status='done', message_id='s-3')
    synced = db.add_download(file='has-thumbs.mkv', status='done', message_id='s-4')
    needs_thumbs = db.add_download(file='needs-thumbs.mkv', status='done', message_id='s-5')
    needs_meta = db.add_download(file='needs-meta.mkv', status='done', message_id='s-6')
    db.add_download(file='running.mkv', status='downloading', message_id='s-7')
    deleted = db.add_download(file='deleted.mkv', status='done', message_id='s-8')
    db.delete_download_by_id(deleted['id'])

    thumbs_of(orphan['id'], 2)
    thumbs_of(synced['id'], 4)
    db.update_download_by_id(synced['id'], thumb_count=9)      # wrong count on the record
    db.update_download_by_id(needs_thumbs['id'], file_meta=json.dumps({'video': {}, 'duration': 42.0}))

    stats = jobs.run_sync_thumbnails()

    assert stats == {
        'generated': 2, 'skipped': 1, 'orphan_deleted': 1, 'db_count_fixed': 1,
        'meta_extracted': 1, 'no_duration': 0, 'not_video': 1, 'failed': 0,
        'explorer_pruned': 2, 'explorer_kept': 5, 'explorer_freed': 1024,
    }
    assert not (SCREENSHOTS_DIR / str(orphan['id'])).exists()
    assert db.get_download_by_id(orphan['id'])['thumb_count'] == 0
    assert db.get_download_by_id(synced['id'])['thumb_count'] == 4
    assert db.get_download_by_id(needs_meta['id'])['file_meta']['duration'] == 30.0
    assert sorted(fake_media['thumbs']) == sorted([(needs_thumbs['id'], 42.0), (needs_meta['id'], 30.0)])
    assert fake_media['probe'] == [str(DOWNLOAD_DIR / 'needs-meta.mkv')]
    assert db.get_download_by_id(missing['id'])['thumb_count'] == 0   # untouched
    assert db.get_download_by_id(not_video['id'])['thumb_count'] == 0


def test_sync_thumbnails_counts_what_it_could_not_do(db, fake_media):
    (DOWNLOAD_DIR / 'no-dur.mkv').write_bytes(b'x')
    (DOWNLOAD_DIR / 'fails.mkv').write_bytes(b'x')
    (DOWNLOAD_DIR / 'unprobeable.mkv').write_bytes(b'x')
    db.add_download(file='no-dur.mkv', status='done', message_id='s-1')
    fails = db.add_download(file='fails.mkv', status='done', message_id='s-2')
    db.update_download_by_id(fails['id'], file_meta=json.dumps({'video': {}, 'duration': 5}))
    db.add_download(file='unprobeable.mkv', status='done', message_id='s-3')

    fake_media['state']['probe'] = None            # ffprobe fails
    fake_media['state']['thumbs'] = 0              # ffmpeg produced nothing
    stats = jobs.run_sync_thumbnails()
    assert (stats['no_duration'], stats['failed'], stats['meta_extracted']) == (2, 1, 0)

    # A probe that yields streams but no duration is "no duration", not a crash
    fake_media['state']['probe'] = {'streams': [{'codec_type': 'video'}], 'format': {}}
    assert jobs.run_sync_thumbnails()['no_duration'] == 2


def test_sync_thumbnails_summary(db):
    assert jobs._summarize_sync({'generated': 0}) == 'nothing to do'
    assert jobs._summarize_sync({'generated': 2, 'orphan_deleted': 1, 'db_count_fixed': 3,
                                 'explorer_pruned': 4}) == \
        '2 generated, 1 orphans removed, 3 counts fixed, 4 explorer thumbs pruned'


def test_sync_thumbnails_route_runs_the_job_and_records_it(client, db, auth, fake_media):
    res = client.post('/api/jobs/sync-thumbnails', headers=auth)
    assert res.status_code == 200
    assert res.get_json()['explorer_pruned'] == 2
    entry = jobs.read_schedules()['sync_thumbnails']
    assert entry['last_status'] == 'ok' and entry['last_summary'] == '2 explorer thumbs pruned'


# --- ytdlp_upgrade ----------------------------------------------------------------

@pytest.fixture
def fake_pip(monkeypatch):
    """subprocess.run scripted by command: yt-dlp --version answers from a
    list of versions, pip answers with the given exit code."""
    state = {'versions': ['2026.01.01', '2026.02.02'], 'pip_rc': 0, 'calls': []}

    class Result:
        def __init__(self, stdout='', stderr='', returncode=0):
            self.stdout, self.stderr, self.returncode = stdout, stderr, returncode

    def run(argv, **kw):
        state['calls'].append(argv)
        if argv[1:] == ['--version']:
            v = state['versions'].pop(0) if len(state['versions']) > 1 else state['versions'][0]
            return Result(stdout=v + '\n')
        return Result(stderr='boom\n', returncode=state['pip_rc'])

    monkeypatch.setattr(jobs.subprocess, 'run', run)
    return state


def test_ytdlp_upgrade_reports_the_version_change(db, fake_pip):
    assert jobs.run_job('ytdlp_upgrade') == {
        'old_version': '2026.01.01', 'new_version': '2026.02.02', 'upgraded': True}
    assert fake_pip['calls'][1][-3:] == ['install', '--upgrade', 'yt-dlp']
    assert fake_pip['calls'][1][0].endswith('venv/bin/pip')
    entry = jobs.read_schedules()['ytdlp_upgrade']
    assert entry['last_status'] == 'ok'
    assert entry['last_summary'] == 'upgraded 2026.01.01 -> 2026.02.02'


def test_ytdlp_upgrade_already_current(db, fake_pip):
    fake_pip['versions'] = ['2026.02.02']
    assert jobs.run_job('ytdlp_upgrade')['upgraded'] is False
    assert jobs.read_schedules()['ytdlp_upgrade']['last_summary'] == 'already up to date (2026.02.02)'


def test_a_failed_pip_run_is_recorded_as_an_error_and_raised(db, fake_pip):
    fake_pip['pip_rc'] = 1
    with pytest.raises(RuntimeError, match='boom'):
        jobs.run_job('ytdlp_upgrade')
    entry = jobs.read_schedules()['ytdlp_upgrade']
    assert entry['last_status'] == 'error' and entry['last_summary'] == 'boom'
    assert entry['last_run']


def test_a_failed_pip_run_without_output_still_has_a_reason(db, fake_pip, monkeypatch):
    fake_pip['pip_rc'] = 2
    real = jobs.subprocess.run

    def run(argv, **kw):
        r = real(argv, **kw)
        r.stderr = ''
        return r
    monkeypatch.setattr(jobs.subprocess, 'run', run)
    with pytest.raises(RuntimeError, match='pip failed'):
        jobs.run_ytdlp_upgrade()


def test_the_upgrade_route(client, db, auth, fake_pip):
    assert client.post('/api/jobs/ytdlp-upgrade', headers=auth).get_json()['upgraded'] is True
    fake_pip['pip_rc'] = 1
    res = client.post('/api/jobs/ytdlp-upgrade', headers=auth)
    assert res.status_code == 500 and res.get_json()['error'] == 'boom'


# --- check_files --------------------------------------------------------------------

def test_check_files_summary():
    assert jobs._summarize_check_files({'checked': 3, 'present': 3}) == '3 of 3 on disk; no changes'
    assert jobs._summarize_check_files({'checked': 3, 'present': 1, 'marked_missing': 2, 'restored': 1}) == \
        '1 of 3 on disk; 2 marked missing, 1 found again'


def test_check_files_leaves_a_single_file_pull_uncounted(db):
    (DOWNLOAD_DIR / 'VPS').mkdir(exist_ok=True)
    (DOWNLOAD_DIR / 'VPS' / 'one.mkv').write_bytes(b'x')
    db.add_download(file='one.mkv', status='done', downloaded_from='vps', message_id='cf-1')
    jobs.run_check_files()
    assert db.get_download_by_message_id('cf-1')['file_count'] is None


def test_run_job_without_recording_leaves_the_schedule_alone(db):
    jobs.run_job('check_files', record=False)
    assert jobs.read_schedules()['check_files']['last_run'] is None


# --- schedules ----------------------------------------------------------------------

def test_read_schedules_fills_defaults_and_ignores_broken_json(db):
    db.set_setting(jobs.SETTINGS_KEY, '{not json')
    schedules = jobs.read_schedules()
    assert set(schedules) == set(jobs.JOBS)
    assert schedules['check_files'] == {
        'enabled': False, 'time': '03:00', 'days': jobs.ALL_DAYS, 'last_run': None,
        'last_status': None, 'last_summary': None, 'armed_at': None}


def test_read_schedules_tolerates_partial_entries(db):
    db.set_setting(jobs.SETTINGS_KEY, json.dumps({'check_files': {'enabled': 1, 'days': 'mon'},
                                                  'retired_job': {'enabled': True}}))
    entry = jobs.read_schedules()['check_files']
    assert entry['enabled'] is True and entry['days'] == jobs.ALL_DAYS and entry['time'] == '03:00'
    assert 'retired_job' not in jobs.read_schedules()


class At(datetime):
    """datetime whose now() is pinned."""
    fixed = None

    @classmethod
    def now(cls, tz=None):
        return cls.fixed


@pytest.fixture
def now(monkeypatch):
    def pin(when):
        At.fixed = when
        monkeypatch.setattr(jobs, 'datetime', At)
        return when
    return pin


def test_save_schedule_validates(db):
    with pytest.raises(KeyError):
        jobs.save_schedule('no-such-job', enabled=True)
    with pytest.raises(ValueError, match='at least one day'):
        jobs.save_schedule('check_files', days=[])
    with pytest.raises(ValueError, match='at least one day'):
        jobs.save_schedule('check_files', days=[7, -1])     # out of range, dropped
    with pytest.raises(ValueError, match='HH:MM'):
        jobs.save_schedule('check_files', at='noon')
    with pytest.raises(ValueError, match='between'):
        jobs.save_schedule('check_files', at='24:00')


def test_save_schedule_normalizes_time_and_days(db):
    entry = jobs.save_schedule('check_files', at='7:5', days=['6', 0, 0, 3])
    assert entry['time'] == '07:05' and entry['days'] == [0, 3, 6]
    assert jobs.read_schedules()['check_files']['days'] == [0, 3, 6]


def test_enabling_a_schedule_whose_slot_passed_today_arms_it_for_tomorrow(db, now):
    now(datetime(2026, 9, 18, 22, 0))
    entry = jobs.save_schedule('check_files', enabled=True, at='03:00')
    assert entry['armed_at'] == '2026-09-18T03:00:00'
    assert entry['last_run'] is None                       # not reported as a run
    assert jobs._is_due(entry, At.fixed) is False          # waits for tomorrow
    assert jobs.next_run(entry, At.fixed) == datetime(2026, 9, 19, 3, 0)


def test_a_slot_still_ahead_is_not_armed(db, now):
    now(datetime(2026, 9, 18, 1, 0))
    entry = jobs.save_schedule('check_files', enabled=True, at='03:00')
    assert entry['armed_at'] is None
    assert jobs._is_due(entry, datetime(2026, 9, 18, 3, 1)) is True


def test_a_disabled_save_never_arms(db, now):
    now(datetime(2026, 9, 18, 22, 0))
    assert jobs.save_schedule('check_files', enabled=False, at='03:00')['armed_at'] is None


def entry(**over):
    base = {'enabled': True, 'time': '03:00', 'days': list(range(7))}
    base.update(over)
    return base


def test_a_run_at_or_after_the_slot_means_it_is_handled():
    due = datetime(2026, 9, 18, 3, 5)
    assert jobs._is_due(entry(last_run='2026-09-18T03:00:30'), due) is False
    assert jobs._is_due(entry(last_run='2026-09-17T03:00:30'), due) is True     # yesterday's run
    assert jobs._is_due(entry(armed_at='2026-09-18T03:00:00'), due) is False
    assert jobs._is_due(entry(last_run='garbage'), due) is True                  # unparseable: ignored
    assert jobs._is_due(entry(time='nope'), due) is False


def test_a_missed_slot_is_still_due_hours_later():
    """Catch-up: the service was down at 03:00 and came back at 09:00."""
    assert jobs._is_due(entry(last_run='2026-09-17T03:00:00'), datetime(2026, 9, 18, 9, 0)) is True


def test_next_run_with_an_impossible_day_list_is_none():
    assert jobs.next_run(entry(days=[9]), datetime(2026, 9, 18, 1, 0)) is None


# --- the scheduler --------------------------------------------------------------------

@pytest.fixture
def two_jobs(db, monkeypatch):
    ran = []

    def boom():
        ran.append('boom')
        raise RuntimeError('kaboom')

    def fine():
        ran.append('fine')
        return {'n': 1}

    monkeypatch.setattr(jobs, 'JOBS', {
        'boom': {'label': 'Boom', 'run': boom, 'summarize': lambda r: 'never'},
        'fine': {'label': 'Fine', 'run': fine, 'summarize': lambda r: f"n={r['n']}"},
    })
    db.set_setting(jobs.SETTINGS_KEY, json.dumps({
        'boom': {'enabled': True, 'time': '03:00'},
        'fine': {'enabled': True, 'time': '03:00'},
    }))
    return ran


def test_a_failing_job_does_not_stop_the_others_and_is_recorded(two_jobs, capsys):
    jobs.JobScheduler().tick(now=datetime(2026, 9, 18, 4, 0))
    assert two_jobs == ['boom', 'fine']
    schedules = jobs.read_schedules()
    assert schedules['boom']['last_status'] == 'error' and schedules['boom']['last_summary'] == 'kaboom'
    assert schedules['fine']['last_status'] == 'ok' and schedules['fine']['last_summary'] == 'n=1'
    assert 'failed' in capsys.readouterr().out
    # Recorded, so the same slot doesn't fire twice
    jobs.JobScheduler().tick(now=datetime(2026, 9, 18, 4, 1))
    assert two_jobs == ['boom', 'fine']


def test_nothing_due_runs_nothing(two_jobs):
    jobs.JobScheduler().tick(now=datetime(2026, 9, 18, 2, 0))
    assert two_jobs == []


def test_the_thread_loop_survives_a_failing_tick(monkeypatch):
    scheduler = jobs.JobScheduler(interval=0)
    ticks = []

    def tick(now=None):
        ticks.append(1)
        if len(ticks) == 2:
            scheduler.stop()
        raise RuntimeError('tick failed')

    monkeypatch.setattr(scheduler, 'tick', tick)
    monkeypatch.setattr(jobs.time, 'sleep', lambda s: None)   # the startup grace
    scheduler.run()
    assert ticks == [1, 1]

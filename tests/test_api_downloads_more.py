"""The download mutations' remaining branches: stopping and deleting through
each handler (stubbed), the Telegram pause/resume round trip, deleting the
file with the record, retry refusals, the per-file skip that finishes a VPS
pull, and the queue routes' input checks."""
import asyncio
import os
import threading
from contextlib import contextmanager

import pytest

from backend import download_queue as dq
from backend import file_meta
from backend.config import DOWNLOAD_DIR
from backend.vps_handler import VpsDownloader
from tests.conftest import FakeSFTP


# --- stubs ----------------------------------------------------------------------------

class FakeTask:
    def __init__(self, done=False):
        self._done = done
        self.cancelled = False

    def done(self):
        return self._done

    def cancel(self):
        self.cancelled = True
        self._done = True


class StubTelegram:
    """The bits of TelegramDownloader the download routes touch, with its
    coroutines running on a real loop in a daemon thread."""

    def __init__(self, loop):
        self.loop = loop
        self.client = None
        self.status_messages = []
        self.paused = []
        self.restart_result = True

    async def update_status_message(self, message_id, text):
        self.status_messages.append((message_id, text))

    def pause_download(self, message_id):
        self.paused.append(message_id)

    async def restart_download(self, message_id):
        if isinstance(self.restart_result, Exception):
            raise self.restart_result
        return self.restart_result


@pytest.fixture
def telegram(app):
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    stub = StubTelegram(loop)
    app.telegram_downloader = stub
    yield stub
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


class StubVps:
    def __init__(self, stops=True):
        self.stops = stops
        self.stopped = []

    def stop_download(self, message_id, timeout=15.0):
        self.stopped.append(message_id)
        return self.stops


class StubYtdlp:
    def __init__(self):
        self.stopped = []

    def stop_download(self, message_id):
        self.stopped.append(message_id)


@pytest.fixture
def quiet_queue(monkeypatch):
    monkeypatch.setattr(dq, '_notify', lambda: None)
    monkeypatch.setattr(dq, '_run_in_background', lambda fn: fn())


# --- stop ---------------------------------------------------------------------------------

def test_stopping_a_vps_transfer_that_will_not_die_is_an_error(app, client, db, auth):
    app.vps_downloader = StubVps(stops=False)
    db.add_download(file='a', status='downloading', downloaded_from='vps', message_id='v-1', url='/r/a')
    res = client.post('/api/stop', headers=auth, json={'message_id': 'v-1'})
    assert res.status_code == 500 and 'did not stop' in res.get_json()['error']
    assert db.get_download_by_message_id('v-1')['status'] == 'downloading'


def test_stopping_a_ytdlp_download_goes_through_the_handler_and_the_task(app, client, db, auth):
    app.ytdlp_downloader = StubYtdlp()
    task = FakeTask()
    app.download_tasks['y-1'] = task
    db.add_download(file='a', status='downloading', downloaded_from='x.com', message_id='y-1')
    assert client.post('/api/stop', headers=auth, json={'message_id': 'y-1'}).status_code == 200
    assert app.ytdlp_downloader.stopped == ['y-1'] and task.cancelled
    assert db.get_download_by_message_id('y-1')['status'] == 'stopped'


def test_stopping_a_telegram_download_cancels_its_task_and_edits_the_chat(app, client, db, auth, telegram):
    task = FakeTask()
    app.download_tasks[41] = task
    db.add_download(file='a', status='downloading', message_id='41')
    assert client.post('/api/stop', headers=auth, json={'message_id': '41'}).status_code == 200
    assert task.cancelled
    assert db.get_download_by_message_id('41')['status'] == 'stopped'
    # The chat edit runs on the Telegram loop; give it a moment
    for _ in range(50):
        if telegram.status_messages:
            break
        threading.Event().wait(0.02)
    assert telegram.status_messages == [(41, 'Stopped')]


def test_a_requeue_waits_for_the_task_to_leave(app, db, telegram, monkeypatch):
    """A reorder sending a running download back to waiting must not write
    'waiting' before the handler's own 'stopped' lands."""
    db.add_download(file='a', status='downloading', message_id='42', queue_position=4)
    task = FakeTask()
    app.download_tasks[42] = task
    assert app.stop_one_download('42', requeue=True) is None
    row = db.get_download_by_message_id('42')
    assert row['status'] == 'waiting' and row['queue_position'] == 4

    # A yt-dlp task that never deregisters itself: give up with a reason
    db.add_download(file='b', status='downloading', downloaded_from='x.com', message_id='y-2')
    app.download_tasks['y-2'] = FakeTask()
    import time as _time
    clock = {'t': 0.0}
    monkeypatch.setattr(_time, 'time', lambda: clock.__setitem__('t', clock['t'] + 30) or clock['t'])
    monkeypatch.setattr(_time, 'sleep', lambda s: None)
    assert app.stop_one_download('y-2', requeue=True) == 'Download did not stop in time'


def test_stop_needs_a_message_id(app):
    assert app.stop_one_download(None) == 'message_id is required'


# --- pause / resume (Telegram) -----------------------------------------------------------

def test_pause_and_resume_a_telegram_download(app, client, db, auth, telegram, quiet_queue):
    db.add_download(file='a', status='downloading', message_id='51')
    assert client.post('/api/pause', headers=auth, json={'message_id': '51'}).get_json() == {'status': 'paused'}
    assert telegram.paused == [51]
    assert db.get_download_by_message_id('51')['status'] == 'paused'

    res = client.post('/api/resume', headers=auth, json={'message_id': '51'})
    assert res.get_json() == {'status': 'downloading'}
    assert db.get_download_by_message_id('51')['status'] == 'downloading'


def test_resume_is_refused_for_uuid_downloads(client, db, auth):
    db.add_download(file='a', status='stopped', downloaded_from='x.com', message_id='y-3')
    res = client.post('/api/resume', headers=auth, json={'message_id': 'y-3'})
    assert res.status_code == 400 and 'not supported' in res.get_json()['error']


def test_a_resume_the_client_refuses_gives_the_slot_back(app, client, db, auth, telegram, quiet_queue):
    db.add_download(file='a', status='paused', message_id='52')
    telegram.restart_result = False
    res = client.post('/api/resume', headers=auth, json={'message_id': '52'})
    assert res.status_code == 500 and 'Failed to restart' in res.get_json()['error']
    assert db.get_download_by_message_id('52')['status'] == 'paused'

    telegram.restart_result = RuntimeError('message gone')
    res = client.post('/api/resume', headers=auth, json={'message_id': '52'})
    assert res.status_code == 500 and 'message gone' in res.get_json()['error']
    assert db.get_download_by_message_id('52')['status'] == 'paused'


def test_a_resume_with_no_free_slot_joins_the_queue(app, client, db, auth, telegram, quiet_queue):
    dq.set_limits({'global': 1})
    db.add_download(file='busy', status='downloading', message_id='53')
    db.add_download(file='a', status='paused', message_id='54')
    res = client.post('/api/resume', headers=auth, json={'message_id': '54'})
    assert res.get_json() == {'status': 'waiting'}
    assert db.get_download_by_message_id('54')['status'] == 'waiting'


# --- retry ---------------------------------------------------------------------------------

def test_retry_refusals(client, db, auth):
    assert client.post('/api/retry', headers=auth, json={}).status_code == 400
    row = db.add_download(file='a', status='done', message_id='r-1')
    res = client.post('/api/retry', headers=auth, json={'id': row['id']})
    assert res.status_code == 400 and 'Cannot retry a done' in res.get_json()['error']


def test_a_retry_that_cannot_restart_puts_the_status_back(client, db, auth, quiet_queue, monkeypatch):
    row = db.add_download(file='a', status='failed', downloaded_from='x.com', message_id='r-2')
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: False)
    res = client.post('/api/retry', headers=auth, json={'id': row['id']})
    assert res.status_code == 500
    assert db.get_download_by_message_id('r-2')['status'] == 'failed'


# --- delete ---------------------------------------------------------------------------------

@pytest.fixture
def thumbs_dir(tmp_path, monkeypatch):
    d = tmp_path / 'thumbs'
    monkeypatch.setattr(file_meta, 'THUMBS_DIR', d)
    return d


def test_deleting_a_running_vps_transfer_stops_it_first(app, client, db, auth, quiet_queue):
    app.vps_downloader = StubVps(stops=False)
    db.add_download(file='a', status='downloading', downloaded_from='vps', message_id='v-2', url='/r/a')
    res = client.post('/api/delete', headers=auth, json={'message_id': 'v-2'})
    assert res.status_code == 500
    assert db.get_download_by_message_id('v-2')['deleted_at'] is None
    app.vps_downloader = StubVps(stops=True)
    assert client.post('/api/delete', headers=auth, json={'message_id': 'v-2'}).status_code == 200
    assert db.get_download_by_message_id('v-2')['deleted_at']


def test_deleting_a_ytdlp_download_cancels_and_forgets_its_task(app, client, db, auth, quiet_queue):
    app.ytdlp_downloader = StubYtdlp()
    task = FakeTask()
    app.download_tasks['y-4'] = task
    db.add_download(file='a', status='downloading', downloaded_from='x.com', message_id='y-4')
    assert client.post('/api/delete', headers=auth, json={'message_id': 'y-4'}).status_code == 200
    assert task.cancelled and 'y-4' not in app.download_tasks
    assert app.ytdlp_downloader.stopped == ['y-4']


def test_deleting_a_running_telegram_download_stops_it(app, client, db, auth, quiet_queue):
    task = FakeTask()
    app.download_tasks[61] = task
    db.add_download(file='a', status='downloading', message_id='61')
    assert client.post('/api/delete', headers=auth, json={'message_id': '61'}).status_code == 200
    assert task.cancelled and 61 not in app.download_tasks
    row = db.get_download_by_message_id('61')
    assert row['status'] == 'stopped' and row['deleted_at']


def test_delete_with_the_file_removes_file_folder_or_link_and_thumbnails(client, db, auth, quiet_queue, thumbs_dir, tmp_path):
    (DOWNLOAD_DIR / 'gone.mkv').write_bytes(b'x')
    (DOWNLOAD_DIR / 'Folder').mkdir()
    (DOWNLOAD_DIR / 'Folder' / 'ep.mkv').write_bytes(b'x')
    target = tmp_path / 'real.mkv'
    target.write_bytes(b'x')
    os.symlink(target, DOWNLOAD_DIR / 'link.mkv')
    f = db.add_download(file='gone.mkv', status='done', message_id='d-1')
    d = db.add_download(file='Folder', status='done', downloaded_from='vps', message_id='d-2', url='/r/Folder')
    s = db.add_download(file='link.mkv', status='done', message_id='d-3')
    (thumbs_dir / str(f['id'])).mkdir(parents=True)
    (thumbs_dir / str(f['id']) / '1.jpg').write_bytes(b'x')

    for row in (f, d, s):
        res = client.post('/api/delete', headers=auth, json={'message_id': row['message_id'], 'delete_file': True})
        assert res.status_code == 200
    assert not (DOWNLOAD_DIR / 'gone.mkv').exists()
    assert not (DOWNLOAD_DIR / 'Folder').exists()
    assert not (DOWNLOAD_DIR / 'link.mkv').is_symlink() and target.exists()   # the link, not its target
    assert not (thumbs_dir / str(f['id'])).exists()


def test_a_file_that_cannot_be_removed_does_not_block_the_delete(client, db, auth, quiet_queue, capsys):
    locked = DOWNLOAD_DIR / 'Locked'
    locked.mkdir()
    (locked / 'ep.mkv').write_bytes(b'x')
    locked.chmod(0o500)
    try:
        db.add_download(file='Locked', status='done', downloaded_from='vps', message_id='d-4', url='/r/Locked')
        res = client.post('/api/delete', headers=auth, json={'message_id': 'd-4', 'delete_file': True})
        assert res.status_code == 200
        assert db.get_download_by_message_id('d-4')['deleted_at']
        assert 'Failed to delete' in capsys.readouterr().out
    finally:
        locked.chmod(0o700)


def test_delete_file_with_nothing_on_disk_is_fine(client, db, auth, quiet_queue):
    db.add_download(file='never.mkv', status='failed', message_id='d-5')
    assert client.post('/api/delete', headers=auth,
                       json={'message_id': 'd-5', 'delete_file': True}).status_code == 200


# --- per-file status of a VPS pull -------------------------------------------------------

REMOTE = '/home6/tester/downloads/Show'
TREE = {
    '/home6/tester/downloads': {'Show': None},
    REMOTE: {'ep01.mkv': 10, 'ep02.mkv': 10},
}


@pytest.fixture
def remote(monkeypatch):
    sftp = FakeSFTP(TREE)

    @contextmanager
    def session(timeout=15):
        yield object(), sftp
    monkeypatch.setattr('backend.web_app.vps.vps_session', session)
    return sftp


@pytest.fixture
def pull(app, db, tmp_path):
    app.vps_downloader = VpsDownloader(download_tasks={})
    dest = tmp_path / 'tv'
    (dest / 'Show').mkdir(parents=True)
    (dest / 'Show' / 'ep01.mkv').write_bytes(b'x' * 10)
    return db.add_download(file='Show', status='stopped', downloaded_from='vps',
                           message_id='p-1', url=REMOTE, dest_base=str(dest), total_bytes=20)


def test_file_routes_refuse_what_is_not_a_vps_pull(app, client, db, auth):
    assert client.get('/api/downloads/99999/files', headers=auth).status_code == 404
    other = db.add_download(file='a', status='done', message_id='o-1')
    assert client.get(f"/api/downloads/{other['id']}/files", headers=auth).status_code == 400
    assert client.post(f"/api/downloads/{other['id']}/files/status", headers=auth,
                       json={'paths': ['x'], 'status': 'paused'}).status_code == 400
    assert client.post('/api/downloads/99999/files/status', headers=auth,
                       json={'paths': ['x'], 'status': 'paused'}).status_code == 404
    vps = db.add_download(file='b', status='stopped', downloaded_from='vps', message_id='o-2', url='/r/b')
    app.vps_downloader = None
    assert client.get(f"/api/downloads/{vps['id']}/files", headers=auth).status_code == 503
    assert client.post(f"/api/downloads/{vps['id']}/files/status", headers=auth,
                       json={'paths': ['x'], 'status': 'paused'}).status_code == 503


def test_skipping_the_last_missing_file_finishes_a_stopped_pull(client, db, auth, remote, pull, quiet_queue):
    res = client.post(f"/api/downloads/{pull['id']}/files/status", headers=auth,
                      json={'paths': ['ep02.mkv'], 'status': 'skipped'})
    assert res.get_json() == {'file_status': {'ep02.mkv': 'skipped'}, 'status': 'done', 'restarted': None}
    row = db.get_download_by_message_id('p-1')
    assert row['status'] == 'done' and row['progress'] == 100
    assert row['total_bytes'] == 10 and row['downloaded_bytes'] == 10   # the skipped file is not counted


def test_clearing_a_file_of_a_pull_that_cannot_restart_says_so(client, db, auth, remote, pull, quiet_queue, monkeypatch):
    db.update_download_by_message_id('p-1', file_status='{"ep02.mkv": "skipped"}')
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: False)
    res = client.post(f"/api/downloads/{pull['id']}/files/status", headers=auth,
                      json={'paths': ['ep02.mkv'], 'status': None})
    assert res.status_code == 500
    assert "couldn't be restarted" in res.get_json()['error']
    assert res.get_json()['file_status'] == {}
    assert db.get_download_by_message_id('p-1')['status'] == 'stopped'


def test_clearing_a_file_with_no_free_slot_queues_the_pull(client, db, auth, remote, pull, quiet_queue):
    dq.set_limits({'global': 1})
    db.add_download(file='busy', status='downloading', message_id='busy-1')
    db.update_download_by_message_id('p-1', file_status='{"ep02.mkv": "paused"}')
    res = client.post(f"/api/downloads/{pull['id']}/files/status", headers=auth,
                      json={'paths': ['ep02.mkv'], 'status': None})
    assert res.get_json()['restarted'] == 'waiting' and res.get_json()['status'] == 'waiting'
    assert db.get_download_by_message_id('p-1')['status'] == 'waiting'


def test_resuming_a_paused_pull_that_cannot_restart_is_a_500(app, client, db, auth, remote, pull, quiet_queue, monkeypatch):
    db.update_download_by_message_id('p-1', status='paused', file_status='{"ep02.mkv": "paused"}')
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: False)
    res = client.post('/api/resume', headers=auth, json={'message_id': 'p-1'})
    assert res.status_code == 500
    assert db.get_download_by_message_id('p-1')['status'] == 'paused'


# --- queue routes' input checks ---------------------------------------------------------------

def test_queue_routes_validate_their_bodies(client, db, auth):
    res = client.post('/api/queue/reorder', headers=auth, json={'message_ids': 'id-a'})
    assert res.status_code == 400 and 'list' in res.get_json()['error']
    res = client.post('/api/queue/start-now', headers=auth, json={})
    assert res.status_code == 400 and 'message_id' in res.get_json()['error']
    res = client.post('/api/queue/start-now', headers=auth, json={'message_id': 'nope'})
    assert res.status_code == 400 and 'not found' in res.get_json()['error']

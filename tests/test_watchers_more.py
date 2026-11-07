"""The corners of the torrent watcher and the download queue that the main
suites leave out: the thread loops themselves, handler readiness against a
stubbed WebApp, and the notification helpers.

Both loops are `while True` with no stop flag, so their run() is called on the
test's own thread with the sleep/wait faked to raise SystemExit on the second
round - no real thread, no timing, and the loop's error guard is exercised
for real (it catches Exception, which SystemExit is not)."""
import threading
from types import SimpleNamespace

import pytest

from backend import download_queue as dq
from backend import torrent_watch
from backend.web_app import base as web_base


# --- torrent watcher: the thread -------------------------------------------

def test_the_torrent_watcher_loop_survives_a_failing_tick(monkeypatch, caplog):
    w = torrent_watch.TorrentWatcher(interval=7)
    ticks = []
    sleeps = []

    def tick():
        ticks.append(1)
        raise RuntimeError('vps down')

    def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            raise SystemExit             # ends the loop
    monkeypatch.setattr(w, 'tick', tick)
    monkeypatch.setattr(torrent_watch.time, 'sleep', sleep)
    with caplog.at_level('ERROR', logger='backend.torrent_watch'), pytest.raises(SystemExit):
        w.run()
    assert len(ticks) == 2               # it kept going after the first failure
    assert sleeps == [7, 7]              # and waited its interval each time
    assert 'vps down' in caplog.text


def test_the_torrent_watcher_defaults_its_interval_from_config(monkeypatch):
    monkeypatch.setattr(torrent_watch, 'TORRENT_WATCH_INTERVAL', 42)
    assert torrent_watch.TorrentWatcher().interval == 42
    assert torrent_watch.TorrentWatcher(interval=5).interval == 5


# --- download queue: limits ------------------------------------------------

def test_an_unreadable_limits_setting_falls_back_to_the_defaults(db):
    db.set_setting(dq.SETTINGS_KEY, 'not json at all')
    assert dq.get_limits() == dq.DEFAULT_LIMITS
    db.set_setting(dq.SETTINGS_KEY, '{"global": 5, "bogus": 1}')
    assert dq.get_limits() == {**dq.DEFAULT_LIMITS, 'global': 5}


# --- download queue: handler readiness -------------------------------------

@pytest.fixture
def web(monkeypatch):
    stub = SimpleNamespace(vps_downloader=None, telegram_downloader=None,
                           ytdlp_downloader=None, event_loop=None, emits=[])
    stub.emit_status = lambda message_id, status: stub.emits.append((message_id, status))
    monkeypatch.setattr(web_base, '_web_app', stub)
    return stub


def test_nothing_is_ready_without_a_web_app(monkeypatch):
    monkeypatch.setattr(web_base, '_web_app', None)
    assert all(dq._source_ready(s) is False for s in dq.SOURCES)


def test_vps_is_ready_once_its_handler_is_wired(web):
    assert dq._source_ready('vps') is False
    web.vps_downloader = object()
    assert dq._source_ready('vps') is True


def test_ytdlp_needs_the_handler_and_the_event_loop(web):
    web.ytdlp_downloader = object()
    assert dq._source_ready('ytdlp') is False
    web.event_loop = object()
    assert dq._source_ready('ytdlp') is True


def test_telegram_is_ready_only_with_a_connected_client(web):
    assert dq._source_ready('telegram') is False
    client = SimpleNamespace(is_connected=lambda: False)
    web.telegram_downloader = SimpleNamespace(loop=None, client=client)
    assert dq._source_ready('telegram') is False          # loop not up
    web.telegram_downloader.loop = object()
    assert dq._source_ready('telegram') is False          # loop up, not connected
    client.is_connected = lambda: True
    assert dq._source_ready('telegram') is True


def test_a_half_built_telegram_client_counts_as_not_ready(web):
    def boom():
        raise RuntimeError('client not initialised')
    web.telegram_downloader = SimpleNamespace(loop=object(),
                                              client=SimpleNamespace(is_connected=boom))
    assert dq._source_ready('telegram') is False


# --- download queue: starting ----------------------------------------------

def test_a_handler_that_raises_on_start_fails_the_download_honestly(db, web, monkeypatch):
    monkeypatch.setattr(dq, '_run_in_background', lambda fn: fn())
    monkeypatch.setattr('backend.resume.resume_download',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('loop closed')))
    row = db.add_download(file='x', status='downloading', message_id='id-x',
                          downloaded_from='example.com', url='https://x/x', queue_position=0)
    dq._start(row)
    got = db.get_download_by_message_id('id-x')
    assert got['status'] == 'failed' and 'queue' in got['error']
    assert got['queue_position'] is None
    assert web.emits == [('id-x', 'failed')]


def test_queue_starts_run_off_the_request_thread(db, web, monkeypatch):
    seen = {}

    def fake_resume(download, force=False, count_retry=True):
        seen['thread'] = threading.current_thread().name
        seen['count_retry'] = count_retry
        return True
    monkeypatch.setattr('backend.resume.resume_download', fake_resume)
    row = db.add_download(file='x', status='downloading', message_id='id-x',
                          downloaded_from='vps', url='/r/x')
    dq._start(row)
    for t in threading.enumerate():
        if t.name == 'queue-start':
            t.join(timeout=5)
    assert seen == {'thread': 'queue-start', 'count_retry': False}


# --- download queue: the runner thread -------------------------------------

def test_the_queue_runner_survives_a_failing_pump_and_clears_its_wake(monkeypatch, caplog):
    pumps = []
    waits = []

    class FakeWake:
        def __init__(self):
            self.cleared = 0

        def wait(self, timeout):
            waits.append(timeout)
            if len(waits) == 2:
                raise SystemExit
            return True

        def clear(self):
            self.cleared += 1

    def pump():
        pumps.append(1)
        if len(pumps) == 1:
            raise RuntimeError('db locked')
        return 0

    wake = FakeWake()
    monkeypatch.setattr(dq, 'pump', pump)
    monkeypatch.setattr(dq, '_wake', wake)
    runner = dq.QueueRunner(interval=9)
    assert runner.daemon and runner.name == 'download-queue'
    with caplog.at_level('ERROR', logger='backend.download_queue'), pytest.raises(SystemExit):
        runner.run()
    assert len(pumps) == 2
    assert waits == [9, 9]
    assert wake.cleared == 1             # cleared after the wait that returned
    assert 'db locked' in caplog.text


def test_kick_wakes_the_runner(monkeypatch):
    wake = threading.Event()
    monkeypatch.setattr(dq, '_wake', wake)
    dq.kick()
    assert wake.is_set()


# --- download queue: notifications -----------------------------------------

def test_emit_status_goes_through_the_web_app(web):
    dq._emit_status('id-1', 'waiting')
    assert web.emits == [('id-1', 'waiting')]


def test_emit_status_is_quiet_without_a_web_app_or_when_the_socket_fails(monkeypatch, web):
    def boom(message_id, status):
        raise ConnectionError('socket gone')
    web.emit_status = boom
    dq._emit_status('id-1', 'waiting')           # swallowed: resynced on reconnect
    monkeypatch.setattr(web_base, '_web_app', None)
    dq._emit_status('id-1', 'waiting')


def test_notify_tells_open_pages_the_queue_changed(monkeypatch):
    events = []
    monkeypatch.setattr(web_base, 'socketio',
                        SimpleNamespace(emit=lambda name, data: events.append((name, data))))
    dq._notify()
    assert events == [('queue:changed', {})]


def test_notify_is_quiet_without_a_socket_or_when_it_fails(monkeypatch):
    monkeypatch.setattr(web_base, 'socketio', None)
    dq._notify()

    def boom(name, data):
        raise RuntimeError('no server')
    monkeypatch.setattr(web_base, 'socketio', SimpleNamespace(emit=boom))
    dq._notify()


# --- download queue: admission and bulk actions, the branches left over ----

@pytest.fixture
def quiet(monkeypatch):
    monkeypatch.setattr(dq, '_notify', lambda: None)


def test_admit_existing_starts_at_once_when_a_slot_is_free(db, web, quiet):
    row = db.add_download(file='old', status='failed', message_id='id-old',
                          downloaded_from='vps', url='/r/old', error='boom')
    assert dq.admit_existing(row) == 'start'
    got = db.get_download_by_message_id('id-old')
    assert got['status'] == 'downloading' and got['error'] is None
    assert got['queue_position'] is not None        # ranked, so a reorder can bump it
    assert web.emits == []                          # the caller announces the start


def test_start_now_refuses_what_it_cannot_start(db, web, quiet):
    from datetime import datetime
    assert dq.start_now('nope') == (False, 'Download not found')
    db.add_download(file='r', status='downloading', message_id='id-r')
    ok, err = dq.start_now('id-r')
    assert ok is False and 'downloading' in err
    db.add_download(file='w', status='waiting', message_id='id-w', queue_position=0)
    assert dq.start_now('id-w') == (False, 'That downloader is not ready yet')   # no Telegram client
    db.add_download(file='d', status='waiting', message_id='id-d', queue_position=1)
    db.update_download_by_message_id('id-d', deleted_at=datetime.utcnow())
    assert dq.start_now('id-d') == (False, 'Download not found')
    assert db.get_download_by_message_id('id-w')['status'] == 'waiting'


def test_stop_all_reports_a_waiting_download_it_could_not_stop(db, web, quiet):
    db.add_download(file='w', status='waiting', message_id='id-w', queue_position=0)
    db.add_download(file='r', status='downloading', message_id='id-r', queue_position=1)

    def stop_one(message_id):
        if message_id == 'id-w':
            return 'stuck'
        db.update_download_by_message_id(message_id, status='stopped')
        return None

    assert dq.stop_all(stop_one) == {
        'stopped': 1,
        'errors': [{'message_id': 'id-w', 'file': 'w', 'error': 'stuck'}]}
    assert db.get_download_by_message_id('id-r')['status'] == 'stopped'


def test_resume_all_unpauses_a_vps_pulls_files_but_keeps_the_skipped_ones(db, web, quiet):
    """A paused VPS folder pull is paused because its files are; resuming it
    without clearing those would start and pause again at once. A skipped
    file is a different decision and stays skipped."""
    import json
    db.add_download(file='Show', status='paused', message_id='id-show',
                    downloaded_from='vps', url='/r/Show')
    db.update_download_by_message_id(
        'id-show', file_status=json.dumps({'a.mkv': 'paused', 'b.mkv': 'skipped'}))
    db.add_download(file='All', status='paused', message_id='id-all',
                    downloaded_from='vps', url='/r/All')
    db.update_download_by_message_id('id-all', file_status=json.dumps({'a.mkv': 'paused'}))
    db.add_download(file='tg', status='paused', message_id='id-tg')

    assert dq.resume_all() == 3
    show = db.get_download_by_message_id('id-show')
    assert show['status'] == 'waiting' and show['file_status'] == {'b.mkv': 'skipped'}
    assert db.get_download_by_message_id('id-all')['file_status'] == {}
    assert db.get_download_by_message_id('id-tg')['status'] == 'waiting'
    assert sorted(web.emits) == [('id-all', 'waiting'), ('id-show', 'waiting'), ('id-tg', 'waiting')]

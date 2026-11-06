"""The network watchdog. It only ever acts on something it observed - a link
that dropped and came back, a byte count that stopped moving, a row left
`downloading` by a restart - and `stopped`/`paused` are decisions it must
never undo. The probe is faked, time is passed in, and resume_download() is
recorded instead of reaching a handler; ticks are called directly."""
import threading
from datetime import datetime
from types import SimpleNamespace

import pytest

from backend import netwatch
from backend.web_app import base as web_base


class Link:
    """The faked probe: flip `.up` to take the uplink down and bring it back."""

    def __init__(self):
        self.up = True
        self.probes = 0

    def __call__(self):
        self.probes += 1
        return self.up


@pytest.fixture
def link():
    return Link()


@pytest.fixture
def resumes(monkeypatch):
    """Record every (message_id, force) the watchdog asks for; `ok` is what
    the handler answers, per message_id (default True)."""
    calls = []
    ok = {}

    def fake(download, force=False, count_retry=True):
        calls.append((download['message_id'], force))
        return ok.get(download['message_id'], True)

    monkeypatch.setattr(netwatch, 'resume_download', fake)
    calls_ns = SimpleNamespace(calls=calls, ok=ok)
    return calls_ns


@pytest.fixture
def emitted(monkeypatch):
    events = []
    monkeypatch.setattr(web_base, 'socketio',
                        SimpleNamespace(emit=lambda name, data: events.append((name, data))))
    return events


@pytest.fixture
def watchdog(db, link, resumes, emitted):
    """A watchdog with the stall sweep off (its own tests turn it on) that has
    already taken its first tick on an empty database, so nothing created by
    the test reads as a restart orphan."""
    w = netwatch.NetworkWatchdog(interval=1, stall_seconds=0, probe=link)
    w.tick(now=1000)
    return w


def running(db, name, bytes_=100, **over):
    kwargs = {'file': name, 'status': 'downloading', 'message_id': f'id-{name}',
              'downloaded_bytes': bytes_, 'downloaded_from': 'example.com',
              'url': f'https://x/{name}'}
    kwargs.update(over)
    return db.add_download(**kwargs)


def set_row(db, name, **changes):
    db.update_download_by_message_id(f'id-{name}', **changes)


# --- the probe -------------------------------------------------------------

def test_probe_is_true_when_any_host_answers(monkeypatch):
    attempted = []

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def connect(addr, timeout):
        attempted.append(addr)
        if addr[0] == 'dead':
            raise OSError('unreachable')
        return Conn()

    monkeypatch.setattr(netwatch.socket, 'create_connection', connect)
    assert netwatch.probe_connectivity([('dead', 53), ('alive', 53), ('never', 53)]) is True
    assert attempted == [('dead', 53), ('alive', 53)]       # stops at the first answer


def test_probe_is_false_when_every_host_refuses(monkeypatch):
    def refuse(addr, timeout):
        raise OSError('no route')
    monkeypatch.setattr(netwatch.socket, 'create_connection', refuse)
    assert netwatch.probe_connectivity([('a', 1), ('b', 2)]) is False


# --- an outage and the reconnect ------------------------------------------

def test_the_link_dropping_snapshots_every_running_download(watchdog, db, link):
    running(db, 'a', bytes_=10)
    running(db, 'b', bytes_=20)
    db.add_download(file='old', status='done', message_id='id-old')
    link.up = False
    watchdog.tick(now=1010)
    assert watchdog.online is False
    assert watchdog._interrupted == {'id-a': 10, 'id-b': 20}


def test_a_download_started_during_the_outage_is_a_candidate_too(watchdog, db, link):
    link.up = False
    watchdog.tick(now=1010)
    running(db, 'late', bytes_=0)
    watchdog.tick(now=1020)
    assert watchdog._interrupted == {'id-late': 0}


def test_the_snapshot_keeps_the_count_from_when_the_link_dropped(watchdog, db, link):
    running(db, 'a', bytes_=10)
    link.up = False
    watchdog.tick(now=1010)
    set_row(db, 'a', downloaded_bytes=15)      # a buffered write landing late
    watchdog.tick(now=1020)
    assert watchdog._interrupted == {'id-a': 10}


def test_nothing_is_judged_until_the_grace_period_has_passed(watchdog, db, link, resumes):
    running(db, 'a', bytes_=10)
    link.up = False
    watchdog.tick(now=1010)
    link.up = True
    watchdog.tick(now=1020)                     # back: arms the recheck
    assert watchdog.online is True
    assert watchdog._recheck_at == 1020 + netwatch.RECONNECT_GRACE
    watchdog.tick(now=1020 + netwatch.RECONNECT_GRACE - 1)
    assert resumes.calls == []
    assert watchdog._interrupted == {'id-a': 10}   # still pending


def test_after_the_grace_the_failed_and_the_frozen_are_resumed(watchdog, db, link, resumes):
    running(db, 'failed', bytes_=10)
    running(db, 'frozen', bytes_=20)
    running(db, 'moving', bytes_=30)
    running(db, 'finished', bytes_=40)
    running(db, 'user-stopped', bytes_=50)
    running(db, 'user-paused', bytes_=60)
    running(db, 'gone', bytes_=70)
    link.up = False
    watchdog.tick(now=1010)
    link.up = True
    watchdog.tick(now=1020)

    # What each one did while the link was back
    set_row(db, 'failed', status='failed', error='Telethon gave up')
    set_row(db, 'moving', downloaded_bytes=31)
    set_row(db, 'finished', status='done')
    set_row(db, 'user-stopped', status='stopped')
    set_row(db, 'user-paused', status='paused')
    set_row(db, 'gone', deleted_at=datetime.utcnow())

    watchdog.tick(now=1020 + netwatch.RECONNECT_GRACE)
    assert sorted(resumes.calls) == [('id-failed', False), ('id-frozen', True)]
    assert watchdog._interrupted == {}
    assert watchdog._recheck_at is None


def test_a_download_that_moved_during_the_outage_itself_is_left_alone(watchdog, db, link, resumes):
    """Telethon reconnects on its own; a transfer that is moving needs no help."""
    running(db, 'a', bytes_=10)
    link.up = False
    watchdog.tick(now=1010)
    link.up = True
    watchdog.tick(now=1020)
    set_row(db, 'a', downloaded_bytes=11)
    watchdog.tick(now=2000)
    assert resumes.calls == []


def test_a_second_outage_before_the_recheck_starts_over(watchdog, db, link, resumes):
    running(db, 'a', bytes_=10)
    link.up = False
    watchdog.tick(now=1010)
    link.up = True
    watchdog.tick(now=1020)
    link.up = False
    watchdog.tick(now=1030)                     # down again before the grace ran out
    assert watchdog._recheck_at is None
    assert watchdog._interrupted == {'id-a': 10}
    link.up = True
    watchdog.tick(now=1040)
    watchdog.tick(now=1040 + netwatch.RECONNECT_GRACE)
    assert resumes.calls == [('id-a', True)]


def test_a_stable_link_never_resumes_anything(watchdog, db, link, resumes):
    running(db, 'a', bytes_=10)
    for t in (1010, 1020, 1030, 1100):
        watchdog.tick(now=t)
    assert resumes.calls == []
    assert link.probes == 5


# --- restart orphans -------------------------------------------------------

def test_rows_left_downloading_by_a_restart_are_resumed_on_the_first_online_tick(db, link, resumes, emitted):
    running(db, 'a')
    running(db, 'b')
    db.add_download(file='s', status='stopped', message_id='id-s')
    db.add_download(file='p', status='paused', message_id='id-p')
    w = netwatch.NetworkWatchdog(stall_seconds=0, probe=link)
    w.tick(now=1000)
    assert sorted(resumes.calls) == [('id-a', False), ('id-b', False)]
    assert w._orphans == []
    w.tick(now=1020)
    assert len(resumes.calls) == 2               # resumed once, not every tick


def test_orphans_are_not_judged_while_the_link_is_down(db, link, resumes):
    running(db, 'a')
    link.up = False
    w = netwatch.NetworkWatchdog(stall_seconds=0, probe=link)
    w.tick(now=1000)
    assert w._orphans is None and resumes.calls == []
    link.up = True
    w.tick(now=1020)
    assert resumes.calls == [('id-a', False)]


def test_a_download_started_after_the_first_tick_is_not_an_orphan(db, link, resumes):
    w = netwatch.NetworkWatchdog(stall_seconds=0, probe=link)
    w.tick(now=1000)
    running(db, 'fresh')
    w.tick(now=1020)
    assert resumes.calls == []


def test_an_orphan_the_handler_declines_is_retried_then_marked_failed(db, link, resumes, emitted, monkeypatch):
    """Telethon may still be connecting on the first ticks; after
    STARTUP_RESUME_ATTEMPTS an honest failure beats a row downloading forever."""
    monkeypatch.setattr(netwatch, 'STARTUP_RESUME_ATTEMPTS', 3)
    running(db, 'tg', downloaded_from='telegram', url=None)
    resumes.ok['id-tg'] = False
    w = netwatch.NetworkWatchdog(stall_seconds=0, probe=link)
    w.tick(now=1000)
    w.tick(now=1020)
    assert resumes.calls == [('id-tg', False)] * 2
    assert db.get_download_by_message_id('id-tg')['status'] == 'downloading'
    assert w._orphans == ['id-tg']

    w.tick(now=1040)                            # the last try
    row = db.get_download_by_message_id('id-tg')
    assert row['status'] == 'failed' and 'restart' in row['error']
    assert row['speed'] == 0 and row['pending_time'] is None
    assert emitted == [('download:status', {'message_id': 'id-tg', 'status': 'failed'})]
    assert w._orphans == []
    w.tick(now=1060)
    assert len(resumes.calls) == 3


def test_an_orphan_that_comes_good_by_itself_is_dropped(db, link, resumes):
    running(db, 'a')
    resumes.ok['id-a'] = False
    w = netwatch.NetworkWatchdog(stall_seconds=0, probe=link)
    w.tick(now=1000)
    set_row(db, 'a', status='done')             # finished or dealt with by hand
    w.tick(now=1020)
    assert resumes.calls == [('id-a', False)]
    assert w._orphans == []


def test_marking_an_orphan_failed_works_without_a_socket(db, link, resumes, monkeypatch):
    monkeypatch.setattr(netwatch, 'STARTUP_RESUME_ATTEMPTS', 1)
    monkeypatch.setattr(web_base, 'socketio', None)
    running(db, 'a')
    resumes.ok['id-a'] = False
    w = netwatch.NetworkWatchdog(stall_seconds=0, probe=link)
    w.tick(now=1000)
    assert db.get_download_by_message_id('id-a')['status'] == 'failed'


# --- stalls ----------------------------------------------------------------

@pytest.fixture
def staller(db, link, resumes, emitted):
    w = netwatch.NetworkWatchdog(stall_seconds=100, probe=link)
    w.tick(now=1000)
    return w


def test_a_download_frozen_for_the_stall_window_is_force_restarted(staller, db, resumes):
    running(db, 'a', bytes_=10)
    staller.tick(now=1010)                      # first seen: a mark, no judgement
    staller.tick(now=1109)                      # 99s frozen: not yet
    assert resumes.calls == []
    staller.tick(now=1110)                      # 100s: restart it
    assert resumes.calls == [('id-a', True)]


def test_a_restarted_download_gets_a_fresh_window_before_the_next_restart(staller, db, resumes):
    running(db, 'a', bytes_=10)
    staller.tick(now=1010)
    staller.tick(now=1110)
    staller.tick(now=1120)                      # still 10 bytes: give it time
    staller.tick(now=1209)
    assert resumes.calls == [('id-a', True)]
    staller.tick(now=1210)
    assert resumes.calls == [('id-a', True), ('id-a', True)]


def test_moving_bytes_reset_the_mark(staller, db, resumes):
    running(db, 'a', bytes_=10)
    staller.tick(now=1010)
    set_row(db, 'a', downloaded_bytes=11)
    staller.tick(now=1100)                      # moved: new mark at 1100
    staller.tick(now=1190)                      # 90s since the move
    assert resumes.calls == []
    staller.tick(now=1200)
    assert resumes.calls == [('id-a', True)]


def test_a_download_past_99_percent_is_muxing_not_stalled(staller, db, resumes):
    running(db, 'a', bytes_=10, progress=99.4)
    staller.tick(now=1010)
    staller.tick(now=2000)
    assert resumes.calls == []


def test_a_download_at_98_percent_is_still_swept(staller, db, resumes):
    running(db, 'a', bytes_=10, progress=98)
    staller.tick(now=1010)
    staller.tick(now=2000)
    assert resumes.calls == [('id-a', True)]


def test_a_download_that_leaves_downloading_drops_out_of_the_sweep(staller, db, resumes):
    running(db, 'a', bytes_=10)
    staller.tick(now=1010)
    set_row(db, 'a', status='stopped')
    staller.tick(now=2000)
    assert resumes.calls == []
    assert staller._marks == {}
    # Coming back as a fresh download starts a fresh window
    set_row(db, 'a', status='downloading')
    staller.tick(now=2010)
    staller.tick(now=2100)
    assert resumes.calls == []
    staller.tick(now=2110)
    assert resumes.calls == [('id-a', True)]


def test_stall_seconds_zero_turns_the_sweep_off(db, link, resumes):
    w = netwatch.NetworkWatchdog(stall_seconds=0, probe=link)
    w.tick(now=1000)
    running(db, 'a', bytes_=10)
    for t in (1010, 5000, 90000):
        w.tick(now=t)
    assert resumes.calls == [] and w._marks == {}


def test_the_stall_sweep_does_not_run_while_offline(staller, db, link, resumes):
    running(db, 'a', bytes_=10)
    staller.tick(now=1010)
    link.up = False
    staller.tick(now=2000)
    assert resumes.calls == []


# --- stopped and paused are decisions --------------------------------------

def test_stopped_and_paused_downloads_are_never_auto_resumed(db, link, resumes):
    db.add_download(file='s', status='stopped', message_id='id-s', downloaded_bytes=5)
    db.add_download(file='p', status='paused', message_id='id-p', downloaded_bytes=5)
    w = netwatch.NetworkWatchdog(stall_seconds=10, probe=link)
    w.tick(now=1000)                            # restart orphans: none
    link.up = False
    w.tick(now=1010)
    link.up = True
    w.tick(now=1020)
    w.tick(now=1020 + netwatch.RECONNECT_GRACE)  # reconnect: nothing was in flight
    w.tick(now=5000)                            # stall sweep: not downloading
    assert resumes.calls == []
    assert w._interrupted == {} and w._marks == {}


# --- the thread ------------------------------------------------------------

def test_the_thread_survives_a_failing_tick_and_can_be_joined(monkeypatch, link, resumes, caplog):
    """A real thread on purpose: the watchdog once kept its stop flag in
    `self._stop`, shadowing threading.Thread's private `_stop()` method, so
    join()/is_alive() on a finished watchdog raised TypeError."""
    monkeypatch.setattr(netwatch.time, 'sleep', lambda s: None)   # the startup grace
    w = netwatch.NetworkWatchdog(interval=0.01, stall_seconds=0, probe=link)
    assert w.daemon and w.name == 'net-watchdog'
    ticks = []

    def tick(now=None):
        ticks.append(1)
        if len(ticks) == 1:
            raise RuntimeError('db not up yet')
        w.stop()

    monkeypatch.setattr(w, 'tick', tick)
    with caplog.at_level('WARNING', logger='backend.netwatch'):
        w.start()
        w.join(timeout=5)
    assert not w.is_alive()
    assert len(ticks) == 2
    assert 'db not up yet' in caplog.text


def test_stop_ends_the_loop_without_a_tick_in_between(monkeypatch, link):
    monkeypatch.setattr(netwatch.time, 'sleep', lambda s: None)
    w = netwatch.NetworkWatchdog(interval=0.01, stall_seconds=0, probe=link)
    monkeypatch.setattr(w, 'tick', lambda now=None: pytest.fail('ticked after stop()'))
    w.stop()
    w.run()                                     # inline: returns at once
    assert link.probes == 0


def test_the_sweep_skips_a_row_with_no_message_id(staller, resumes, monkeypatch):
    monkeypatch.setattr(staller, '_downloading',
                        lambda: [{'message_id': None, 'downloaded_bytes': 1, 'status': 'downloading'}])
    staller.tick(now=1010)
    staller.tick(now=2000)
    assert resumes.calls == [] and staller._marks == {}

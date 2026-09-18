"""Unattended logic: when a scheduled job fires, and when the torrent watcher
stops a seed. Both run with nobody watching, so the edges matter."""
from datetime import datetime
from unittest import mock

import pytest

from backend import jobs, torrent_watch


def entry(**over):
    base = {'enabled': True, 'time': '03:00', 'days': list(range(7))}
    base.update(over)
    return base


# --- next_run -------------------------------------------------------------

def test_a_disabled_schedule_never_fires():
    assert jobs.next_run(entry(enabled=False)) is None


def test_next_run_is_later_today_when_the_slot_is_ahead():
    now = datetime(2026, 9, 18, 1, 0)            # Friday 01:00
    assert jobs.next_run(entry(time='03:00'), now) == datetime(2026, 9, 18, 3, 0)


def test_next_run_rolls_to_tomorrow_once_the_slot_has_passed():
    now = datetime(2026, 9, 18, 4, 0)
    assert jobs.next_run(entry(time='03:00'), now) == datetime(2026, 9, 19, 3, 0)


def test_next_run_skips_to_the_next_selected_weekday():
    now = datetime(2026, 9, 18, 4, 0)            # Friday, weekday 4
    got = jobs.next_run(entry(time='03:00', days=[0]), now)   # Mondays only
    assert got == datetime(2026, 9, 21, 3, 0)
    assert got.weekday() == 0


def test_an_unparseable_time_never_fires():
    for bad in ('nonsense', '', None, '25:00'):
        assert jobs.next_run(entry(time=bad)) is None


def test_no_days_selected_means_every_day():
    now = datetime(2026, 9, 18, 1, 0)
    assert jobs.next_run(entry(days=[]), now) == datetime(2026, 9, 18, 3, 0)


# --- due-ness -------------------------------------------------------------

def test_a_job_is_not_due_on_an_unselected_day():
    now = datetime(2026, 9, 18, 3, 1)            # Friday
    assert jobs._is_due(entry(time='03:00', days=[0]), now) is False


def test_a_disabled_job_is_never_due():
    assert jobs._is_due(entry(enabled=False), datetime(2026, 9, 18, 3, 1)) is False


# --- torrent watcher ------------------------------------------------------

def torrent(hash_, status, pct=100.0, name=None):
    return {'hash': hash_, 'status': status, 'percent_done': pct,
            'name': name or hash_}


@pytest.fixture
def watcher(monkeypatch):
    calls = []
    listings = {}

    monkeypatch.setattr(torrent_watch, 'read_torrent_settings',
                        lambda: {'transmission': {'url': 'http://t'},
                                 'qbittorrent': {'url': 'http://q'}})
    monkeypatch.setattr(torrent_watch, 'load_torrent_config', lambda c: {'client': c})
    monkeypatch.setattr(torrent_watch, 'torrent_list',
                        lambda c, config=None: listings.get(c, []))
    monkeypatch.setattr(torrent_watch, 'torrent_control',
                        lambda c, a, h, config=None: calls.append((c, a, tuple(h))))
    w = torrent_watch.TorrentWatcher()
    return w, listings, calls


def test_a_seeding_torrent_is_stopped(watcher):
    w, listings, calls = watcher
    listings['qbittorrent'] = [torrent('a', 'seeding')]
    w.tick()
    assert calls == [('qbittorrent', 'stop', ('a',))]


def test_a_queued_seed_is_stopped_too(watcher):
    w, listings, calls = watcher
    listings['qbittorrent'] = [torrent('a', 'seed-wait')]
    w.tick()
    assert calls == [('qbittorrent', 'stop', ('a',))]


@pytest.mark.parametrize('status', ['downloading', 'download-wait', 'stopped', 'completed'])
def test_anything_not_seeding_is_left_alone(watcher, status):
    w, listings, calls = watcher
    listings['qbittorrent'] = [torrent('a', status, pct=50.0)]
    w.tick()
    assert calls == []


def test_a_torrent_being_moved_is_left_alone(watcher):
    """qBittorrent reports `moving` (normalized to checking) while it shifts
    files out of the temp dir; stopping there would race the move."""
    w, listings, calls = watcher
    listings['qbittorrent'] = [torrent('a', 'checking')]
    w.tick()
    assert calls == []


def test_a_torrent_is_only_stopped_once(watcher):
    """Restarting a completed torrent by hand must stick, not be undone on the
    next tick."""
    w, listings, calls = watcher
    listings['qbittorrent'] = [torrent('a', 'seeding')]
    w.tick()
    listings['qbittorrent'] = [torrent('a', 'seeding')]   # user started it again
    w.tick()
    assert len(calls) == 1


def test_a_removed_torrent_is_forgotten(watcher):
    w, listings, calls = watcher
    listings['qbittorrent'] = [torrent('a', 'seeding')]
    w.tick()
    listings['qbittorrent'] = []
    w.tick()
    assert w._handled == set()


def test_a_client_that_opted_out_is_skipped(watcher, monkeypatch):
    w, listings, calls = watcher
    monkeypatch.setattr(torrent_watch, 'read_torrent_settings',
                        lambda: {'transmission': {'url': 'http://t', 'stop_on_complete': False},
                                 'qbittorrent': {}})
    listings['transmission'] = [torrent('a', 'seeding')]
    w.tick()
    assert calls == []


def test_an_unconfigured_client_is_skipped(watcher, monkeypatch):
    w, listings, calls = watcher
    monkeypatch.setattr(torrent_watch, 'read_torrent_settings',
                        lambda: {'transmission': {}, 'qbittorrent': {}})
    listings['transmission'] = [torrent('a', 'seeding')]
    w.tick()
    assert calls == []


def test_one_unreachable_client_does_not_stop_the_other(watcher, monkeypatch):
    w, listings, calls = watcher

    def flaky(client, config=None):
        if client == 'transmission':
            raise OSError('connection refused')
        return [torrent('b', 'seeding')]

    monkeypatch.setattr(torrent_watch, 'torrent_list', flaky)
    w.tick()
    assert calls == [('qbittorrent', 'stop', ('b',))]


def test_a_failed_stop_is_retried_next_tick(watcher, monkeypatch):
    w, listings, calls = watcher
    listings['qbittorrent'] = [torrent('a', 'seeding')]
    monkeypatch.setattr(torrent_watch, 'torrent_control',
                        mock.Mock(side_effect=ValueError('nope')))
    w.tick()
    assert w._handled == set()          # not marked handled, so it comes back
    monkeypatch.setattr(torrent_watch, 'torrent_control',
                        lambda c, a, h, config=None: calls.append((c, a, tuple(h))))
    w.tick()
    assert calls == [('qbittorrent', 'stop', ('a',))]


def test_a_failing_tick_never_kills_the_thread(watcher, monkeypatch):
    w, _listings, _calls = watcher
    monkeypatch.setattr(torrent_watch, 'read_torrent_settings',
                        mock.Mock(side_effect=RuntimeError('db down')))
    with pytest.raises(RuntimeError):
        w.tick()                         # tick itself propagates...
    # ...and run() is what swallows it; assert the guard exists rather than
    # starting a real thread in a test.
    import inspect
    assert 'except Exception' in inspect.getsource(torrent_watch.TorrentWatcher.run)

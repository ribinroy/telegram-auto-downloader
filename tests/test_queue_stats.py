"""The header's "to download" total and the queue ETA (WebApp.get_stats),
and sizing a VPS pull that joins the queue without a size."""
import backend.remote_files as remote_files
from backend.vps_handler import VpsDownloader


def _add(db, mid, status, total, done=0, speed=0):
    db.add_download(file=f'{mid}.mkv', status=status, downloaded_from='telegram',
                    message_id=mid, total_bytes=total, downloaded_bytes=done, speed=speed)


def test_stats_count_waiting_downloads_into_total_and_eta(app, db):
    _add(db, 'run', 'downloading', total=3 * 1024 ** 2, done=1024 ** 2, speed=1024)  # 1 MB/s
    _add(db, 'wait', 'waiting', total=4 * 1024 ** 2)
    _add(db, 'stop', 'stopped', total=50 * 1024 ** 2)   # a decision - not in the queue

    stats = app.get_stats()

    assert stats['running_bytes'] == 2 * 1024 ** 2
    assert stats['waiting_bytes'] == 4 * 1024 ** 2
    assert stats['remaining_bytes'] == 6 * 1024 ** 2
    assert (stats['running_count'], stats['waiting_count']) == (1, 1)
    assert stats['eta_seconds'] == 6            # 6 MB at 1 MB/s
    assert stats['unsized_count'] == 0


def test_stats_flag_waiting_downloads_with_no_size(app, db):
    _add(db, 'run', 'downloading', total=1024, speed=1)
    _add(db, 'folder', 'waiting', total=0)

    stats = app.get_stats()

    assert stats['unsized_count'] == 1
    assert stats['remaining_bytes'] == 1024


def test_no_eta_while_nothing_moves(app, db):
    _add(db, 'wait', 'waiting', total=1024)
    assert app.get_stats()['eta_seconds'] is None


def test_waiting_vps_pull_gets_measured(db, monkeypatch):
    monkeypatch.setattr(remote_files, 'dir_size', lambda path: {'size': 777})
    db.add_download(file='Show', status='waiting', downloaded_from='vps',
                    message_id='v-1', url='/remote/Show', total_bytes=0)
    vps = VpsDownloader({})
    emitted = []
    monkeypatch.setattr(vps, 'emit_progress', lambda *a: emitted.append(a))

    vps._measure_waiting('v-1', '/remote/Show')

    assert db.get_download_by_message_id('v-1')['total_bytes'] == 777
    assert emitted and emitted[0][3] == 777


def test_measuring_never_overwrites_a_started_pull(db, monkeypatch):
    # By the time du answers the pull may have started and planned its own size.
    monkeypatch.setattr(remote_files, 'dir_size', lambda path: {'size': 777})
    db.add_download(file='Show', status='downloading', downloaded_from='vps',
                    message_id='v-2', url='/remote/Show', total_bytes=500)

    VpsDownloader({})._measure_waiting('v-2', '/remote/Show')

    assert db.get_download_by_message_id('v-2')['total_bytes'] == 500


def test_measuring_survives_an_unreachable_vps(db, monkeypatch):
    def boom(path):
        raise OSError('no route to host')
    monkeypatch.setattr(remote_files, 'dir_size', boom)
    db.add_download(file='Show', status='waiting', downloaded_from='vps',
                    message_id='v-3', url='/remote/Show', total_bytes=0)

    VpsDownloader({})._measure_waiting('v-3', '/remote/Show')

    assert db.get_download_by_message_id('v-3')['total_bytes'] == 0

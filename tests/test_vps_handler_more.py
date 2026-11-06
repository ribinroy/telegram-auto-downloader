"""The rest of the VPS handler: starting, resuming and stopping pulls, the
writer claim between two transfers, torrent temp-dir lookup, unknown-size
files, remote delete, autoSync. No seedbox - every remote side is a FakeSFTP
handed to the handler through `_open_sftp`, and no sleep is real."""
import json
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest

from backend import vps_handler
from backend.vps_handler import VpsDownloader, _Cancelled
from tests.conftest import FakeSFTP


def own_time(monkeypatch, module, **overrides):
    """Give `module` its own copy of the time module with some functions
    replaced, so the patch is invisible to every other thread in the process."""
    import time as _time
    import types as _types
    ns = _types.SimpleNamespace(**{k: getattr(_time, k) for k in dir(_time) if not k.startswith('_')})
    for k, v in overrides.items():
        setattr(ns, k, v)
    monkeypatch.setattr(module, 'time', ns)
    return ns

REMOTE = '/home6/tester/downloads/Show'
TREE = {
    '/home6/tester/downloads': {'Show': None, 'movie.mkv': 6, 'stream.bin': 0},
    REMOTE: {'ep01.mkv': 10, 'ep02.mkv': 10, 'Extras': None},
    REMOTE + '/Extras': {'sample.mkv': 4},
}


class ReadableSFTP(FakeSFTP):
    """FakeSFTP whose files can be read: every byte is b'y'. `readv` (sized
    files) and `seek`/`read` (unknown size) are both offered, and every read
    is recorded. `on_read(path)` runs before each read, so a test can act
    mid-transfer."""

    def __init__(self, tree, on_read=None, stream_bytes=b''):
        super().__init__(tree)
        self.reads = []
        self.on_read = on_read
        self.stream_bytes = stream_bytes

    def open(self, path, mode='rb'):
        sftp = self

        class _File:
            pos = 0

            def readv(self, chunks):
                if sftp.on_read:
                    sftp.on_read(path)
                sftp.reads.append((path, sum(n for _off, n in chunks)))
                return [b'y' * n for _off, n in chunks]

            def seek(self, off):
                self.pos = off

            def read(self, n):
                data = sftp.stream_bytes[self.pos:self.pos + n]
                self.pos += len(data)
                sftp.reads.append((path, len(data)))
                return data

            def close(self):
                pass

        return _File()


class Client:
    def __init__(self, on_close=None, close_raises=False):
        self.closed = False
        self.on_close = on_close
        self.close_raises = close_raises

    def close(self):
        self.closed = True
        if self.on_close:
            self.on_close()
        if self.close_raises:
            raise RuntimeError('already closed')


@pytest.fixture
def handler():
    return VpsDownloader(download_tasks={})


@pytest.fixture
def sftp():
    return ReadableSFTP(TREE)


def wire(handler, sftp, client=None):
    client = client or Client()
    handler._open_sftp = lambda timeout=15: (client, sftp)
    return client


@pytest.fixture
def pull(db, tmp_path):
    """A stopped folder pull: ep01 whole, ep02 half there, Extras missing."""
    dest = tmp_path / 'tv'
    (dest / 'Show').mkdir(parents=True)
    (dest / 'Show' / 'ep01.mkv').write_bytes(b'x' * 10)
    (dest / 'Show' / 'ep02.mkv').write_bytes(b'x' * 5)
    return db.add_download(file='Show', status='stopped', downloaded_from='vps',
                           message_id='p-1', url=REMOTE, dest_base=str(dest))


@pytest.fixture
def socket(monkeypatch):
    """A recording stand-in for the Socket.IO server, plus a web app whose
    emit_stats is counted - so the emit helpers run their real bodies."""
    from backend.web_app import base
    events = []

    class Sio:
        def emit(self, event, data):
            events.append((event, data))

    class Web:
        stats = 0
        deleted = []

        def emit_stats(self):
            Web.stats += 1

        def emit_deleted(self, message_id):
            Web.deleted.append(message_id)

    monkeypatch.setattr(base, 'socketio', Sio())
    monkeypatch.setattr(base, '_web_app', Web())
    return events


# --- emit helpers / SFTP opening -------------------------------------------

def test_emit_helpers_broadcast_and_refresh_stats(handler, socket):
    handler.emit_progress('m', 50, 5, 10, 1.0, 5)
    handler.emit_status('m', 'failed', error='boom')
    handler.emit_status('m', 'done')
    handler.emit_file_count('m', 3)
    handler.emit_new_download({'message_id': 'm'})
    assert [e for e, _d in socket] == ['download:progress', 'download:status', 'download:status',
                                        'download:files', 'download:new']
    assert socket[1][1] == {'message_id': 'm', 'status': 'failed', 'error': 'boom'}
    assert 'error' not in socket[2][1]
    from backend.web_app import base
    assert base._web_app.stats == 4          # progress, both statuses, new (not the file count)


def test_open_sftp_uses_the_saved_connection(handler, monkeypatch):
    import backend.web_app as web
    monkeypatch.setattr(web, 'open_vps_sftp', lambda timeout=10: ('client', f'sftp@{timeout}'))
    assert handler._open_sftp(timeout=7) == ('client', 'sftp@7')


# --- start_download ---------------------------------------------------------

def test_start_download_needs_a_path_and_refuses_a_live_duplicate(db, handler, pull):
    assert handler.start_download('  ') == {'error': 'remote path is required'}
    assert handler.start_download(REMOTE) == {'error': 'This item is already downloaded'}


def test_a_finished_pull_whose_copy_is_gone_is_retired_and_pulled_again(db, handler, sftp, tmp_path, socket):
    db.add_download(file='movie.mkv', status='done', downloaded_from='vps',
                    message_id='old', url='/home6/tester/downloads/movie.mkv',
                    dest_base=str(tmp_path / 'gone'))
    wire(handler, sftp)
    new = handler.start_download('/home6/tester/downloads/movie.mkv', size=6, dest=str(tmp_path / 'vps'))
    assert new.get('error') is None and new['message_id'] != 'old'
    handler.threads[new['message_id']].join(5)
    assert db.get_download_by_message_id('old')['deleted_at'] is not None     # soft-deleted
    assert db.get_vps_downloads_for_path('/home6/tester/downloads/movie.mkv')[0]['message_id'] != 'old'
    from backend.web_app import base
    assert base._web_app.deleted == ['old']
    assert socket[0][0] == 'download:new'
    record = db.get_download_by_message_id(new['message_id'])
    assert record['status'] == 'done' and record['total_bytes'] == 6
    assert (tmp_path / 'vps' / 'movie.mkv').read_bytes() == b'y' * 6
    assert not handler.threads and not handler.download_tasks


def test_a_single_file_pull_lands_under_the_vps_default_folder_renamed(db, handler, sftp, socket):
    """No dest and no spec: DOWNLOAD_DIR/VPS, and the rename rule applied
    to the file itself (a folder pull only renames its top folder)."""
    from backend.config import DOWNLOAD_DIR
    from backend.rename import invalidate_rules_cache
    db.add_rename_rule(r'movie', 'Film', name='title')
    invalidate_rules_cache()
    try:
        wire(handler, sftp)
        new = handler.start_download('/home6/tester/downloads/movie.mkv', size=6)
        handler.threads[new['message_id']].join(5)
    finally:
        invalidate_rules_cache()
    assert new['file'] == 'Film.mkv'
    assert (DOWNLOAD_DIR / 'VPS' / 'Film.mkv').read_bytes() == b'y' * 6
    assert db.get_download_by_message_id(new['message_id'])['status'] == 'done'


def test_a_queued_folder_pull_is_measured_in_the_background(db, handler, monkeypatch):
    from backend import download_queue
    measured = threading.Event()
    seen = {}

    def waiting(source, create):
        return create('waiting', 1), False
    monkeypatch.setattr(download_queue, 'admit', waiting)
    monkeypatch.setattr(handler, '_measure_waiting',
                        lambda mid, path: (seen.update(mid=mid, path=path), measured.set()))
    new = handler.start_download(REMOTE)
    assert new['status'] == 'waiting'
    assert measured.wait(5) and seen == {'mid': new['message_id'], 'path': REMOTE}


def test_measure_waiting_fills_the_size_of_a_waiting_pull_only(db, handler, monkeypatch, socket):
    import backend.remote_files as rfs
    sizes = {'size': 1234}
    monkeypatch.setattr(rfs, 'dir_size', lambda path: sizes)
    db.add_download(file='Show', status='waiting', downloaded_from='vps', message_id='w-1', url=REMOTE)
    handler._measure_waiting('w-1', REMOTE)
    assert db.get_download_by_message_id('w-1')['total_bytes'] == 1234
    assert socket[-1][0] == 'download:progress' and socket[-1][1]['total_bytes'] == 1234

    # Already sized: the transfer's own figure is never overwritten
    handler._measure_waiting('w-1', REMOTE)
    assert db.get_download_by_message_id('w-1')['total_bytes'] == 1234
    # Not waiting any more
    db.add_download(file='S2', status='downloading', downloaded_from='vps', message_id='w-2', url=REMOTE)
    handler._measure_waiting('w-2', REMOTE)
    assert db.get_download_by_message_id('w-2')['total_bytes'] == 0
    # Nothing to say, or the VPS out of reach: left alone, no error
    db.add_download(file='S3', status='waiting', downloaded_from='vps', message_id='w-3', url=REMOTE)
    sizes['size'] = 0
    handler._measure_waiting('w-3', REMOTE)

    def boom(path):
        raise OSError('unreachable')
    monkeypatch.setattr(rfs, 'dir_size', boom)
    handler._measure_waiting('w-3', REMOTE)
    assert db.get_download_by_message_id('w-3')['total_bytes'] == 0


# --- resume / spawn / stop --------------------------------------------------

def test_resume_download_restarts_from_the_record(db, handler, pull, monkeypatch, socket):
    spawned = []
    monkeypatch.setattr(handler, '_spawn', lambda *a: spawned.append(a))
    assert handler.resume_download('nope') is False
    db.add_download(file='a.mkv', status='failed', downloaded_from='telegram', message_id='t-1')
    assert handler.resume_download('t-1') is False       # not a VPS pull

    handler.cancelled.add('p-1')
    assert handler.resume_download('p-1') is True
    assert spawned == [(REMOTE, 'p-1', pull['dest_base'])]
    assert 'p-1' not in handler.cancelled
    assert db.get_download_by_message_id('p-1')['status'] == 'downloading'
    assert socket[-1] == ('download:status', {'message_id': 'p-1', 'status': 'downloading'})

    # Already running: nothing to do, still True
    gate = threading.Event()
    running = threading.Thread(target=gate.wait, daemon=True)
    running.start()
    handler.threads['p-1'] = running
    try:
        assert handler.resume_download('p-1') is True
        assert len(spawned) == 1
    finally:
        gate.set()


def test_spawn_registers_the_thread_under_both_maps(handler, monkeypatch):
    done = threading.Event()
    monkeypatch.setattr(handler, '_download', lambda *a: done.set())
    handler._spawn(REMOTE, 'm-1', None)
    assert done.wait(5)
    assert set(handler.threads) == {'m-1'} and set(handler.download_tasks) == {'m-1'}
    handler.threads['m-1'].join(5)


def test_stop_download_of_an_idle_id_clears_a_stale_cancel(handler):
    handler.cancelled.add('gone')
    assert handler.stop_download('gone') is True
    assert 'gone' not in handler.cancelled


def test_stop_download_force_closes_a_wedged_transfer(db, handler, pull, socket):
    """A transfer stuck in a blocking SFTP read ignores the cancel flag; the
    SSH client is closed under it, and that is reported as a stop."""
    stuck = threading.Event()
    started = threading.Event()

    class WedgedSFTP(ReadableSFTP):
        def open(self, path, mode='rb'):
            class _File:
                def readv(self, chunks):
                    started.set()
                    stuck.wait(10)
                    raise OSError('Socket is closed')

                def close(self):
                    pass
            return _File()

    sftp = WedgedSFTP(TREE)
    # The client's close raises too (paramiko does when the transport is
    # already dead): neither the stop nor the transfer's cleanup minds.
    wire(handler, sftp, Client(on_close=stuck.set, close_raises=True))
    handler._spawn(REMOTE, 'p-1', pull['dest_base'])
    assert started.wait(5)
    assert handler.stop_download('p-1', timeout=5) is True
    assert db.get_download_by_message_id('p-1')['status'] == 'stopped'
    assert 'p-1' not in handler.threads and 'p-1' not in handler.clients


def test_a_cancel_before_the_first_file_stops_the_pull(db, handler, pull, sftp):
    wire(handler, sftp)
    handler.cancelled.add('p-1')
    handler._download(REMOTE, 'p-1', pull['dest_base'])
    assert sftp.reads == []
    assert db.get_download_by_message_id('p-1')['status'] == 'stopped'
    assert 'p-1' not in handler.cancelled


def test_a_cancel_mid_file_keeps_the_partial_and_stops(db, handler, pull, monkeypatch):
    monkeypatch.setattr(vps_handler, 'TRANSFER_CHUNK', 2)
    monkeypatch.setattr(vps_handler, 'TRANSFER_BATCH', 1)
    sftp = ReadableSFTP(TREE, on_read=lambda path: handler.cancelled.add('p-1'))
    wire(handler, sftp)
    handler._download(REMOTE, 'p-1', pull['dest_base'])
    assert (Path(pull['dest_base']) / 'Show' / 'ep02.mkv').stat().st_size == 7
    assert db.get_download_by_message_id('p-1')['status'] == 'stopped'


def test_an_error_mid_transfer_fails_the_pull_with_its_reason(db, handler, pull, socket):
    class BrokenSFTP(ReadableSFTP):
        def open(self, path, mode='rb'):
            raise OSError('Connection reset by peer')

    wire(handler, BrokenSFTP(TREE), Client(close_raises=True))
    handler._download(REMOTE, 'p-1', pull['dest_base'])
    record = db.get_download_by_message_id('p-1')
    assert record['status'] == 'failed' and 'reset by peer' in record['error']
    assert socket[-1][1] == {'message_id': 'p-1', 'status': 'failed', 'error': 'Connection reset by peer'}


def test_a_finished_video_is_handed_to_the_metadata_extractor(db, handler, sftp, tmp_path, monkeypatch):
    handed = []

    def fake_run(coro, loop):
        coro.close()
        handed.append(loop)
    monkeypatch.setattr(vps_handler.asyncio, 'run_coroutine_threadsafe', fake_run)
    handler.loop = object()
    db.add_download(file='movie.mkv', status='downloading', downloaded_from='vps',
                    message_id='v-1', url='/home6/tester/downloads/movie.mkv', dest_base=str(tmp_path))
    wire(handler, sftp)
    handler._download('/home6/tester/downloads/movie.mkv', 'v-1', str(tmp_path))
    assert handed == [handler.loop]
    assert db.get_download_by_message_id('v-1')['status'] == 'done'


# --- the writer claim -------------------------------------------------------

def test_a_file_another_transfer_is_writing_is_waited_for_then_finished(db, handler, pull, monkeypatch):
    """A per-file pull holds ep02; the folder pull waits, counts what the
    other wrote meanwhile, and fetches only the rest."""
    ep02 = Path(pull['dest_base']) / 'Show' / 'ep02.mkv'
    owner = threading.Thread(target=lambda: None)
    handler.threads['other'] = owner                       # "alive" as far as the map goes
    handler.writing[str(ep02)] = 'other'
    slept = []

    def other_finishes(_secs):
        slept.append(1)
        with open(ep02, 'ab') as f:
            f.write(b'o' * 3)                              # the other pull wrote 3 more
        handler.threads.pop('other', None)                 # ...and exited
    own_time(monkeypatch, vps_handler, sleep=other_finishes)
    sftp = ReadableSFTP(TREE)
    wire(handler, sftp)
    handler._download(REMOTE, 'p-1', pull['dest_base'])
    assert slept == [1]
    assert (REMOTE + '/ep02.mkv', 2) in sftp.reads         # 10 - 8 left
    assert ep02.read_bytes() == b'x' * 5 + b'o' * 3 + b'y' * 2
    record = db.get_download_by_message_id('p-1')
    assert record['status'] == 'done' and record['downloaded_bytes'] == 24
    assert str(ep02) not in handler.writing


def test_a_stop_while_waiting_for_the_claim_is_honoured(db, handler, pull, monkeypatch):
    ep02 = Path(pull['dest_base']) / 'Show' / 'ep02.mkv'
    handler.threads['other'] = threading.Thread(target=lambda: None)
    handler.writing[str(ep02)] = 'other'
    own_time(monkeypatch, vps_handler, sleep=lambda _s: handler.cancelled.add('p-1'))
    sftp = ReadableSFTP(TREE)
    wire(handler, sftp)
    handler._download(REMOTE, 'p-1', pull['dest_base'])
    assert sftp.reads == []
    assert db.get_download_by_message_id('p-1')['status'] == 'stopped'
    assert handler.writing[str(ep02)] == 'other'           # never taken over


def test_claim_takes_over_from_an_owner_that_is_gone(handler, tmp_path):
    handler.writing[str(tmp_path / 'f')] = 'dead'           # not in handler.threads
    assert handler._claim(tmp_path / 'f', 'me') is False
    assert handler.writing[str(tmp_path / 'f')] == 'me'
    handler._release(tmp_path / 'f', 'someone-else')        # not the owner: no-op
    assert str(tmp_path / 'f') in handler.writing
    handler._release(tmp_path / 'f', 'me')
    assert str(tmp_path / 'f') not in handler.writing


# --- the plan: torrent temp dirs, unknown sizes ---------------------------

def test_a_file_the_torrent_client_has_not_moved_yet_is_read_from_its_temp_dir(
        db, handler, tmp_path, monkeypatch):
    import backend.web_app.torrent as torrent
    final = '/home6/tester/downloads/done/Show/ep01.mkv'
    temp = '/home6/tester/downloads/incomplete/Show/ep01.mkv'
    tree = {'/home6/tester/downloads/incomplete/Show': {'ep01.mkv': 10}}
    asked = []

    def locate(path, sftp):
        asked.append(path)
        return temp
    monkeypatch.setattr(torrent, 'locate_torrent_file', locate)
    db.add_download(file='ep01.mkv', status='downloading', downloaded_from='vps',
                    message_id='f-1', url=final, dest_base=str(tmp_path / 'Show'))
    sftp = ReadableSFTP(tree)
    wire(handler, sftp)
    handler._download(final, 'f-1', str(tmp_path / 'Show'))
    assert asked == [final]
    assert sftp.reads == [(temp, 10)]
    assert (tmp_path / 'Show' / 'ep01.mkv').read_bytes() == b'y' * 10
    assert db.get_download_by_message_id('f-1')['status'] == 'done'


def test_a_file_missing_everywhere_fails_the_pull(db, handler, tmp_path, monkeypatch):
    import backend.web_app.torrent as torrent
    monkeypatch.setattr(torrent, 'locate_torrent_file', lambda path, sftp: None)
    db.add_download(file='ep01.mkv', status='downloading', downloaded_from='vps',
                    message_id='f-2', url='/home6/tester/gone.mkv', dest_base=str(tmp_path))
    wire(handler, ReadableSFTP(TREE))
    handler._download('/home6/tester/gone.mkv', 'f-2', str(tmp_path))
    record = db.get_download_by_message_id('f-2')
    assert record['status'] == 'failed' and 'No such file' in record['error']


def test_a_file_of_unknown_size_is_read_sequentially_to_eof(handler, tmp_path):
    sftp = ReadableSFTP(TREE, stream_bytes=b'abcdef')
    local = tmp_path / 'stream.bin'
    local.write_bytes(b'ab')
    bumped = []
    handler._transfer_file(sftp, '/home6/tester/downloads/stream.bin', local, 0, bumped.append)
    assert local.read_bytes() == b'abcdef' and sum(bumped) == 4   # resumed from byte 2
    # Already whole: nothing is read at all
    sftp.reads.clear()
    handler._transfer_file(sftp, '/home6/tester/downloads/movie.mkv', local, 6, bumped.append)
    assert sftp.reads == []


def test_local_destination_mirrors_the_full_path_without_a_prefix(handler, tmp_path):
    assert handler._local_destination('/a/b/c.mkv', tmp_path) == tmp_path / 'a/b/c.mkv'
    assert handler._local_destination('/a/b/c.mkv', tmp_path, '/a', 'Renamed') == tmp_path / 'Renamed/c.mkv'
    assert handler._local_destination('/a/b/c.mkv', tmp_path, local_name='x') == tmp_path / 'x/b/c.mkv'


def test_walk_skips_dot_entries(handler):
    import stat as st

    class Dotty(FakeSFTP):
        def listdir_attr(self, path):
            out = super().listdir_attr(path)
            for name in ('.', '..'):
                attr = type('Attr', (), {})()
                attr.filename, attr.st_mode, attr.st_size = name, st.S_IFDIR | 0o755, 0
                out.append(attr)
            return out
    found = []
    handler._walk(Dotty(TREE), REMOTE, found)
    assert sorted(p for p, _s in found) == [REMOTE + '/Extras/sample.mkv', REMOTE + '/ep01.mkv', REMOTE + '/ep02.mkv']
    assert handler._list_files(Dotty(TREE), REMOTE) == ['ep01.mkv', 'ep02.mkv']


# --- file status / listing without the VPS -----------------------------------

def test_set_files_status_rejects_an_unknown_state_and_edits_the_live_dict(db, handler, pull):
    with pytest.raises(ValueError):
        handler.set_files_status(pull, ['ep02.mkv'], 'gone')
    handler.file_status['p-1'] = {'ep01.mkv': 'skipped'}
    out = handler.set_files_status(pull, ['ep02.mkv', '', 7], 'paused')
    assert out == {'file_status': {'ep02.mkv': 'paused'}, 'running': False}
    assert handler.file_status['p-1'] == {'ep01.mkv': 'skipped', 'ep02.mkv': 'paused'}
    pull = db.get_download_by_message_id('p-1')
    out = handler.set_files_status(pull, ['ep02.mkv'], None)
    assert out['file_status'] == {} and handler.file_status['p-1'] == {'ep01.mkv': 'skipped'}
    assert db.get_download_by_message_id('p-1')['file_status'] == {}


def test_remaining_is_unknown_when_only_the_local_side_can_be_listed(handler, pull, monkeypatch):
    @contextmanager
    def unreachable(timeout=15):
        raise OSError('down')
        yield  # pragma: no cover
    monkeypatch.setattr('backend.web_app.vps.vps_session', unreachable)
    assert handler.remaining(pull) == (None, 0)


def test_local_listing_of_a_single_file_and_of_nothing(db, handler, tmp_path):
    (tmp_path / 'movie.mkv').write_bytes(b'z' * 6)
    single = db.add_download(file='movie.mkv', status='done', downloaded_from='vps',
                             message_id='s-1', url='/x/movie.mkv', dest_base=str(tmp_path))
    got = handler._local_listing(single)
    assert got == {'is_dir': False, 'files': [{'path': 'movie.mkv', 'size': 6, 'local_size': 6,
                                               'state': 'on_disk', 'local_path': str(tmp_path / 'movie.mkv')}]}
    gone = db.add_download(file='Missing', status='stopped', downloaded_from='vps', message_id='s-2',
                           url='/x/Missing', dest_base=str(tmp_path))
    assert handler._local_listing(gone) == {'is_dir': False, 'files': []}
    db.update_download_by_message_id('s-2', file_count=3)
    assert handler._local_listing(db.get_download_by_message_id('s-2'))['is_dir'] is True
    assert handler._local_listing({'file': ''}) == {'is_dir': False, 'files': []}


# --- remote delete ------------------------------------------------------------

def test_delete_remote_removes_a_file_or_a_whole_tree(handler):
    import stat as st

    class Dotty(ReadableSFTP):
        """An SFTP server that lists '.' and '..', which must not be recursed into."""

        def listdir_attr(self, path):
            out = super().listdir_attr(path)
            for name in ('.', '..'):
                attr = type('Attr', (), {})()
                attr.filename, attr.st_mode, attr.st_size = name, st.S_IFDIR | 0o755, 0
                out.append(attr)
            return out
    sftp = Dotty(TREE)
    client = wire(handler, sftp)
    with pytest.raises(ValueError):
        handler.delete_remote(' ')
    handler.delete_remote('/home6/tester/downloads/movie.mkv')
    assert sftp.removed == ['/home6/tester/downloads/movie.mkv'] and client.closed
    sftp.removed.clear()
    handler.delete_remote(REMOTE)
    assert sftp.removed == [REMOTE + '/ep01.mkv', REMOTE + '/ep02.mkv',
                            REMOTE + '/Extras/sample.mkv', REMOTE + '/Extras', REMOTE]


# --- autoSync -----------------------------------------------------------------

CREDS = {'host': 'box.example', 'port': 22, 'username': 'u', 'password': 'p'}


@pytest.fixture
def creds(monkeypatch):
    import backend.web_app as web
    monkeypatch.setattr(web, 'load_vps_credentials', lambda: CREDS)


def test_snapshot_and_forget_folder(handler, sftp):
    client = wire(handler, sftp)
    handler.snapshot_folder(REMOTE)
    assert handler._seen[REMOTE] == {'ep01.mkv', 'ep02.mkv'} and client.closed
    handler.forget_folder(REMOTE)
    assert REMOTE not in handler._seen
    handler.snapshot_folder('/home6/tester/nowhere')        # logged, not raised
    assert '/home6/tester/nowhere' not in handler._seen


def test_sync_once_does_nothing_without_a_connection_or_folders(db, handler, monkeypatch):
    import backend.web_app as web
    opened = []
    handler._open_sftp = lambda timeout=15: opened.append(1)
    monkeypatch.setattr(web, 'load_vps_credentials', lambda: None)
    handler.sync_once()
    monkeypatch.setattr(web, 'load_vps_credentials', lambda: CREDS)
    db.add_vps_watch_folder(REMOTE, 'other.example', 22, 'u')     # another connection
    other = db.add_vps_watch_folder('/home6/tester/downloads', 'box.example', 22, 'u')
    db.update_vps_watch_folder(other['id'], auto_sync=False)
    handler.sync_once()
    assert opened == []


def test_sync_once_baselines_first_then_pulls_only_what_appears(db, handler, creds):
    folder = db.add_vps_watch_folder(REMOTE, 'box.example', 22, 'u')
    db.update_vps_watch_folder(folder['id'], auto_sync=True)
    started = []
    handler.start_download = lambda remote, size=0, dest=None: started.append((remote, size))
    tree = {k: dict(v) for k, v in TREE.items()}
    sftp = ReadableSFTP(tree)
    wire(handler, sftp)

    handler.sync_once()                                     # first sight: baseline only
    assert started == [] and handler._seen[REMOTE] == {'ep01.mkv', 'ep02.mkv'}

    tree[REMOTE]['ep03.mkv'] = 7
    tree[REMOTE]['ep04.mkv'] = 8
    tree[REMOTE]['ep05.mkv'] = 9
    db.add_download(file='ep04.mkv', status='done', downloaded_from='vps',
                    message_id='had', url=REMOTE + '/ep04.mkv')          # already pulled
    real_stat = sftp.stat

    def flaky_stat(path):
        if path.endswith('ep05.mkv'):
            raise OSError('stat failed')                    # pulled anyway, unsized
        return real_stat(path)
    sftp.stat = flaky_stat
    handler.sync_once()
    assert started == [(REMOTE + '/ep03.mkv', 7), (REMOTE + '/ep05.mkv', 0)]
    handler.sync_once()                                     # seen now: not pulled twice
    assert len(started) == 2


def test_sync_once_survives_an_unlistable_folder_and_a_dead_connection(db, handler, creds):
    folder = db.add_vps_watch_folder('/home6/tester/vanished', 'box.example', 22, 'u')
    db.update_vps_watch_folder(folder['id'], auto_sync=True)
    client = wire(handler, ReadableSFTP(TREE), Client(close_raises=True))
    handler.sync_once()                                     # listing fails: logged, folder skipped
    assert '/home6/tester/vanished' not in handler._seen and client.closed

    def refuse(timeout=15):
        raise OSError('no route to host')
    handler._open_sftp = refuse
    handler.sync_once()                                     # connection fails: logged


def test_the_sync_loop_sleeps_then_scans_and_survives_a_failing_scan(handler, monkeypatch):
    class Stop(BaseException):
        pass
    slept, scanned = [], []

    def sleep(secs):
        slept.append(secs)
        if len(slept) > 1:
            raise Stop()

    def failing_scan():
        scanned.append(1)
        raise RuntimeError('scan blew up')
    own_time(monkeypatch, vps_handler, sleep=sleep)
    monkeypatch.setattr(handler, 'sync_once', failing_scan)
    with pytest.raises(Stop):
        handler._sync_loop()
    assert slept == [vps_handler.SYNC_INTERVAL_SECONDS] * 2 and scanned == [1]


def test_start_autosync_runs_the_loop_on_a_daemon_thread(handler, monkeypatch):
    ran = threading.Event()
    monkeypatch.setattr(handler, '_sync_loop', ran.set)
    handler.start_autosync()
    assert ran.wait(5)

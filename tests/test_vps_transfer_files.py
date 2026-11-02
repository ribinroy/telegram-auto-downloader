"""The per-file view of a VPS folder pull (a multi-file torrent pulled as one
download). No seedbox here: the remote side is FakeSFTP."""
from contextlib import contextmanager

import pytest

from backend.vps_handler import VpsDownloader
from tests.conftest import FakeSFTP

REMOTE = '/home6/tester/downloads/Show'
TREE = {
    '/home6/tester/downloads': {'Show': None},
    REMOTE: {'ep01.mkv': 10, 'ep02.mkv': 10, 'Extras': None},
    REMOTE + '/Extras': {'sample.mkv': 4},
}


@pytest.fixture
def handler():
    return VpsDownloader(download_tasks={})


@pytest.fixture
def remote(monkeypatch):
    sftp = FakeSFTP(TREE)

    @contextmanager
    def session(timeout=15):
        yield object(), sftp

    monkeypatch.setattr('backend.web_app.vps.vps_session', session)
    return sftp


@pytest.fixture
def pull(db, tmp_path):
    """A stopped folder pull with ep01 whole, ep02 half there, Extras missing."""
    dest = tmp_path / 'tv'
    (dest / 'Show').mkdir(parents=True)
    (dest / 'Show' / 'ep01.mkv').write_bytes(b'x' * 10)
    (dest / 'Show' / 'ep02.mkv').write_bytes(b'x' * 5)
    return db.add_download(file='Show', status='stopped', downloaded_from='vps',
                           message_id='p-1', url=REMOTE, dest_base=str(dest))


def _by_path(listing):
    return {f['path']: f for f in listing['files']}


def test_a_stopped_pull_is_compared_against_the_vps(db, handler, remote, pull):
    listing = handler.file_listing(pull)
    assert listing['source'] == 'vps' and listing['is_dir'] is True
    files = _by_path(listing)
    assert files['ep01.mkv']['state'] == 'done'
    assert files['ep02.mkv'] == {'path': 'ep02.mkv', 'size': 10, 'local_size': 5, 'state': 'partial'}
    assert files['Extras/sample.mkv']['state'] == 'pending'
    # Counting the files backfills the record, so the list offers the view
    assert db.get_download_by_message_id('p-1')['file_count'] == 3


def test_a_running_pull_answers_from_its_own_plan(handler, remote, pull, tmp_path):
    from backend.vps_handler import Path
    dest = Path(pull['dest_base'])
    handler.plans['p-1'] = {
        'files': [(REMOTE + '/ep02.mkv', 10, dest / 'Show' / 'ep02.mkv')],
        'is_dir': True, 'root': dest / 'Show', 'current': dest / 'Show' / 'ep02.mkv',
    }
    listing = handler.file_listing(pull)
    assert listing['source'] == 'live'
    assert _by_path(listing)['ep02.mkv']['state'] == 'downloading'


def test_without_the_vps_only_the_local_side_is_listed(handler, monkeypatch, pull):
    @contextmanager
    def unreachable(timeout=15):
        raise OSError('connection refused')
        yield  # pragma: no cover

    monkeypatch.setattr('backend.web_app.vps.vps_session', unreachable)
    listing = handler.file_listing(pull)
    assert listing['source'] == 'local'
    assert 'connection refused' in listing['error']
    assert sorted(_by_path(listing)) == ['ep01.mkv', 'ep02.mkv']
    assert {f['state'] for f in listing['files']} == {'on_disk'}


def test_the_route_refuses_a_download_that_is_not_a_vps_pull(client, db, auth):
    dl = db.add_download(file='a.mkv', status='done', downloaded_from='telegram', message_id='t-1')
    assert client.get(f"/api/downloads/{dl['id']}/files", headers=auth).status_code == 400
    assert client.get('/api/downloads/999999/files', headers=auth).status_code == 404


def test_check_files_backfills_the_count_of_an_old_folder_pull(db, pull):
    from backend.jobs import run_check_files
    db.update_download_by_message_id('p-1', status='done')
    run_check_files()
    assert db.get_download_by_message_id('p-1')['file_count'] == 2  # what is on disk


class _ReadableSFTP(FakeSFTP):
    """FakeSFTP whose files can be read: every byte is b'y', and each read
    is recorded so a test can see what was actually fetched."""

    def __init__(self, tree):
        super().__init__(tree)
        self.reads = []

    def open(self, path, mode='rb'):
        sftp = self

        class _File:
            def readv(self, chunks):
                sftp.reads.append((path, sum(n for _off, n in chunks)))
                return [b'y' * n for _off, n in chunks]

            def close(self):
                pass

        return _File()

    def close(self):
        pass


def test_a_folder_pull_fetches_only_what_is_missing_and_counts_its_files(db, handler, pull):
    sftp = _ReadableSFTP(TREE)

    class _Client:
        def close(self):
            pass

    handler._open_sftp = lambda timeout=15: (_Client(), sftp)
    handler._download(REMOTE, 'p-1', pull['dest_base'])

    record = db.get_download_by_message_id('p-1')
    assert record['status'] == 'done' and record['file_count'] == 3
    # ep01 was whole - never read; ep02 resumed from byte 5; sample fetched in full
    assert sorted(sftp.reads) == [(REMOTE + '/Extras/sample.mkv', 4), (REMOTE + '/ep02.mkv', 5)]
    from pathlib import Path
    assert (Path(pull['dest_base']) / 'Show' / 'ep02.mkv').read_bytes() == b'x' * 5 + b'y' * 5
    assert 'p-1' not in handler.plans  # plan dropped once the transfer ends


# --- pausing files of a folder pull ------------------------------------------

class _Client:
    def close(self):
        pass


def _run(handler, pull, sftp):
    handler._open_sftp = lambda timeout=15: (_Client(), sftp)
    handler._download(REMOTE, 'p-1', pull['dest_base'])


def test_a_paused_file_is_skipped_and_the_pull_ends_paused_not_done(db, handler, pull):
    db.update_download_by_message_id('p-1', file_status='{"Extras/sample.mkv": "paused"}')
    sftp = _ReadableSFTP(TREE)
    _run(handler, pull, sftp)
    assert [path for path, _n in sftp.reads] == [REMOTE + '/ep02.mkv']
    # Not "done": a file is still missing - and since every missing file is
    # paused, the pull itself reads as paused
    assert db.get_download_by_message_id('p-1')['status'] == 'paused'


def test_pausing_the_file_being_written_keeps_its_bytes_and_moves_on(db, handler, pull, monkeypatch):
    # 2-byte chunks, one per request, so a pause lands mid-file
    monkeypatch.setattr('backend.vps_handler.TRANSFER_CHUNK', 2)
    monkeypatch.setattr('backend.vps_handler.TRANSFER_BATCH', 1)
    class _PausesMidFile(_ReadableSFTP):
        def open(self, path, mode='rb'):
            inner = super().open(path, mode)
            if path.endswith('ep02.mkv'):
                real = inner.readv

                def readv(chunks):
                    handler.paused_files['p-1'].add('ep02.mkv')  # the user hits pause
                    return real(chunks)
                inner.readv = readv
            return inner

    sftp = _PausesMidFile(TREE)
    _run(handler, pull, sftp)
    from pathlib import Path
    # The chunk in flight lands (5 + 2), nothing after it - and the next file
    # was still fetched. Only the paused file is left, so the pull is paused.
    assert (Path(pull['dest_base']) / 'Show' / 'ep02.mkv').stat().st_size == 7
    assert (Path(pull['dest_base']) / 'Show' / 'Extras' / 'sample.mkv').stat().st_size == 4
    assert db.get_download_by_message_id('p-1')['status'] == 'paused'


def test_a_file_resumed_after_its_turn_is_fetched_by_a_later_pass(db, handler, pull):
    from pathlib import Path
    (Path(pull['dest_base']) / 'Show' / 'ep01.mkv').unlink()
    db.update_download_by_message_id('p-1', paused_files='["ep01.mkv"]')

    class _ResumesLater(_ReadableSFTP):
        def open(self, path, mode='rb'):
            if path.endswith('sample.mkv'):
                handler.paused_files['p-1'].discard('ep01.mkv')  # resumed after it was passed
            return super().open(path, mode)

    sftp = _ResumesLater(TREE)
    _run(handler, pull, sftp)
    assert (REMOTE + '/ep01.mkv', 10) in sftp.reads
    assert db.get_download_by_message_id('p-1')['status'] == 'done'


def test_the_listing_shows_paused_files(db, handler, remote, pull):
    db.update_download_by_message_id('p-1', file_status='{"Extras/sample.mkv": "paused"}')
    pull = db.get_download_by_message_id('p-1')
    files = _by_path(handler.file_listing(pull))
    assert files['Extras/sample.mkv']['state'] == 'paused'
    assert files['ep01.mkv']['state'] == 'done'  # finished beats paused


def test_the_pause_route_saves_and_resuming_restarts_a_stopped_pull(
        app, client, db, auth, handler, remote, pull, monkeypatch):
    app.vps_downloader = handler
    res = client.post(f"/api/downloads/{pull['id']}/files/pause", headers=auth,
                      json={'paths': ['ep02.mkv'], 'paused': True})
    # Extras/sample.mkv is still to fetch and not paused: the pull stays stopped
    assert res.get_json() == {'paused_files': ['ep02.mkv'], 'status': 'stopped', 'restarted': None}
    assert db.get_download_by_message_id('p-1')['paused_files'] == ['ep02.mkv']

    resumed = []
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: resumed.append(d['message_id']) or True)
    res = client.post(f"/api/downloads/{pull['id']}/files/pause", headers=auth,
                      json={'paths': ['ep02.mkv'], 'paused': False})
    assert res.get_json() == {'paused_files': [], 'status': 'downloading', 'restarted': 'started'}
    assert resumed == ['p-1']


def test_the_pause_route_validates_its_body(client, db, auth, pull):
    url = f"/api/downloads/{pull['id']}/files/pause"
    assert client.post(url, headers=auth, json={'paths': [], 'paused': True}).status_code == 400
    assert client.post(url, headers=auth, json={'paths': ['a'], 'paused': 'yes'}).status_code == 400


# --- the pull itself paused when every file left is ---------------------------

def test_a_pull_stops_not_pauses_when_an_unpaused_file_is_still_missing(db, handler, pull):
    """A missing file nobody paused (here: the VPS stopped serving it) is not
    the user's decision, so the pull must not read as paused."""
    db.update_download_by_message_id('p-1', paused_files='["ep02.mkv"]')

    class _ShortSample(_ReadableSFTP):
        def open(self, path, mode='rb'):
            inner = super().open(path, mode)
            if path.endswith('sample.mkv'):
                inner.readv = lambda chunks: [b'y' * (n // 2) for _o, n in chunks]
            return inner

    _run(handler, pull, _ShortSample(TREE))
    assert db.get_download_by_message_id('p-1')['status'] == 'stopped'


def test_pausing_the_last_file_left_pauses_a_stopped_pull(app, client, db, auth, handler, remote, pull):
    app.vps_downloader = handler
    url = f"/api/downloads/{pull['id']}/files/pause"
    client.post(url, headers=auth, json={'paths': ['ep02.mkv'], 'paused': True})
    res = client.post(url, headers=auth, json={'paths': ['Extras/sample.mkv'], 'paused': True})
    assert res.get_json()['status'] == 'paused'
    assert db.get_download_by_message_id('p-1')['status'] == 'paused'


def test_resuming_a_paused_pull_from_its_row_resumes_every_file(app, client, db, auth, handler, pull, monkeypatch):
    app.vps_downloader = handler
    db.update_download_by_message_id('p-1', status='paused', paused_files='["ep02.mkv", "Extras/sample.mkv"]')
    resumed = []
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: resumed.append(d['paused_files']) or True)
    res = client.post('/api/resume', headers=auth, json={'message_id': 'p-1'})
    assert res.get_json() == {'status': 'downloading'}
    assert resumed == [[]]  # restarted with nothing paused


def test_resume_all_unpauses_the_files_of_a_paused_pull(db, pull):
    from backend import download_queue
    db.update_download_by_message_id('p-1', status='paused', paused_files='["ep02.mkv"]')
    assert download_queue.resume_all() == 1
    record = db.get_download_by_message_id('p-1')
    assert record['status'] == 'waiting' and record['paused_files'] == []


# --- files already pulled on their own, under a renamed name ---------------

@pytest.fixture
def dots_to_spaces(db):
    """The common rule: separators in the stem become spaces. A single-file
    pull applies it to the file; a folder pull only to its top folder."""
    from backend.rename import invalidate_rules_cache
    db.add_rename_rule(r'(?<=\w)[._](?=\w)', ' ', name='dots to spaces')
    invalidate_rules_cache()
    yield
    invalidate_rules_cache()


RENAMED_TREE = {
    '/home6/tester/downloads': {'Show': None},
    REMOTE: {'ep.01.mkv': 10, 'ep.02.mkv': 10},
}


def test_a_folder_pull_counts_a_file_pulled_on_its_own_under_its_renamed_name(
        db, handler, tmp_path, dots_to_spaces):
    dest = tmp_path / 'tv'
    (dest / 'Show').mkdir(parents=True)
    (dest / 'Show' / 'ep 01.mkv').write_bytes(b'x' * 10)  # pulled alone earlier
    pull = db.add_download(file='Show', status='stopped', downloaded_from='vps',
                           message_id='p-1', url=REMOTE, dest_base=str(dest))
    sftp = _ReadableSFTP(RENAMED_TREE)

    @contextmanager
    def session(timeout=15):
        yield object(), sftp

    import backend.web_app.vps as vps_module
    original = vps_module.vps_session
    vps_module.vps_session = session
    try:
        files = _by_path(handler.file_listing(pull))
    finally:
        vps_module.vps_session = original
    assert files['ep 01.mkv']['state'] == 'done'
    assert files['ep.02.mkv']['state'] == 'pending'

    _run(handler, pull, sftp)
    # Only ep02 was fetched - no second copy of ep01 next to the renamed one
    assert [p for p, _n in sftp.reads] == [REMOTE + '/ep.02.mkv']
    assert sorted(p.name for p in (dest / 'Show').iterdir()) == ['ep 01.mkv', 'ep.02.mkv']
    assert db.get_download_by_message_id('p-1')['status'] == 'done'


def test_a_partial_renamed_copy_is_resumed_not_restarted(db, handler, tmp_path, dots_to_spaces):
    dest = tmp_path / 'tv'
    (dest / 'Show').mkdir(parents=True)
    (dest / 'Show' / 'ep 01.mkv').write_bytes(b'x' * 4)
    pull = db.add_download(file='Show', status='stopped', downloaded_from='vps',
                           message_id='p-1', url=REMOTE, dest_base=str(dest))
    sftp = _ReadableSFTP(RENAMED_TREE)
    _run(handler, pull, sftp)
    assert (REMOTE + '/ep.01.mkv', 6) in sftp.reads
    assert (dest / 'Show' / 'ep 01.mkv').read_bytes() == b'x' * 4 + b'y' * 6

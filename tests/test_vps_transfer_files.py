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
    assert files['ep02.mkv'] == {'path': 'ep02.mkv', 'size': 10, 'local_size': 5, 'state': 'partial',
                                 'local_path': None}  # only a whole file can be viewed
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
                    handler.file_status['p-1']['ep02.mkv'] = 'paused'  # the user hits pause
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
    db.update_download_by_message_id('p-1', file_status='{"ep01.mkv": "paused"}')

    class _ResumesLater(_ReadableSFTP):
        def open(self, path, mode='rb'):
            if path.endswith('sample.mkv'):
                handler.file_status['p-1'].pop('ep01.mkv', None)  # resumed after it was passed
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
    res = client.post(f"/api/downloads/{pull['id']}/files/status", headers=auth,
                      json={'paths': ['ep02.mkv'], 'status': 'paused'})
    # Extras/sample.mkv is still to fetch and not paused: the pull stays stopped
    assert res.get_json() == {'file_status': {'ep02.mkv': 'paused'}, 'status': 'stopped', 'restarted': None}
    assert db.get_download_by_message_id('p-1')['file_status'] == {'ep02.mkv': 'paused'}

    resumed = []
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: resumed.append(d['message_id']) or True)
    res = client.post(f"/api/downloads/{pull['id']}/files/status", headers=auth,
                      json={'paths': ['ep02.mkv'], 'status': None})
    assert res.get_json() == {'file_status': {}, 'status': 'downloading', 'restarted': 'started'}
    assert resumed == ['p-1']


def test_the_pause_route_validates_its_body(client, db, auth, pull):
    url = f"/api/downloads/{pull['id']}/files/status"
    assert client.post(url, headers=auth, json={'paths': [], 'status': 'paused'}).status_code == 400
    assert client.post(url, headers=auth, json={'paths': ['a'], 'status': 'gone'}).status_code == 400
    assert client.post(url, headers=auth, json={'paths': ['a']}).status_code == 400  # status is required


# --- the pull itself paused when every file left is ---------------------------

def test_a_pull_stops_not_pauses_when_an_unpaused_file_is_still_missing(db, handler, pull):
    """A missing file nobody paused (here: the VPS stopped serving it) is not
    the user's decision, so the pull must not read as paused."""
    db.update_download_by_message_id('p-1', file_status='{"ep02.mkv": "paused"}')

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
    url = f"/api/downloads/{pull['id']}/files/status"
    client.post(url, headers=auth, json={'paths': ['ep02.mkv'], 'status': 'paused'})
    res = client.post(url, headers=auth, json={'paths': ['Extras/sample.mkv'], 'status': 'paused'})
    assert res.get_json()['status'] == 'paused'
    assert db.get_download_by_message_id('p-1')['status'] == 'paused'


def test_resuming_a_paused_pull_from_its_row_resumes_every_file(app, client, db, auth, handler, pull, monkeypatch):
    app.vps_downloader = handler
    db.update_download_by_message_id('p-1', status='paused',
                                    file_status='{"ep02.mkv": "paused", "Extras/sample.mkv": "paused"}')
    resumed = []
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: resumed.append(d['file_status']) or True)
    res = client.post('/api/resume', headers=auth, json={'message_id': 'p-1'})
    assert res.get_json() == {'status': 'downloading'}
    assert resumed == [{}]  # restarted with nothing paused


def test_resume_all_unpauses_the_files_of_a_paused_pull(db, pull):
    from backend import download_queue
    db.update_download_by_message_id('p-1', status='paused', file_status='{"ep02.mkv": "paused"}')
    assert download_queue.resume_all() == 1
    record = db.get_download_by_message_id('p-1')
    assert record['status'] == 'waiting' and record['file_status'] == {}


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


# --- skipping files -------------------------------------------------------------

def test_a_skipped_file_is_left_out_and_the_pull_finishes_done(db, handler, pull):
    db.update_download_by_message_id('p-1', file_status='{"Extras/sample.mkv": "skipped"}')
    sftp = _ReadableSFTP(TREE)
    _run(handler, pull, sftp)
    assert [p for p, _n in sftp.reads] == [REMOTE + '/ep02.mkv']
    record = db.get_download_by_message_id('p-1')
    # Done, and sized without the skipped file
    assert record['status'] == 'done'
    assert record['total_bytes'] == 20 and record['progress'] == 100


def test_skipped_and_paused_together_leave_the_pull_paused(db, handler, pull):
    db.update_download_by_message_id(
        'p-1', file_status='{"Extras/sample.mkv": "skipped", "ep02.mkv": "paused"}')
    _run(handler, pull, _ReadableSFTP(TREE))
    assert db.get_download_by_message_id('p-1')['status'] == 'paused'


def test_skipping_the_last_missing_file_completes_a_stopped_pull(app, client, db, auth, handler, remote, pull):
    app.vps_downloader = handler
    url = f"/api/downloads/{pull['id']}/files/status"
    client.post(url, headers=auth, json={'paths': ['ep02.mkv'], 'status': 'skipped'})
    res = client.post(url, headers=auth, json={'paths': ['Extras/sample.mkv'], 'status': 'skipped'})
    assert res.get_json()['status'] == 'done'
    record = db.get_download_by_message_id('p-1')
    assert record['status'] == 'done' and record['total_bytes'] == 10  # just ep01
    assert _by_path(handler.file_listing(record))['ep02.mkv']['state'] == 'skipped'


def test_including_a_skipped_file_restarts_a_finished_pull(app, client, db, auth, handler, pull, monkeypatch):
    app.vps_downloader = handler
    db.update_download_by_message_id('p-1', status='done', file_status='{"ep02.mkv": "skipped"}')
    resumed = []
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: resumed.append(d['file_status']) or True)
    res = client.post(f"/api/downloads/{pull['id']}/files/status", headers=auth,
                      json={'paths': ['ep02.mkv'], 'status': None})
    assert res.get_json()['restarted'] == 'started'
    assert resumed == [{}]


def test_resuming_a_paused_pull_keeps_its_skipped_files_skipped(app, client, db, auth, handler, pull, monkeypatch):
    app.vps_downloader = handler
    db.update_download_by_message_id(
        'p-1', status='paused', file_status='{"ep02.mkv": "paused", "Extras/sample.mkv": "skipped"}')
    monkeypatch.setattr('backend.resume.resume_download', lambda d, **kw: True)
    client.post('/api/resume', headers=auth, json={'message_id': 'p-1'})
    assert db.get_download_by_message_id('p-1')['file_status'] == {'Extras/sample.mkv': 'skipped'}


def test_a_finished_file_carries_its_local_path_for_the_view_button(handler, remote, pull):
    files = _by_path(handler.file_listing(pull))
    assert files['ep01.mkv']['local_path'] == str(Path(pull['dest_base']) / 'Show' / 'ep01.mkv')
    assert files['Extras/sample.mkv']['local_path'] is None


def test_the_old_paused_files_list_is_migrated_into_file_status(tmp_path):
    """A DB from before the rename still has `paused_files`; its lists must
    come across as {path: 'paused'} rather than be dropped."""
    from sqlalchemy import text
    from backend.database import DatabaseManager
    url = f'sqlite:///{tmp_path / "old.db"}'
    old = DatabaseManager(url)
    with old.engine.connect() as conn:
        conn.execute(text('ALTER TABLE downloads DROP COLUMN file_status'))
        conn.execute(text('ALTER TABLE downloads ADD COLUMN paused_files TEXT'))
        conn.execute(text(
            "INSERT INTO downloads (file, status, message_id, downloaded_from, paused_files) "
            "VALUES ('Show', 'paused', 'm-old', 'vps', '[\"ep01.mkv\", \"ep02.mkv\"]')"))
        conn.commit()
    old.engine.dispose()

    migrated = DatabaseManager(url)
    assert migrated.get_download_by_message_id('m-old')['file_status'] == {
        'ep01.mkv': 'paused', 'ep02.mkv': 'paused'}

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

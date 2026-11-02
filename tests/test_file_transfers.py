"""Background copy/move jobs (backend/file_transfers.py) and their routes."""
import threading

import pytest

from backend import file_transfers as transfers
from backend import files as fs


@pytest.fixture(autouse=True)
def _fresh_registry():
    transfers.clear()
    yield
    transfers.clear()


def _run(paths, dest, move=False):
    job = transfers.start([str(p) for p in paths], str(dest), move=move)
    assert job.wait(10)
    return job


def test_a_copy_counts_every_byte_and_file(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = _run([tmp_tree / 'Movies', tmp_tree / 'notes.txt'], dest)
    snap = job.snapshot()
    assert snap['status'] == 'done'
    assert snap['total_bytes'] == 10 + 20 + len('hello world\n')
    assert snap['done_bytes'] == snap['total_bytes']
    assert snap['total_files'] == snap['done_files'] == 3
    assert snap['items_done'] == snap['items_total'] == 2
    assert (dest / 'Movies' / 'nested' / 'b.mp4').read_bytes() == b'y' * 20
    assert (tmp_tree / 'Movies').exists()       # a copy leaves the source


def test_a_same_disk_move_is_a_rename_with_nothing_to_copy(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = _run([tmp_tree / 'Movies'], dest, move=True)
    snap = job.snapshot()
    assert snap['status'] == 'done' and snap['total_bytes'] == 0
    assert (dest / 'Movies' / 'a.mkv').exists()
    assert not (tmp_tree / 'Movies').exists()


def test_errors_are_per_item_and_mark_the_job_partial(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = _run([tmp_tree / 'notes.txt', tmp_tree / 'Movies'], tmp_tree / 'Movies' / 'nested', move=True)
    snap = job.snapshot()
    assert snap['status'] == 'partial'
    assert len(snap['errors']) == 1 and 'into itself' in snap['errors'][0]['error']
    assert len(snap['results']) == 1


def test_cancel_stops_mid_file_and_removes_the_partial_copy(tmp_tree, monkeypatch):
    big = tmp_tree / 'big.bin'
    big.write_bytes(b'z' * (64 * 1024))
    dest = tmp_tree / 'dest'
    dest.mkdir()
    monkeypatch.setattr(transfers, 'CHUNK', 1024)

    first_chunk, release = threading.Event(), threading.Event()
    real_add = transfers.TransferJob._add_bytes

    def slow_add(self, n):
        real_add(self, n)
        first_chunk.set()
        release.wait(5)

    monkeypatch.setattr(transfers.TransferJob, '_add_bytes', slow_add)
    job = transfers.start([str(big)], str(dest))
    assert first_chunk.wait(5)
    snap = job.snapshot()
    assert snap['status'] == 'running' and 0 < snap['done_bytes'] < snap['total_bytes']
    assert snap['current_file'] == str(big)
    job.cancel()
    release.set()
    assert job.wait(5)
    assert job.snapshot()['status'] == 'cancelled'
    assert not (dest / 'big.bin').exists()
    assert big.exists()


def test_a_bad_destination_fails_before_any_thread(tmp_tree):
    with pytest.raises(fs.FsError):
        transfers.start([str(tmp_tree / 'notes.txt')], str(tmp_tree / 'notes.txt'))
    assert transfers.list_jobs() == []


def test_finished_jobs_stay_listed_until_acknowledged_and_dismissed(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = _run([tmp_tree / 'notes.txt'], dest)
    listed = transfers.list_jobs()
    assert [j['id'] for j in listed] == [job.id] and listed[0]['acknowledged'] is False
    assert transfers.acknowledge([job.id, 'nope']) == 1
    assert transfers.list_jobs()[0]['acknowledged'] is True
    assert transfers.dismiss(job.id) is True
    assert transfers.list_jobs() == []


def test_old_finished_jobs_are_pruned(tmp_tree, monkeypatch):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = _run([tmp_tree / 'notes.txt'], dest)
    job.finished_at -= transfers.KEEP_FINISHED_SECONDS + 1
    assert transfers.list_jobs() == []


# --- routes -----------------------------------------------------------------

def test_a_small_paste_answers_with_the_finished_job(client, db, auth, tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    body = client.post('/api/files/transfer', headers=auth,
                       json={'paths': [str(tmp_tree / 'notes.txt')], 'dest': str(dest)}).get_json()
    assert body['running'] is False
    assert body['job']['status'] == 'done'
    assert body['results'][0]['target'] == str(dest / 'notes.txt')


def test_a_slow_paste_answers_running_and_is_listed(client, db, auth, tmp_tree, monkeypatch):
    """What a reloaded tab relies on: the job is the server's, so the list
    still has it (and its progress) whoever asks."""
    from backend.web_app.routes import files as routes
    monkeypatch.setattr(routes, 'TRANSFER_INLINE_WAIT', 0)
    gate = threading.Event()
    real_plan = fs.transfer_plan
    monkeypatch.setattr(fs, 'transfer_plan', lambda *a, **k: (gate.wait(5), real_plan(*a, **k))[1])
    dest = tmp_tree / 'dest'
    dest.mkdir()
    body = client.post('/api/files/transfer', headers=auth,
                       json={'paths': [str(tmp_tree / 'notes.txt')], 'dest': str(dest)}).get_json()
    assert body['running'] is True
    listed = client.get('/api/files/transfers', headers=auth).get_json()['transfers']
    assert listed[0]['id'] == body['job']['id'] and listed[0]['status'] == 'preparing'

    assert client.delete(f"/api/files/transfers/{body['job']['id']}", headers=auth).status_code == 409

    gate.set()
    assert transfers.get(body['job']['id']).wait(5)
    ack = client.post('/api/files/transfers/ack', headers=auth, json={'ids': [body['job']['id']]})
    assert ack.get_json()['acknowledged'] == 1
    assert client.delete(f"/api/files/transfers/{body['job']['id']}", headers=auth).status_code == 200


def test_cancel_route_404s_an_unknown_job(client, db, auth):
    assert client.post('/api/files/transfers/nope/cancel', headers=auth).status_code == 404


# --- per-file listing -------------------------------------------------------

def _states(job):
    return {f['rel']: f['state'] for f in job.file_listing()['files']}


def test_the_listing_names_every_file_with_where_it_lands(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = _run([tmp_tree / 'Movies', tmp_tree / 'notes.txt'], dest)
    listing = job.file_listing()
    assert _states(job) == {'Movies/a.mkv': 'done', 'Movies/nested/b.mp4': 'done', 'notes.txt': 'done'}
    assert listing['counts']['done'] == 3 and listing['truncated'] is False


def test_a_same_disk_move_lists_the_item_as_one_rename(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = _run([tmp_tree / 'Movies'], dest, move=True)
    [row] = job.file_listing()['files']
    assert row['rel'] == 'Movies' and row['rename'] is True and row['state'] == 'done'


def test_an_item_that_fails_up_front_leaves_its_files_not_copied(tmp_tree):
    job = _run([tmp_tree / 'Movies'], tmp_tree / 'Movies' / 'nested', move=True)
    # same disk -> one rename row, refused as "into itself"
    [row] = job.file_listing()['files']
    assert row['state'] == 'skipped' and 'into itself' in row['error']


def test_a_file_that_cannot_be_read_fails_alone(tmp_tree, monkeypatch):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    bad = str(tmp_tree / 'Movies' / 'a.mkv')
    real_open = open

    def flaky_open(path, *a, **k):
        if str(path) == bad and 'r' in (a[0] if a else k.get('mode', 'r')):
            raise PermissionError(13, 'Permission denied')
        return real_open(path, *a, **k)

    monkeypatch.setattr('builtins.open', flaky_open)
    job = _run([tmp_tree / 'Movies'], dest)
    states = _states(job)
    assert states['Movies/a.mkv'] == 'failed'
    assert states['Movies/nested/b.mp4'] == 'done'
    failed = next(f for f in job.file_listing()['files'] if f['state'] == 'failed')
    assert failed['error'] == 'Permission denied'


def test_cancel_marks_the_item_cancelled_and_the_rest_not_copied(tmp_tree, monkeypatch):
    big = tmp_tree / 'big.bin'
    big.write_bytes(b'z' * (64 * 1024))
    dest = tmp_tree / 'dest'
    dest.mkdir()
    monkeypatch.setattr(transfers, 'CHUNK', 1024)
    first, release = threading.Event(), threading.Event()
    real_add = transfers.TransferJob._add_bytes

    def slow_add(self, n):
        real_add(self, n)
        first.set()
        release.wait(5)

    monkeypatch.setattr(transfers.TransferJob, '_add_bytes', slow_add)
    job = transfers.start([str(big), str(tmp_tree / 'notes.txt')], str(dest))
    assert first.wait(5)
    row = next(f for f in job.file_listing()['files'] if f['rel'] == 'big.bin')
    assert row['state'] == 'copying' and row['done'] > 0
    job.cancel()
    release.set()
    assert job.wait(5)
    assert _states(job) == {'big.bin': 'cancelled', 'notes.txt': 'skipped'}


def test_the_files_route(client, db, auth, tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    body = client.post('/api/files/transfer', headers=auth,
                       json={'paths': [str(tmp_tree / 'notes.txt')], 'dest': str(dest)}).get_json()
    res = client.get(f"/api/files/transfers/{body['job']['id']}/files", headers=auth)
    assert res.status_code == 200
    assert [f['rel'] for f in res.get_json()['files']] == ['notes.txt']
    assert client.get('/api/files/transfers/nope/files', headers=auth).status_code == 404

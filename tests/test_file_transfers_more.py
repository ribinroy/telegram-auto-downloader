"""Background copy/move jobs: the corners - a cancel that lands before the
first byte, a link copied by the counting copy, a paused file failing on its
second pass, a source that cannot be removed after a cross-disk move, and a
job that dies before it can plan."""
import os
import threading

import pytest

from backend import file_transfers as transfers
from backend import files as fs


@pytest.fixture(autouse=True)
def _fresh_registry():
    transfers.clear()
    yield
    transfers.clear()


def _states(job):
    return {f['rel']: f['state'] for f in job.file_listing()['files']}


def test_a_job_cancelled_before_it_starts_copies_nothing(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = transfers.TransferJob([str(tmp_tree / 'notes.txt')], str(dest), move=False)
    job.cancel()
    job.run()
    assert job.status == 'cancelled' and not (dest / 'notes.txt').exists()
    with pytest.raises(fs.TransferCancelled):
        job.begin_item(tmp_tree / 'notes.txt')
    with pytest.raises(fs.TransferCancelled):
        job.copy_file(str(tmp_tree / 'notes.txt'), str(dest / 'x'))


def test_the_counting_copy_recreates_links_and_lands_in_a_directory(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    link = tmp_tree / 'link.txt'
    link.symlink_to(tmp_tree / 'notes.txt')
    job = transfers.TransferJob([], str(dest), move=False)
    assert job.copy_file(str(link), str(dest / 'link.txt'), follow_symlinks=False) == str(dest / 'link.txt')
    assert (dest / 'link.txt').is_symlink() and job.done_files == 1
    # A directory destination gets the file's own name, like shutil.copy
    assert job.copy_file(str(tmp_tree / 'notes.txt'), str(dest)) == str(dest / 'notes.txt')
    assert (dest / 'notes.txt').read_text() == 'hello world\n' and job.done_bytes == 12


def test_a_cross_disk_move_without_pauses_removes_the_source_at_once(tmp_tree, monkeypatch):
    monkeypatch.setattr(fs, '_same_device', lambda *_: False)
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = transfers.TransferJob([str(tmp_tree / 'Movies')], str(dest), move=True)
    job.run()
    assert job.status == 'done'
    assert not (tmp_tree / 'Movies').exists() and (dest / 'Movies' / 'a.mkv').exists()


def test_pausing_is_refused_once_finished_and_ignored_for_renames(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    job = transfers.start([str(tmp_tree / 'Movies')], str(dest), move=True)   # same disk: a rename
    assert job.wait(10)
    assert job.set_paused([str(tmp_tree / 'Movies')], True) == 0
    job2 = transfers.TransferJob([str(tmp_tree / 'notes.txt')], str(dest), move=True)
    job2._files = [{'path': str(tmp_tree / 'notes.txt'), 'rel': 'notes.txt', 'size': 0,
                    'item': 0, 'rename': True, 'state': 'pending'}]
    job2._by_path = {f['path']: f for f in job2._files}
    assert job2.set_paused([str(tmp_tree / 'notes.txt'), 'unknown'], True) == 0


class Gate:
    def __init__(self, monkeypatch):
        self.chunk = threading.Event()
        self.go = threading.Event()
        self.go.set()
        real_add = transfers.TransferJob._add_bytes
        gate = self

        def add(job, n):
            real_add(job, n)
            gate.chunk.set()
            assert gate.go.wait(5)
        monkeypatch.setattr(transfers, 'CHUNK', 1024)
        monkeypatch.setattr(transfers.TransferJob, '_add_bytes', add)

    def hold(self):
        self.go.clear()
        self.chunk.clear()

    def release(self):
        self.go.set()


def _wait_for(pred, timeout=5):
    import time
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def _big(tmp_tree, name='big.bin', size=32 * 1024):
    p = tmp_tree / name
    p.write_bytes(bytes(range(256)) * (size // 256))
    return p


def test_a_resumed_file_that_fails_on_its_second_pass_is_recorded(tmp_tree, monkeypatch):
    big = _big(tmp_tree)
    dest = tmp_tree / 'dest'
    dest.mkdir()
    gate = Gate(monkeypatch)
    gate.hold()
    job = transfers.start([str(big)], str(dest))
    assert gate.chunk.wait(5)
    job.set_paused([str(big)], True)
    gate.release()
    assert _wait_for(lambda: job.snapshot()['status'] == 'paused')
    big.unlink()                                       # gone before it is resumed
    job.set_paused([str(big)], False)
    assert job.wait(5)
    # The item was handed over as done by the first pass; its second-pass
    # failure is one error among its results, so the job reads partial
    assert job.snapshot()['status'] == 'partial'
    assert _states(job)['big.bin'] == 'failed'
    assert 'No such file' in job.snapshot()['errors'][0]['error']


def test_a_file_paused_again_mid_resume_is_set_aside_again(tmp_tree, monkeypatch):
    big = _big(tmp_tree)
    dest = tmp_tree / 'dest'
    dest.mkdir()
    gate = Gate(monkeypatch)
    gate.hold()
    job = transfers.start([str(big)], str(dest))
    assert gate.chunk.wait(5)
    job.set_paused([str(big)], True)
    gate.release()
    assert _wait_for(lambda: job.snapshot()['status'] == 'paused')
    gate.hold()
    job.set_paused([str(big)], False)
    assert gate.chunk.wait(5)                           # the second pass is writing
    job.set_paused([str(big)], True)                    # ...and is paused once more
    gate.release()
    assert _wait_for(lambda: job.snapshot()['status'] == 'paused')
    assert _states(job)['big.bin'] == 'paused'
    job.set_paused([str(big)], False)
    assert job.wait(5) and job.snapshot()['status'] == 'done'
    assert (dest / 'big.bin').read_bytes() == big.read_bytes()


def test_a_cross_disk_move_keeps_a_source_whose_file_failed_or_cannot_be_removed(tmp_tree, monkeypatch):
    monkeypatch.setattr(fs, '_same_device', lambda *_: False)
    dest = tmp_tree / 'dest'
    dest.mkdir()
    gate = Gate(monkeypatch)
    gate.hold()
    job = transfers.start([str(tmp_tree / 'Movies')], str(dest), move=True)
    assert gate.chunk.wait(5)
    nested = str(tmp_tree / 'Movies' / 'nested' / 'b.mp4')
    job.set_paused([nested], True)
    gate.release()
    assert _wait_for(lambda: job.snapshot()['status'] == 'paused')

    def refuse(path):
        raise OSError(16, 'Device or resource busy')
    monkeypatch.setattr(fs, 'remove_source', refuse)
    job.set_paused([nested], False)
    assert job.wait(5)
    assert job.snapshot()['status'] == 'partial'
    assert "couldn't be removed" in job.snapshot()['errors'][0]['error']
    assert (tmp_tree / 'Movies' / 'nested' / 'b.mp4').exists()

    # A file of the item having failed: the source is kept without a word
    job2 = transfers.TransferJob([str(tmp_tree / 'Movies')], str(dest), move=True)
    job2._item_index = 0
    job2._sources[0] = str(tmp_tree / 'Movies')
    job2._item_failed.add(0)
    job2._release_if_complete(0)
    assert (tmp_tree / 'Movies').exists() and job2.results == []
    job2._release_if_complete(0)                        # already settled: nothing to do


def test_speed_is_over_a_short_window(monkeypatch):
    job = transfers.TransferJob([], '/', False)
    clock = iter([0.0, 1.0, 10.0, 10.5, 10.5])
    monkeypatch.setattr(transfers.time, 'monotonic', lambda: next(clock))
    job._add_bytes(100)
    job._add_bytes(100)
    job._add_bytes(100)                                 # 10s later: the first samples drop
    job._add_bytes(100)
    assert len(job._samples) == 2
    assert job.speed() == pytest.approx(200)


def test_a_job_that_dies_before_it_can_plan_fails_cleanly(tmp_tree, monkeypatch):
    job = transfers.TransferJob([str(tmp_tree / 'notes.txt')], str(tmp_tree / 'notes.txt'), False)
    job.run()
    assert job.status == 'failed' and 'not a directory' in job.error

    cancelled = transfers.TransferJob([str(tmp_tree / 'Movies')], str(tmp_tree), False)
    monkeypatch.setattr(fs, 'transfer_plan', lambda *a, **k: (_ for _ in ()).throw(fs.TransferCancelled()))
    cancelled.run()
    assert cancelled.status == 'cancelled'

    crashed = transfers.TransferJob([str(tmp_tree / 'Movies')], str(tmp_tree), False)
    monkeypatch.setattr(fs, 'transfer_plan', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    crashed.run()
    assert crashed.status == 'failed' and crashed.error == 'boom'
    assert crashed.finished


def test_dismissing_an_unknown_job_is_false():
    assert transfers.dismiss('nope') is False

"""Explorer thumbnails: the cache key, the contact sheet, the pool.

No ffmpeg runs in here. A frame grab on a 4K file costs seconds and its output
is a JPEG nobody asserts on; what is worth pinning down is the *command* built
for it, the cache bookkeeping around it, and the fact that two requests for one
file do the work once. Images go through Pillow for real, since that is cheap.
"""
import json
import os
import threading
import time

import pytest

from backend import files as fs


@pytest.fixture
def cache(tmp_path, monkeypatch):
    """Point the thumbnail cache at a temp dir and drain the in-flight map."""
    monkeypatch.setattr(fs, 'THUMB_CACHE', tmp_path / 'cache')
    # Every fixture file was written a moment ago; the settling check has its
    # own test.
    monkeypatch.setattr(fs, 'SETTLING_SECONDS', 0)
    fs._thumb_inflight.clear()
    fs._thumb_failed.clear()
    yield tmp_path / 'cache'
    fs._thumb_inflight.clear()
    fs._thumb_failed.clear()


@pytest.fixture
def png(tmp_path):
    Image = pytest.importorskip('PIL.Image')
    p = tmp_path / 'shot.png'
    Image.new('RGB', (1200, 800), 'navy').save(p)
    return p


# --- cache key ------------------------------------------------------------

def test_editing_a_file_in_place_invalidates_its_preview(tmp_path):
    f = tmp_path / 'clip.mp4'
    f.write_bytes(b'x' * 10)
    before = fs._thumb_key(str(f), f.stat())
    f.write_bytes(b'y' * 20)
    assert fs._thumb_key(str(f), f.stat()) != before


def test_the_key_is_versioned_so_a_format_change_orphans_the_old_entries(tmp_path, monkeypatch):
    f = tmp_path / 'clip.mp4'
    f.write_bytes(b'x')
    st = f.stat()
    before = fs._thumb_key(str(f), st)
    monkeypatch.setattr(fs, 'THUMB_VERSION', fs.THUMB_VERSION + 1)
    assert fs._thumb_key(str(f), st) != before


def test_the_key_follows_the_file_across_renames_moves_and_copies(tmp_path):
    a = tmp_path / 'one' / 'clip.mp4'
    a.parent.mkdir()
    a.write_bytes(os.urandom(300_000))         # past two fingerprint chunks
    key = fs._thumb_key(str(a), a.stat())

    b = tmp_path / 'two' / 'renamed.mp4'
    b.parent.mkdir()
    a.rename(b)                                 # same inode
    assert fs._thumb_key(str(b), b.stat()) == key

    c = tmp_path / 'copy.mp4'
    c.write_bytes(b.read_bytes())               # a new inode, a new mtime: same content
    assert fs._thumb_key(str(c), c.stat()) == key


def test_the_key_reads_the_head_and_tail(tmp_path):
    f = tmp_path / 'clip.mp4'
    body = bytearray(os.urandom(300_000))
    f.write_bytes(bytes(body))
    key = fs._thumb_key(str(f), f.stat())
    body[-1] ^= 0xFF                            # same size, last byte changed
    f.write_bytes(bytes(body))
    st = f.stat()                               # a real edit moves the mtime; a test runs inside one tick
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    assert fs._thumb_key(str(f), f.stat()) != key


def test_the_key_is_memoised_by_identity_so_polls_do_not_reread(tmp_path, monkeypatch):
    f = tmp_path / 'clip.mp4'
    f.write_bytes(b'x' * 100)
    calls = []
    real = fs._fingerprint
    monkeypatch.setattr(fs, '_fingerprint', lambda p, size: calls.append(p) or real(p, size))
    st = f.stat()
    for _ in range(3):
        fs._thumb_key(str(f), st)
    moved = tmp_path / 'moved.mp4'
    f.rename(moved)
    fs._thumb_key(str(moved), moved.stat())
    assert len(calls) <= 1                      # an earlier test may have memoised it already


def test_the_memo_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(fs, '_KEY_MEMO_MAX', 2)
    monkeypatch.setattr(fs, '_key_memo', {})
    for i in range(4):
        f = tmp_path / f'{i}.mp4'
        f.write_bytes(bytes([i]) * 10)
        fs._thumb_key(str(f), f.stat())
    assert len(fs._key_memo) == 2


def test_an_unreadable_file_gets_no_preview(cache, png, monkeypatch):
    def deny(p, size):
        raise PermissionError(13, 'Permission denied')
    monkeypatch.setattr(fs, '_key_memo', {})
    monkeypatch.setattr(fs, '_fingerprint', deny)
    assert fs.thumbnail(str(png)) is None


# --- following a moved file -------------------------------------------------

def test_a_moved_file_keeps_its_preview_and_the_sidecar_follows(cache, png, tmp_path):
    first = fs.thumbnail(str(png))
    moved = tmp_path / 'elsewhere' / 'renamed.png'
    moved.parent.mkdir()
    png.rename(moved)
    fs._adopted.clear()

    assert fs.thumbnail(str(moved)) == first    # no regeneration
    assert json.loads(first.with_suffix('.json').read_text())['path'] == str(moved)


def test_seeing_a_file_again_clears_its_missing_stamp(cache, png):
    thumb = fs.thumbnail(str(png))
    meta = json.loads(thumb.with_suffix('.json').read_text())
    meta['missing_since'] = 1.0
    thumb.with_suffix('.json').write_text(json.dumps(meta))
    fs._adopted.clear()
    fs.thumbnail(str(png))
    assert 'missing_since' not in json.loads(thumb.with_suffix('.json').read_text())

    # The cleanup clears it too, when the file turns out to be back at its path
    meta['missing_since'] = 1.0
    thumb.with_suffix('.json').write_text(json.dumps(meta))
    assert fs.prune_thumb_cache()['kept'] == 1
    assert 'missing_since' not in json.loads(thumb.with_suffix('.json').read_text())


def _legacy_entry(path, layout='1x1', stage='final'):
    st = path.stat()
    legacy = fs.THUMB_CACHE / fs._legacy_key(str(path), st)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_bytes(b'old jpeg')
    legacy.with_suffix('.json').write_text(json.dumps({
        'path': str(path), 'mtime_ns': st.st_mtime_ns, 'size': st.st_size,
        'version': fs.LEGACY_THUMB_VERSION, 'layout': layout, 'stage': stage,
    }))
    return legacy


def test_a_path_keyed_preview_is_adopted_on_view_not_regenerated(cache, png, monkeypatch):
    legacy = _legacy_entry(png, stage='quick')
    monkeypatch.setattr(fs, '_generate', lambda *a: pytest.fail('regenerated'))
    thumb = fs.thumbnail(str(png))
    assert thumb.read_bytes() == b'old jpeg' and not legacy.exists()
    meta = json.loads(thumb.with_suffix('.json').read_text())
    assert meta['version'] == fs.THUMB_VERSION and meta['stage'] == 'quick'


def test_the_cleanup_migrates_path_keyed_previews(cache, png, tmp_path):
    legacy = _legacy_entry(png)
    gone = tmp_path / 'gone.png'
    gone.write_bytes(b'x')
    orphan = _legacy_entry(gone)
    gone.unlink()

    stats = fs.prune_thumb_cache()
    assert stats['migrated'] == 1 and stats['kept'] == 1 and stats['deleted'] == 1
    assert not legacy.exists() and not orphan.exists()
    target = cache / fs._thumb_key(str(png), png.stat())
    assert target.read_bytes() == b'old jpeg'


def test_a_path_keyed_duplicate_of_an_adopted_preview_is_dropped(cache, png):
    current = fs.thumbnail(str(png))
    legacy = _legacy_entry(png)
    stats = fs.prune_thumb_cache()
    assert stats['migrated'] == 0 and stats['deleted'] == 1
    assert current.exists() and not legacy.exists()


# --- images ---------------------------------------------------------------

def test_an_image_is_scaled_once_and_then_served_from_cache(cache, png):
    from PIL import Image
    made = fs.thumbnail(str(png))
    assert made and made.exists()
    assert max(Image.open(made).size) == fs.THUMB_MAX
    assert fs.thumbnail(str(png)) == made

    meta = json.loads(made.with_suffix('.json').read_text())
    assert meta['path'] == str(png)
    assert meta['layout'] == '1x1'
    assert meta['version'] == fs.THUMB_VERSION


def test_a_non_media_file_has_no_preview(cache, tmp_path):
    doc = tmp_path / 'notes.txt'
    doc.write_text('hi')
    assert fs.thumbnail(str(doc)) is None


def test_a_failed_generation_leaves_nothing_behind(cache, png, monkeypatch):
    monkeypatch.setattr(fs, '_image_thumb', lambda *_a: None)
    assert fs.thumbnail(str(png)) is None
    assert not list(cache.glob('*'))


# --- the contact sheet ----------------------------------------------------

def _jpeg(out):
    """A real frame where Pillow is there (the sheet tiles it), else bytes."""
    try:
        from PIL import Image
        Image.new('RGB', (48, 27), 'teal').save(out, 'JPEG')
    except ImportError:
        out.write_bytes(b'jpeg')

def _captured(monkeypatch, duration):
    """Record the ffmpeg command a sheet would run, without running it."""
    calls = []

    def fake_run(cmd, out):
        calls.append(cmd)
        _jpeg(out)
        return True

    monkeypatch.setattr(fs, '_video_duration', lambda _p: duration)
    monkeypatch.setattr(fs, '_run_ffmpeg', fake_run)
    monkeypatch.setattr(fs, '_tile_single', lambda out: out)
    return calls


def test_a_video_is_sampled_across_its_whole_runtime(cache, tmp_path, monkeypatch):
    calls = _captured(monkeypatch, duration=1000.0)
    clip = tmp_path / 'movie.mkv'
    clip.write_bytes(b'x')

    pytest.importorskip('PIL.Image')
    assert fs.thumbnail(str(clip))
    assert len(calls) == 1                      # first pass: one frame
    assert calls[0][calls[0].index('-ss') + 1] == '400.000'
    calls.clear()
    assert fs.upgrade_thumb(str(clip))
    # Four single-frame grabs run side by side, then tiled: one process with
    # four inputs works through them in turn, which on an 8K file was twice
    # as slow.
    assert len(calls) == 4
    assert sorted(c[c.index('-ss') + 1] for c in calls) == \
        ['200.000', '400.000', '600.000', '800.000']
    assert all(c.count('-i') == 1 for c in calls)
    from PIL import Image
    with Image.open(fs.thumbnail(str(clip))) as sheet:
        assert sheet.size == (96, 54)     # 2x2 of 48x27
    assert not list(cache.glob('*.tmp'))  # the per-frame temps are gone

    meta = json.loads(fs.thumbnail(str(clip)).with_suffix('.json').read_text())
    assert meta['layout'] == '2x2' and meta['stage'] == 'final'


def test_a_video_with_no_readable_duration_falls_back_to_one_frame(cache, tmp_path, monkeypatch):
    calls = _captured(monkeypatch, duration=None)
    clip = tmp_path / 'stream.mkv'
    clip.write_bytes(b'x')

    assert fs.thumbnail(str(clip))
    assert len(calls) == 1
    assert 'xstack=inputs=4' not in ' '.join(calls[0])
    # Still recorded as a sheet: _tile_single repeats the frame, so the client
    # lays every video preview out the same way.
    assert json.loads(fs.thumbnail(str(clip)).with_suffix('.json').read_text())['layout'] == '2x2'


def test_a_clip_shorter_than_the_seek_retries_from_zero(cache, tmp_path, monkeypatch):
    attempts = []

    def fake_run(cmd, out):
        attempts.append(cmd)
        if '-ss' in cmd:              # the 5-second seek runs past the end
            return False
        out.write_bytes(b'jpeg')
        return True

    monkeypatch.setattr(fs, '_video_duration', lambda _p: None)
    monkeypatch.setattr(fs, '_run_ffmpeg', fake_run)
    monkeypatch.setattr(fs, '_tile_single', lambda out: out)
    clip = tmp_path / 'tiny.mp4'
    clip.write_bytes(b'x')

    assert fs.thumbnail(str(clip))
    assert len(attempts) == 2 and '-ss' not in attempts[1]


def test_tiling_a_single_frame_fills_the_whole_sheet(tmp_path):
    Image = pytest.importorskip('PIL.Image')
    frame = tmp_path / 'one.jpg'
    Image.new('RGB', (480, 270), 'red').save(frame)
    fs._tile_single(frame)
    assert Image.open(frame).size == (480 * fs.SHEET_COLS, 270 * fs.SHEET_ROWS)


# --- the pool -------------------------------------------------------------

def test_two_requests_for_one_file_generate_it_once(cache, png, monkeypatch):
    runs = []
    real = fs._image_thumb

    def slow(path, out):
        runs.append(path)
        time.sleep(0.3)
        return real(path, out)

    monkeypatch.setattr(fs, '_image_thumb', slow)
    results = []
    threads = [threading.Thread(target=lambda: results.append(fs.thumbnail(str(png))))
               for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(runs) == 1
    assert results[0] == results[1] is not None


def test_warming_queues_the_work_without_waiting_for_it(cache, png, tmp_path):
    doc = tmp_path / 'notes.txt'
    doc.write_text('hi')

    stats = fs.warm_thumbs([str(png), str(doc), str(tmp_path / 'gone.png')])
    assert stats == {'queued': 1, 'cached': 0, 'skipped': 2}

    fs.thumbnail(str(png))            # joins the queued run rather than redoing it
    assert fs.warm_thumbs([str(png)]) == {'queued': 0, 'cached': 1, 'skipped': 0}


# --- pruning --------------------------------------------------------------

def test_pruning_keeps_a_live_entry_and_drops_a_dead_one_after_a_grace_period(cache, png, monkeypatch):
    live = fs.thumbnail(str(png))
    dead = cache / 'deadbeef.jpg'
    dead.write_bytes(b'jpeg')
    dead.with_suffix('.json').write_text(json.dumps({
        'path': str(cache / 'nothing.png'), 'mtime_ns': 1, 'size': 1,
        'version': fs.THUMB_VERSION, 'layout': '1x1',
    }))

    # Gone from its path could be moved, not deleted: the first sweep only
    # notes when it went missing.
    stats = fs.prune_thumb_cache()
    assert stats['kept'] == 2 and stats['deleted'] == 0
    assert 'missing_since' in json.loads(dead.with_suffix('.json').read_text())
    # Still inside the grace period: kept again, and the stamp isn't moved on.
    stamp = json.loads(dead.with_suffix('.json').read_text())['missing_since']
    assert fs.prune_thumb_cache()['deleted'] == 0
    assert json.loads(dead.with_suffix('.json').read_text())['missing_since'] == stamp

    monkeypatch.setattr(fs, 'MISSING_GRACE_SECONDS', -1)
    stats = fs.prune_thumb_cache()
    assert stats['kept'] == 1 and stats['deleted'] == 1
    assert live.exists() and not dead.exists() and not dead.with_suffix('.json').exists()


def test_pruning_drops_entries_an_older_format_left_behind(cache, png):
    old = fs.thumbnail(str(png))
    meta = json.loads(old.with_suffix('.json').read_text())
    meta['version'] = 1                         # a retired format (single frame)
    old.with_suffix('.json').write_text(json.dumps(meta))

    assert fs.prune_thumb_cache()['deleted'] == 1
    assert not old.exists()


def test_pruning_sweeps_orphans_and_half_written_temp_files(cache):
    cache.mkdir(parents=True)
    (cache / 'orphan.json').write_text('{}')
    (cache / 'aborted.tmp').write_bytes(b'partial')
    (cache / 'nosidecar.jpg').write_bytes(b'jpeg')

    fs.prune_thumb_cache()
    assert not (cache / 'orphan.json').exists()
    assert not (cache / 'aborted.tmp').exists()
    assert not (cache / 'nosidecar.jpg').exists()


# --- never holding a connection hostage -----------------------------------

def test_a_slow_preview_answers_pending_instead_of_blocking(cache, tmp_path, monkeypatch):
    """A grid of 8K videos used to hold every browser connection open for a
    minute of ffmpeg each, so the video the user clicked was never sent."""
    release = threading.Event()

    def slow_run(cmd, out):
        release.wait(5)
        out.write_bytes(b'jpeg')
        return True

    monkeypatch.setattr(fs, '_video_duration', lambda _p: 100.0)
    monkeypatch.setattr(fs, '_run_ffmpeg', slow_run)
    clip = tmp_path / 'huge.mp4'
    clip.write_bytes(b'x')

    assert fs.thumbnail(str(clip), wait=0.05) is fs.PENDING
    release.set()
    assert fs.thumbnail(str(clip)) not in (None, fs.PENDING)


def test_a_failed_preview_is_not_regenerated(cache, tmp_path, monkeypatch):
    calls = []

    def failing_run(cmd, out):
        calls.append(cmd)
        return False

    monkeypatch.setattr(fs, '_video_duration', lambda _p: 100.0)
    monkeypatch.setattr(fs, '_run_ffmpeg', failing_run)
    clip = tmp_path / 'broken.mp4'
    clip.write_bytes(b'x')

    assert fs.thumbnail(str(clip)) is None
    tried = len(calls)
    assert fs.thumbnail(str(clip)) is None
    assert len(calls) == tried          # remembered, not re-run

    # ...but only for a while: the file may simply have been mid-download.
    monkeypatch.setattr(fs.time, 'time', lambda: 10**12)
    fs.thumbnail(str(clip))
    assert len(calls) > tried


def test_a_file_still_being_written_is_left_alone(cache, tmp_path, monkeypatch):
    calls = _captured(monkeypatch, duration=100.0)
    monkeypatch.setattr(fs, 'SETTLING_SECONDS', 60)
    clip = tmp_path / 'arriving.mp4'
    clip.write_bytes(b'x')
    now = time.time()
    os.utime(clip, (now, now))

    assert fs.thumbnail(str(clip)) is None
    assert fs.warm_thumbs([str(clip)])['skipped'] == 1
    assert calls == []


def test_each_sheet_input_decodes_one_keyframe_on_one_thread(cache, tmp_path, monkeypatch):
    calls = _captured(monkeypatch, duration=1000.0)
    clip = tmp_path / 'movie.mkv'
    clip.write_bytes(b'x')
    fs.thumbnail(str(clip))
    fs.upgrade_thumb(str(clip))
    assert calls and all('-skip_frame' in c and '-noaccurate_seek' in c
                         and c[c.index('-threads') + 1] == '1' for c in calls)


# --- quick first pass, sheet when idle -----------------------------------

def test_a_video_starts_quick_and_is_queued_for_its_sheet_while_viewed(
        cache, tmp_path, monkeypatch):
    _captured(monkeypatch, duration=100.0)
    monkeypatch.setattr(fs, '_ensure_upgrader', lambda: None)
    fs._upgrade_queue.clear()
    clip = tmp_path / 'a.mp4'
    clip.write_bytes(b'x')

    assert fs.thumb_status([str(clip)]) == {str(clip): 'waiting'}
    fs.thumbnail(str(clip))
    assert fs.thumb_status([str(clip)]) == {str(clip): 'quick'}
    assert len(fs._upgrade_queue) == 1

    assert not fs._upgrade_step(idle=0.1)       # busy box: wait
    assert fs._upgrade_step(idle=0.9)
    assert fs.thumb_status([str(clip)]) == {str(clip): 'ready'}
    assert not fs._upgrade_queue


def test_leaving_the_folder_drops_its_upgrades(cache, tmp_path, monkeypatch):
    _captured(monkeypatch, duration=100.0)
    monkeypatch.setattr(fs, '_ensure_upgrader', lambda: None)
    fs._upgrade_queue.clear()
    clip = tmp_path / 'b.mp4'
    clip.write_bytes(b'x')
    fs.thumbnail(str(clip))
    fs.thumb_status([str(clip)])

    later = time.time() + fs.PRESENCE_SECONDS + 1
    monkeypatch.setattr(fs.time, 'time', lambda: later)
    assert not fs._upgrade_step(idle=1.0)
    assert not fs._upgrade_queue


def test_no_upgrade_while_previews_are_still_being_made(cache, tmp_path, monkeypatch):
    _captured(monkeypatch, duration=100.0)
    monkeypatch.setattr(fs, '_ensure_upgrader', lambda: None)
    fs._upgrade_queue.clear()
    clip = tmp_path / 'c.mp4'
    clip.write_bytes(b'x')
    fs.thumbnail(str(clip))
    fs.thumb_status([str(clip)])
    fs._thumb_inflight['someone-else.jpg'] = object()
    try:
        assert not fs._upgrade_step(idle=1.0)
    finally:
        fs._thumb_inflight.pop('someone-else.jpg')


def test_a_failed_sheet_keeps_the_quick_frame_and_stops_trying(cache, tmp_path, monkeypatch):
    calls = _captured(monkeypatch, duration=100.0)
    clip = tmp_path / 'd.mp4'
    clip.write_bytes(b'x')
    quick = fs.thumbnail(str(clip))
    before = quick.read_bytes()
    monkeypatch.setattr(fs, '_run_ffmpeg', lambda cmd, out: False)
    fs.upgrade_thumb(str(clip))
    assert quick.read_bytes() == before
    assert json.loads(quick.with_suffix('.json').read_text())['stage'] == 'final'

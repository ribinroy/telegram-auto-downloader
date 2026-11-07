"""The rest of the local filesystem layer: mounts and roots, the odd entries
(broken links, unreadable folders), uploads, the deadlines on search and
sizing, transfer planning, and the thumbnail pipeline's edges - including two
runs of the real ffmpeg on a two-second generated clip, since the command
line it is given is the whole point of those functions."""
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import types

import pytest

from backend import files as fs
from backend.files import FsError

not_root = pytest.mark.skipif(os.geteuid() == 0, reason='root ignores permissions')
FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')


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


# --- mounts / roots ---------------------------------------------------------

def test_read_mounts_decodes_spaces_and_skips_short_lines(monkeypatch):
    real_open = open

    def fake_open(path, *a, **k):
        if path == '/proc/mounts':
            return io.StringIO('/dev/sda1 /mnt/my\\040disk ext4 rw 0 0\nshort\n')
        return real_open(path, *a, **k)
    monkeypatch.setattr('builtins.open', fake_open)
    assert fs._read_mounts() == [('/dev/sda1', '/mnt/my disk', 'ext4')]

    def broken_open(path, *a, **k):
        raise OSError('no proc')
    monkeypatch.setattr('builtins.open', broken_open)
    assert fs._read_mounts() == []


def test_mountpoint_for_picks_the_deepest_mount(monkeypatch):
    monkeypatch.setattr(fs, '_read_mounts', lambda: [
        ('/dev/root', '/', 'ext4'), ('/dev/a', '/mnt', 'ext4'), ('/dev/b', '/mnt/disk', 'ext4')])
    assert fs._mountpoint_for('/mnt/disk/Movies/a.mkv') == '/mnt/disk'
    assert fs._mountpoint_for('/mnt/other') == '/mnt'
    assert fs._mountpoint_for('/home/x') == '/'
    assert fs._mountpoint_for('/mnt/diskette') == '/mnt'     # prefix, not a path component


def test_usage_and_describe_root_tolerate_what_is_not_there(tmp_path):
    assert fs._usage(tmp_path / 'nope') is None
    assert fs.describe_root(tmp_path / 'nope', 'x', 'disk', 'drive') is None
    got = fs.describe_root(tmp_path, 'Here', 'disk', 'drive', note='n')
    assert got['path'] == str(tmp_path.resolve()) and got['usage']['total'] > 0 and got['writable']


def test_list_roots_filters_noise_and_dedupes(tmp_path, monkeypatch):
    data = tmp_path / 'data'
    data.mkdir()
    monkeypatch.setattr(fs, '_read_mounts', lambda: [
        ('proc', '/proc', 'proc'),                      # pseudo fs
        ('/dev/loop0', '/snap/core/1', 'squashfs'),     # snap
        ('/dev/sda2', '/boot', 'ext4'),                 # OS partition
        ('/dev/root', '/', 'ext4'),
        ('/dev/sdb1', str(data), 'ext4'),
        ('/dev/sdb1', str(data), 'ext4'),               # listed twice
        ('/dev/sdc1', str(tmp_path / 'gone'), 'ext4'),  # not a directory any more
    ])
    monkeypatch.setattr(fs, 'DOWNLOAD_DIR', data)        # same path as a disk: merged
    roots = fs.list_roots()
    by_path = {r['path']: r for r in roots}
    assert '/proc' not in by_path and '/boot' not in by_path
    assert not any(p.startswith('/snap') for p in by_path)
    assert by_path['/']['label'] == 'Filesystem' and by_path['/']['device'] == '/dev/root'
    disk = by_path[str(data.resolve())]
    assert disk['label'] == 'data' and disk['fstype'] == 'ext4' and disk['group'] == 'drive'
    assert [r['path'] for r in roots].count(str(data.resolve())) == 1
    assert any(r['kind'] == 'home' for r in roots)


# --- paths / guards ---------------------------------------------------------

def test_a_symlink_loop_is_a_clean_error_not_a_crash(tmp_path):
    loop = tmp_path / 'loop'
    loop.symlink_to(loop)
    with pytest.raises(FsError):
        fs.resolve_path(str(loop))


def test_guard_target_refuses_a_mount_point_on_a_data_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(fs, '_mountpoint_for', lambda p: str(tmp_path))
    monkeypatch.setattr(os.path, 'ismount', lambda p: p == str(tmp_path))
    fs.guard_write(str(tmp_path))                        # a disk: writes are fine
    with pytest.raises(FsError) as e:
        fs.guard_target(str(tmp_path))
    assert 'mount point' in e.value.message


# --- entries ----------------------------------------------------------------

def test_iso_of_nothing_is_none():
    assert fs._iso(None) is None and fs._iso(0) is None


def test_broken_symlinks_are_listed_as_broken(tmp_path):
    (tmp_path / 'dangling').symlink_to(tmp_path / 'missing')
    [entry] = fs.list_dir(str(tmp_path))['entries']
    assert entry['is_link'] and entry['broken'] and entry['size'] == 0 and entry['modified'] is None
    direct = fs.stat_entry(tmp_path / 'dangling')
    assert direct['broken'] is True and direct['mode'] is None


@not_root
def test_an_unreadable_folder_is_a_403(tmp_path):
    locked = tmp_path / 'locked'
    locked.mkdir()
    locked.chmod(0o000)
    try:
        with pytest.raises(FsError) as e:
            fs.list_dir(str(locked))
        assert e.value.status == 403
    finally:
        locked.chmod(0o755)


def test_list_dir_root_has_no_parent():
    assert fs.list_dir('/')['parent'] is None


# --- mutations ---------------------------------------------------------------

def test_make_dir_needs_a_directory_parent(tmp_tree):
    with pytest.raises(FsError):
        fs.make_dir(str(tmp_tree / 'notes.txt'), 'x')


@not_root
def test_make_dir_and_rename_report_the_os_error(tmp_tree):
    ro = tmp_tree / 'ro'
    ro.mkdir()
    (ro / 'f.txt').write_text('x')
    ro.chmod(0o555)
    try:
        with pytest.raises(FsError) as e:
            fs.make_dir(str(ro), 'sub')
        assert 'denied' in e.value.message.lower()
        with pytest.raises(FsError) as e:
            fs.rename(str(ro / 'f.txt'), 'g.txt')
        assert 'denied' in e.value.message.lower()
    finally:
        ro.chmod(0o755)


def test_rename_to_the_same_name_is_a_no_op(tmp_tree):
    got = fs.rename(str(tmp_tree / 'notes.txt'), 'notes.txt')
    assert got['name'] == 'notes.txt' and (tmp_tree / 'notes.txt').exists()


def test_root_filesystem_deletes_are_parked_next_to_the_app(monkeypatch):
    monkeypatch.setattr(fs, '_mountpoint_for', lambda p: '/')
    assert fs.trash_dir_for('/home/x/f') == fs.Path(fs.BASE_DIR) / '.trash'
    monkeypatch.setattr(fs, '_mountpoint_for', lambda p: '/mnt/disk')
    assert str(fs.trash_dir_for('/mnt/disk/f')) == '/mnt/disk/.downlee-trash'


def test_a_trash_move_that_fails_is_reported_per_path(tmp_tree, monkeypatch):
    monkeypatch.setattr(fs, 'trash_dir_for', lambda p: tmp_tree / 'notes.txt' / 'trash')
    [result] = fs.delete([str(tmp_tree / 'Movies' / 'a.mkv')])
    assert result['error'] and (tmp_tree / 'Movies' / 'a.mkv').exists()


def test_partial_delete_message_names_a_few_folders_and_counts_the_rest(tmp_path):
    root = tmp_path / 'Show'
    failures = [(str(root / 'top.nfo'), OSError(5, 'Input/output error'))]
    failures += [(str(root / f'd{i}' / 'f'), PermissionError(13, 'Permission denied')) for i in range(7)]
    msg = fs._partial_delete_message(root, failures)
    assert '8 item(s)' in msg and 'and 3 more folder(s)' in msg
    assert 'Blocked in: Show, d0' in msg and '(various errors)' in msg
    one = fs._partial_delete_message(root, [(str(root / 'x'), OSError('plain'))])
    assert one.endswith('(plain)')


@not_root
def test_remove_tree_keeps_going_on_the_pre_312_onerror_api(tmp_tree, monkeypatch):
    """The onerror callback hands over exc_info tuples; the record function
    must unwrap them the same way it takes onexc's bare exception."""
    monkeypatch.setattr(fs, 'sys', types.SimpleNamespace(version_info=(3, 11, 0)))
    movies = tmp_tree / 'Movies'
    locked = movies / 'locked'
    locked.mkdir()
    (locked / 'x.nfo').write_text('plex')
    locked.chmod(0o555)
    try:
        failures = fs._remove_tree(movies)
        assert [os.path.basename(p) for p, _e in failures] == ['x.nfo']
        assert isinstance(failures[0][1], PermissionError)
        assert not (movies / 'a.mkv').exists()
    finally:
        locked.chmod(0o755)


# --- transfers ---------------------------------------------------------------

def test_same_device_is_false_for_what_is_not_there(tmp_path):
    assert fs._same_device(tmp_path / 'nope', tmp_path) is False
    assert fs._same_device(tmp_path, tmp_path) is True


def test_transfer_plan_skips_missing_items_and_symlinks_inside_folders(tmp_tree):
    (tmp_tree / 'Movies' / 'link.mkv').symlink_to(tmp_tree / 'Movies' / 'a.mkv')
    plan = fs.transfer_plan([str(tmp_tree / 'nope'), str(tmp_tree / 'Movies')], tmp_tree / 'dest')
    assert [e['rel'] for e in plan] == ['Movies/a.mkv', 'Movies/nested/b.mp4']
    assert all(e['item'] == 1 for e in plan)


def test_transfer_plan_can_be_cancelled_while_walking(tmp_tree):
    with pytest.raises(fs.TransferCancelled):
        fs.transfer_plan([str(tmp_tree / 'Movies')], tmp_tree, cancelled=lambda: True)


def test_transfer_copies_a_symlink_as_a_link(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    link = tmp_tree / 'link.mkv'
    link.symlink_to(tmp_tree / 'Movies' / 'a.mkv')
    fs.transfer([str(link)], str(dest))
    assert (dest / 'link.mkv').is_symlink()


def test_a_cross_disk_move_with_a_job_handles_files_and_links(tmp_tree, monkeypatch):
    from backend import file_transfers as transfers
    monkeypatch.setattr(fs, '_same_device', lambda *_: False)
    dest = tmp_tree / 'dest'
    dest.mkdir()
    link = tmp_tree / 'link.txt'
    link.symlink_to(tmp_tree / 'notes.txt')
    job = transfers.TransferJob([str(tmp_tree / 'notes.txt'), str(link)], str(dest), move=True)
    job.run()
    assert job.status == 'done'
    assert (dest / 'notes.txt').read_text() == 'hello world\n' and (dest / 'link.txt').is_symlink()
    assert not (tmp_tree / 'notes.txt').exists() and not link.is_symlink()


def test_short_error_summarises_a_copytree_error_list():
    assert fs._short_error(shutil.Error([('a', 'b', 'why'), ('c', 'd', 'why')])) == '2 file(s) failed'
    assert fs._short_error(OSError(13, 'Permission denied')) == 'Permission denied'
    assert fs._short_error(shutil.Error('plain')) == 'plain'


def test_remove_source_and_discard_partial_cover_files_folders_and_nothing(tmp_tree):
    fs.remove_source(tmp_tree / 'notes.txt')
    assert not (tmp_tree / 'notes.txt').exists()
    fs.remove_source(tmp_tree / 'Movies')
    assert not (tmp_tree / 'Movies').exists()
    fs._discard_partial(None)
    fs._discard_partial(tmp_tree / 'never')
    d = tmp_tree / 'half'
    d.mkdir()
    (d / 'f').write_text('x')
    fs._discard_partial(d)
    assert not d.exists()
    (tmp_tree / 'one').write_text('x')
    fs._discard_partial(tmp_tree / 'one')
    assert not (tmp_tree / 'one').exists()


# --- uploads -------------------------------------------------------------------

class _Stream:
    def __init__(self, data=b'bytes', fail=False):
        self.data, self.fail = data, fail

    def save(self, path):
        if self.fail:
            raise OSError(28, 'No space left on device')
        with open(path, 'wb') as f:
            f.write(self.data)


def test_save_upload_never_clobbers_and_strips_any_path(tmp_tree):
    got = fs.save_upload(str(tmp_tree), '../evil/notes.txt', _Stream(b'new'))
    assert got['name'] == 'notes (2).txt'                # the existing notes.txt is untouched
    assert (tmp_tree / 'notes (2).txt').read_bytes() == b'new'
    assert (tmp_tree / 'notes.txt').read_text() == 'hello world\n'
    with pytest.raises(FsError):
        fs.save_upload(str(tmp_tree / 'notes.txt'), 'x', _Stream())
    with pytest.raises(FsError) as e:
        fs.save_upload(str(tmp_tree), 'big.bin', _Stream(fail=True))
    assert 'space' in e.value.message


# --- search / size / text ----------------------------------------------------

def test_search_and_dir_size_stop_at_their_deadline(tmp_tree, monkeypatch):
    with pytest.raises(FsError):
        fs.search(str(tmp_tree / 'notes.txt'), 'mkv')
    clock = iter([0.0, 100.0, 200.0, 300.0, 400.0])
    own_time(monkeypatch, fs, monotonic=lambda: next(clock))
    got = fs.search(str(tmp_tree), 'zzz-nothing', timeout=10)
    assert got['truncated'] is True and got['entries'] == []

    clock = iter([0.0, 100.0, 200.0])
    got = fs.dir_size(str(tmp_tree), timeout=10)
    assert got['partial'] is True


def test_dir_size_of_a_file_is_its_size(tmp_tree):
    got = fs.dir_size(str(tmp_tree / 'notes.txt'))
    assert got == {'path': str(tmp_tree / 'notes.txt'), 'size': 12, 'files': 1, 'dirs': 0, 'partial': False}


# --- thumbnails: the cache's edges -------------------------------------------

@pytest.fixture
def cache(tmp_path, monkeypatch):
    monkeypatch.setattr(fs, 'THUMB_CACHE', tmp_path / 'cache')
    monkeypatch.setattr(fs, 'SETTLING_SECONDS', 0)
    fs._thumb_inflight.clear()
    fs._thumb_failed.clear()
    fs._upgrade_queue.clear()
    yield tmp_path / 'cache'
    fs._thumb_inflight.clear()
    fs._thumb_failed.clear()
    fs._upgrade_queue.clear()


@pytest.fixture
def png(tmp_path):
    Image = pytest.importorskip('PIL.Image')
    p = tmp_path / 'shot.png'
    Image.new('RGB', (300, 200), 'navy').save(p)
    return p


def test_a_sidecar_that_cannot_be_written_is_not_fatal(tmp_path):
    missing = tmp_path / 'nodir' / 'x.jpg'
    fs._write_sidecar(missing, tmp_path, tmp_path.stat(), '1x1')      # no raise
    assert fs._sidecar(missing) is None


def test_pruning_an_absent_cache_is_a_no_op(cache):
    assert fs.prune_thumb_cache() == {'checked': 0, 'deleted': 0, 'kept': 0, 'freed': 0, 'migrated': 0}


@not_root
def test_pruning_skips_what_it_cannot_delete(cache):
    cache.mkdir(parents=True)
    (cache / 'dead.jpg').write_bytes(b'jpeg')
    (cache / 'orphan.json').write_text('{}')
    cache.chmod(0o555)
    try:
        stats = fs.prune_thumb_cache()
        assert stats['checked'] == 1 and stats['deleted'] == 0
        assert (cache / 'dead.jpg').exists() and (cache / 'orphan.json').exists()
    finally:
        cache.chmod(0o755)


def test_thumb_target_and_status_for_what_cannot_have_a_preview(cache, tmp_path):
    assert fs._thumb_target(str(tmp_path)) is None
    assert fs.thumb_status(['relative.png', str(tmp_path), str(tmp_path / 'gone.png')]) == {
        'relative.png': 'none', str(tmp_path): 'none', str(tmp_path / 'gone.png'): 'none'}
    assert fs.upgrade_thumb(str(tmp_path)) is None


def test_thumb_status_reports_a_preview_being_made(cache, png):
    _path, cached, _kind, _st = fs._thumb_target(str(png))
    fs._thumb_inflight[cached.name] = object()
    try:
        assert fs.thumb_status([str(png)]) == {str(png): 'pending'}
    finally:
        fs._thumb_inflight.pop(cached.name)


def test_a_warm_up_the_request_beat_to_it_returns_the_cached_file(cache, png):
    made = fs.thumbnail(str(png))
    path, cached, kind, st = fs._thumb_target(str(png))
    assert fs._generate(path, cached, kind, st) == made


def test_a_generator_that_raises_marks_the_file_failed(cache, png, monkeypatch):
    def boom(*_a):
        raise RuntimeError('decoder crashed')
    monkeypatch.setattr(fs, '_image_thumb', boom)
    assert fs.thumbnail(str(png)) is None
    assert fs._thumb_failed and not list(cache.glob('*'))


def test_without_pillow_an_image_is_served_as_is(cache, png, monkeypatch):
    monkeypatch.setitem(sys.modules, 'PIL', None)
    monkeypatch.setitem(sys.modules, 'PIL.Image', None)
    monkeypatch.setitem(sys.modules, 'PIL.ImageOps', None)
    assert fs.thumbnail(str(png)) == png              # the original, no cache entry
    assert not list(cache.glob('*.jpg'))


def test_a_corrupt_image_has_no_preview(cache, tmp_path):
    pytest.importorskip('PIL.Image')
    bad = tmp_path / 'bad.png'
    bad.write_bytes(b'not a png')
    assert fs._image_thumb(bad, tmp_path / 'out.jpg') is None
    assert fs.thumbnail(str(bad)) is None


def test_an_upgrade_of_a_final_entry_or_a_crashing_sheet_leaves_it_be(cache, png, monkeypatch):
    made = fs.thumbnail(str(png))                       # an image: stage final
    assert fs.upgrade_thumb(str(png)) == made
    # Pretend it is a quick video frame whose sheet crashes
    meta = json.loads(made.with_suffix('.json').read_text())
    meta['stage'] = 'quick'
    made.with_suffix('.json').write_text(json.dumps(meta))

    def crash(*_a):
        raise RuntimeError('ffmpeg exploded')
    monkeypatch.setattr(fs, '_video_duration', lambda p: 10.0)
    monkeypatch.setattr(fs, '_video_sheet', crash)
    before = made.read_bytes()
    assert fs.upgrade_thumb(str(png)) == made
    assert made.read_bytes() == before and not list(cache.glob('*.tmp'))


def test_the_sheet_needs_a_duration_and_can_use_xstack_without_pillow(tmp_path, monkeypatch):
    out = tmp_path / 'sheet.jpg'
    assert fs._video_sheet(tmp_path / 'clip.mp4', out, None) is None
    assert fs._video_sheet(tmp_path / 'clip.mp4', out, 0.5) is None
    monkeypatch.setitem(sys.modules, 'PIL', None)
    monkeypatch.setitem(sys.modules, 'PIL.Image', None)
    calls = []

    def fake_run(cmd, o):
        calls.append(cmd)
        o.write_bytes(b'jpeg')
        return True
    monkeypatch.setattr(fs, '_run_ffmpeg', fake_run)
    assert fs._video_sheet(tmp_path / 'clip.mp4', out, 100.0) == out
    [cmd] = calls
    assert cmd.count('-i') == 4 and 'xstack=inputs=4' in ' '.join(cmd)
    assert [cmd[i + 1] for i, a in enumerate(cmd) if a == '-ss'] == ['20.000', '40.000', '60.000', '80.000']
    monkeypatch.setattr(fs, '_run_ffmpeg', lambda cmd, o: False)
    assert fs._video_sheet(tmp_path / 'clip.mp4', out, 100.0) is None


def test_a_parallel_sheet_resizes_odd_frames_and_fails_on_a_bad_one(tmp_path, monkeypatch):
    Image = pytest.importorskip('PIL.Image')
    sizes = iter([(48, 27), (24, 14), (48, 27), (48, 27)])

    def fake_run(cmd, o):
        Image.new('RGB', next(sizes), 'teal').save(o, 'JPEG')
        return True
    monkeypatch.setattr(fs, '_run_ffmpeg', fake_run)
    out = tmp_path / 'sheet.jpg'
    assert fs._parallel_sheet('ffmpeg', tmp_path / 'c.mp4', ['1', '2', '3', '4'], out) is True
    assert Image.open(out).size == (96, 54)
    assert not list(tmp_path.glob('*.tmp'))

    def junk(cmd, o):
        o.write_bytes(b'not a jpeg')
        return True
    monkeypatch.setattr(fs, '_run_ffmpeg', junk)
    assert fs._parallel_sheet('ffmpeg', tmp_path / 'c.mp4', ['1', '2', '3', '4'], out) is False
    assert not list(tmp_path.glob('*.tmp'))


def test_tiling_a_frame_that_is_not_an_image_leaves_it_alone(tmp_path):
    frame = tmp_path / 'f.jpg'
    frame.write_bytes(b'nope')
    assert fs._tile_single(frame) == frame and frame.read_bytes() == b'nope'


def test_ffmpeg_runs_in_the_background_even_when_nice_refuses(monkeypatch):
    def refuse(_n):
        raise OSError('not permitted')
    monkeypatch.setattr(os, 'nice', refuse)
    fs._background()                                     # no raise


def test_run_ffmpeg_reports_a_missing_binary_or_empty_output(tmp_path):
    out = tmp_path / 'o.jpg'
    assert fs._run_ffmpeg(['/nonexistent/ffmpeg', '-x'], out) is False
    assert fs._run_ffmpeg(['true'], out) is False          # exit 0 but nothing written


def test_video_duration_of_junk_is_none(tmp_path):
    junk = tmp_path / 'junk.mp4'
    junk.write_bytes(b'x')
    assert fs._video_duration(junk) is None


# --- the real ffmpeg, on a generated two-second clip --------------------------

@pytest.fixture(scope='module')
def clip(tmp_path_factory):
    if not FFMPEG:
        pytest.skip('ffmpeg/ffprobe not installed')
    p = tmp_path_factory.mktemp('clip') / 'tiny.mp4'
    subprocess.run([shutil.which('ffmpeg'), '-y', '-loglevel', 'error', '-f', 'lavfi',
                    '-i', 'testsrc=duration=2:size=64x36:rate=10', '-pix_fmt', 'yuv420p', str(p)],
                   check=True, timeout=60)
    return p


def test_the_real_ffprobe_reads_the_duration(clip):
    assert fs._video_duration(clip) == pytest.approx(2.0, abs=0.2)


def test_the_real_ffmpeg_makes_a_quick_frame_and_then_a_sheet(cache, clip):
    Image = pytest.importorskip('PIL.Image')
    quick = fs.thumbnail(str(clip))
    assert quick and quick.exists()
    # scale=480:-2 of a 64x36 frame is 480x270; tiled 2x2 that is 960x540
    with Image.open(quick) as im:
        assert im.size == (960, 540)
    assert fs._sidecar(quick)['stage'] == 'quick'
    sheet = fs.upgrade_thumb(str(clip))
    assert fs._sidecar(sheet)['stage'] == 'final' and fs._sidecar(sheet)['layout'] == '2x2'
    with Image.open(sheet) as im:
        assert im.size == (960, 540)
    assert not list(cache.glob('*.tmp'))


# --- the upgrader thread --------------------------------------------------------

def test_cpu_sampling_reads_proc_stat_and_tolerates_its_absence(monkeypatch):
    sample = fs._cpu_sample()
    assert sample is None or (len(sample) == 2 and sample[1] >= sample[0])
    assert fs._idle_since(None) == (0.0, sample) or fs._idle_since(None)[0] == 0.0
    assert fs._idle_since((0, 100))[0] >= 0.0
    assert fs._idle_since((10 ** 18, 10 ** 19)) == (0.0, fs._cpu_sample())   # counters went backwards

    real_open = open

    def no_proc(path, *a, **k):
        if path == '/proc/stat':
            raise OSError('no proc')
        return real_open(path, *a, **k)
    monkeypatch.setattr('builtins.open', no_proc)
    assert fs._cpu_sample() is None
    assert fs._idle_since((1, 2)) == (0.0, None)


def test_the_upgrade_loop_ticks_and_survives_a_failing_step(monkeypatch):
    class Stop(BaseException):
        pass
    ticks = []

    def sleep(_s):
        ticks.append(1)
        if len(ticks) > 3:
            raise Stop()
    outcomes = iter([RuntimeError('bad file'), True, False])

    def step(idle):
        o = next(outcomes)
        if isinstance(o, Exception):
            raise o
        return o
    own_time(monkeypatch, fs, sleep=sleep)
    monkeypatch.setattr(fs, '_upgrade_step', step)
    with pytest.raises(Stop):
        fs._upgrade_loop()
    assert len(ticks) == 4


def test_ensure_upgrader_starts_one_thread_only(monkeypatch):
    started = threading.Event()
    monkeypatch.setattr(fs, '_upgrade_loop', started.set)
    monkeypatch.setattr(fs, '_upgrader', None)
    fs._ensure_upgrader()
    first = fs._upgrader
    assert started.wait(5) and first.name == 'thumb-upgrade' and first.daemon
    first.join(5)
    fs._ensure_upgrader()                                # the first died: a new one
    assert fs._upgrader is not first
    fs._upgrader.join(5)

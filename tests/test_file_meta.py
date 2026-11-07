"""Video metadata: the ffprobe wrapper, what is kept of its output, where a
download's file is looked for, and the poll-probe-thumbnail flow that runs
behind every video download. ffprobe/ffmpeg are faked with scripted
subprocesses; one small real run at the end is skipped where they're absent."""
import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from backend import file_meta
from backend.config import DOWNLOAD_DIR


PROBE = {
    'streams': [
        {'codec_type': 'video', 'codec_name': 'hevc', 'width': 1920, 'height': 1080,
         'bit_rate': '5000000', 'r_frame_rate': '30000/1001', 'pix_fmt': 'yuv420p10le'},
        {'codec_type': 'video', 'codec_name': 'mjpeg', 'width': 1, 'height': 1},   # cover art
        {'codec_type': 'audio', 'codec_name': 'aac', 'channels': '2',
         'sample_rate': '48000', 'bit_rate': '128000'},
        {'codec_type': 'audio', 'codec_name': 'ac3'},                               # second track
        {'codec_type': 'subtitle', 'codec_name': 'subrip'},
    ],
    'format': {'duration': '123.456', 'format_name': 'matroska,webm'},
}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class FakeProc:
    """What asyncio.create_subprocess_exec hands back, scripted."""

    def __init__(self, stdout=b'', stderr=b'', returncode=0, raise_on_communicate=None,
                 on_start=None):
        self._stdout, self._stderr = stdout, stderr
        self.returncode = None
        self._final = returncode
        self._raise = raise_on_communicate
        self.killed = False
        self._on_start = on_start

    async def communicate(self):
        if self._raise:
            raise self._raise
        self.returncode = self._final
        return self._stdout, self._stderr

    async def wait(self):
        if self._on_start:
            self._on_start()
        self.returncode = self._final
        return self.returncode

    def kill(self):
        self.killed = True


@pytest.fixture
def fake_exec(monkeypatch):
    """Scripts asyncio.create_subprocess_exec: `script(argv) -> FakeProc`."""
    calls = []
    state = {'script': lambda argv: FakeProc(json.dumps(PROBE).encode())}

    async def exec_(*argv, **kw):
        calls.append(list(argv))
        proc = state['script'](argv)
        if isinstance(proc, Exception):
            raise proc
        return proc

    monkeypatch.setattr(asyncio, 'create_subprocess_exec', exec_)

    def set_(script):
        state['script'] = script
    set_.calls = calls
    return set_


# --- probe_video ------------------------------------------------------------

def test_probe_parses_ffprobe_json(fake_exec):
    assert run(file_meta.probe_video('/x.mkv')) == PROBE
    argv = fake_exec.calls[0]
    assert argv[0] == file_meta.FFPROBE_PATH and argv[-1] == '/x.mkv'
    assert '-show_streams' in argv and '-show_format' in argv


def test_probe_returns_none_on_a_non_zero_exit(fake_exec):
    fake_exec(lambda argv: FakeProc(b'', b'Invalid data found', returncode=1))
    assert run(file_meta.probe_video('/x.mkv')) is None


def test_probe_returns_none_on_garbage_output(fake_exec):
    fake_exec(lambda argv: FakeProc(b'not json'))
    assert run(file_meta.probe_video('/x.mkv')) is None


def test_probe_kills_a_hung_ffprobe_on_timeout(fake_exec):
    procs = []

    def script(argv):
        procs.append(FakeProc(raise_on_communicate=asyncio.TimeoutError()))
        return procs[-1]
    fake_exec(script)
    assert run(file_meta.probe_video('/x.mkv')) is None
    assert procs[0].killed is True


def test_probe_survives_a_missing_ffprobe_binary(fake_exec):
    fake_exec(lambda argv: FileNotFoundError('ffprobe'))
    assert run(file_meta.probe_video('/x.mkv')) is None


# --- extract_meta -----------------------------------------------------------

def test_extract_meta_keeps_the_first_video_and_audio_stream():
    meta = file_meta.extract_meta(PROBE)
    assert meta['video'] == {'codec': 'hevc', 'width': 1920, 'height': 1080,
                             'bitrate': 5000000, 'fps': 29.97, 'bit_depth': 10}
    assert meta['audio'] == {'codec': 'aac', 'channels': 2, 'sample_rate': 48000,
                             'bitrate': 128000}
    assert meta['duration'] == 123.46
    assert meta['format'] == 'matroska,webm'


@pytest.mark.parametrize('stream,depth', [
    ({'bits_per_raw_sample': '8', 'pix_fmt': 'yuv420p10le'}, 8),   # explicit beats pix_fmt
    ({'pix_fmt': 'yuv420p'}, 8),                                     # no digits after p
    ({'pix_fmt': 'rgb24'}, 8),
    ({'pix_fmt': 'yuv422p12le'}, 12),
    ({}, None),                                                      # nothing to go on
])
def test_extract_meta_bit_depth(stream, depth):
    data = {'streams': [{'codec_type': 'video', **stream}], 'format': {}}
    assert file_meta.extract_meta(data)['video'].get('bit_depth') == depth


def test_extract_meta_skips_a_zero_denominator_frame_rate():
    data = {'streams': [{'codec_type': 'video', 'r_frame_rate': '0/0'}], 'format': {}}
    assert 'fps' not in file_meta.extract_meta(data)['video']


def test_extract_meta_of_an_audio_only_file_has_no_video():
    data = {'streams': [{'codec_type': 'audio', 'codec_name': 'mp3'}],
            'format': {'duration': '3'}}
    meta = file_meta.extract_meta(data)
    assert 'video' not in meta and meta['audio'] == {'codec': 'mp3'} and meta['duration'] == 3.0


def test_extract_meta_of_empty_probe_output():
    assert file_meta.extract_meta({}) == {}


# --- find_file / is_video_file ------------------------------------------------

@pytest.mark.parametrize('name,video', [
    ('a.mkv', True), ('a.MP4', True), ('a.webm', True), ('a.jpg', False),
    ('noext', False), ('a.mkv.part', False),
])
def test_is_video_file(name, video):
    assert file_meta.is_video_file(name) is video


def test_find_file_checks_the_default_folders(db):
    (DOWNLOAD_DIR / 'Videos').mkdir(exist_ok=True)
    (DOWNLOAD_DIR / 'Videos' / 'ff-1.mkv').write_bytes(b'x')
    (DOWNLOAD_DIR / 'ff-2.mkv').write_bytes(b'x')
    assert file_meta.find_file('ff-1.mkv', 'telegram') == DOWNLOAD_DIR / 'Videos' / 'ff-1.mkv'
    assert file_meta.find_file('ff-2.mkv', None) == DOWNLOAD_DIR / 'ff-2.mkv'
    assert file_meta.find_file('ff-nope.mkv', 'telegram') is None


def test_find_file_looks_in_the_vps_folder_and_the_watched_folders_destination(db, tmp_path):
    (DOWNLOAD_DIR / 'VPS').mkdir(exist_ok=True)
    (DOWNLOAD_DIR / 'VPS' / 'ff-3.mkv').write_bytes(b'x')
    assert file_meta.find_file('ff-3.mkv', 'vps', '/remote/ff-3.mkv') == DOWNLOAD_DIR / 'VPS' / 'ff-3.mkv'

    wf = db.add_vps_watch_folder('/remote/tv', host='h', username='u')
    db.update_vps_watch_folder(wf['id'], folder=str(tmp_path))
    (tmp_path / 'ff-3.mkv').write_bytes(b'x')
    # The watched folder's destination outranks the VPS default
    assert file_meta.find_file('ff-3.mkv', 'vps', '/remote/tv/ff-3.mkv') == tmp_path / 'ff-3.mkv'


def test_find_file_prefers_the_sources_mapped_folder(db, tmp_path):
    db.add_download_type_map('youtube.com', folder=str(tmp_path))
    (tmp_path / 'clip.mp4').write_bytes(b'x')
    (DOWNLOAD_DIR / 'clip.mp4').write_bytes(b'x')
    assert file_meta.find_file('clip.mp4', 'youtube.com') == tmp_path / 'clip.mp4'


# --- extract_and_store_meta -------------------------------------------------

@pytest.fixture
def events(monkeypatch):
    sent = []
    monkeypatch.setattr(file_meta, '_emit_event', lambda e, d: sent.append((e, d)))
    return sent


def test_store_meta_writes_the_record_and_tells_the_frontend(db, fake_exec, events):
    (DOWNLOAD_DIR / 'sm-1.mkv').write_bytes(b'x')
    db.add_download(file='sm-1.mkv', status='downloading', message_id='sm-1')
    assert run(file_meta.extract_and_store_meta('sm-1')) is True
    row = db.get_download_by_message_id('sm-1')
    assert row['file_meta']['video']['width'] == 1920
    assert events == [('download:meta', {'message_id': 'sm-1', 'file_meta': row['file_meta']})]


def test_store_meta_is_a_noop_when_meta_is_already_there(db, fake_exec, events):
    db.add_download(file='sm-2.mkv', status='done', message_id='sm-2')
    db.update_download_by_message_id('sm-2', file_meta=json.dumps({'video': {}}))
    assert run(file_meta.extract_and_store_meta('sm-2')) is True
    assert fake_exec.calls == [] and events == []


@pytest.mark.parametrize('setup', ['missing', 'not_video', 'no_file_on_disk', 'probe_fails', 'no_video_stream'])
def test_store_meta_declines_when_it_cannot(db, fake_exec, events, setup):
    if setup == 'missing':
        assert run(file_meta.extract_and_store_meta('nope')) is False
        return
    name = 'sm-3.txt' if setup == 'not_video' else 'sm-3.mkv'
    db.add_download(file=name, status='downloading', message_id='sm-3')
    if setup != 'no_file_on_disk':
        (DOWNLOAD_DIR / name).write_bytes(b'x')
    if setup == 'probe_fails':
        fake_exec(lambda argv: FakeProc(returncode=1))
    if setup == 'no_video_stream':
        fake_exec(lambda argv: FakeProc(json.dumps({'streams': [{'codec_type': 'audio'}]}).encode()))
    assert run(file_meta.extract_and_store_meta('sm-3')) is False
    assert db.get_download_by_message_id('sm-3')['file_meta'] is None
    assert events == []


def test_emit_event_swallows_a_missing_socket(monkeypatch):
    monkeypatch.setattr('backend.web_app.get_socketio', lambda: None)
    file_meta._emit_event('x', {})          # no socket, no error

    class Boom:
        def emit(self, *a):
            raise RuntimeError('socket down')
    monkeypatch.setattr('backend.web_app.get_socketio', lambda: Boom())
    file_meta._emit_event('x', {})          # swallowed


# --- thumbnails -----------------------------------------------------------------

@pytest.fixture
def thumbs_dir(tmp_path, monkeypatch):
    d = tmp_path / 'thumbs'
    monkeypatch.setattr(file_meta, 'THUMBS_DIR', d)
    return d


def ffmpeg_that_writes(argv):
    """An ffmpeg stand-in that produces its output file (the last argument)."""
    out = Path(argv[-1])
    return FakeProc(returncode=0, on_start=lambda: out.write_bytes(b'\xff\xd8jpeg'))


def test_generate_thumbnails_makes_one_per_position(db, fake_exec, events, thumbs_dir):
    row = db.add_download(file='t.mkv', status='done', message_id='th-1')
    fake_exec(ffmpeg_that_writes)
    made = run(file_meta.generate_thumbnails(row['id'], '/v/t.mkv', 100.0))
    assert made == len(file_meta.THUMB_POSITIONS)
    assert sorted(p.name for p in (thumbs_dir / str(row['id'])).iterdir()) == \
        sorted(f'{i}.jpg' for i in range(1, made + 1))
    # Seek points are the positions times the duration
    seeks = sorted(float(argv[argv.index('-ss') + 1]) for argv in fake_exec.calls)
    assert seeks == pytest.approx(sorted(100.0 * p for p in file_meta.THUMB_POSITIONS))
    assert db.get_download_by_id(row['id'])['thumb_count'] == made
    assert events == [('download:thumbs', {'download_id': row['id'], 'thumb_count': made})]


def test_generate_thumbnails_removes_the_folder_when_nothing_came_out(db, fake_exec, events, thumbs_dir):
    row = db.add_download(file='t.mkv', status='done', message_id='th-2')
    fake_exec(lambda argv: FakeProc(returncode=1))
    assert run(file_meta.generate_thumbnails(row['id'], '/v/t.mkv', 100.0)) == 0
    assert not (thumbs_dir / str(row['id'])).exists()
    assert db.get_download_by_id(row['id'])['thumb_count'] == 0 and events == []


def test_generate_thumbnails_counts_only_the_frames_that_landed(db, fake_exec, events, thumbs_dir):
    """An exit code 0 with no file (ffmpeg seeking past the end) is a miss."""
    row = db.add_download(file='t.mkv', status='done', message_id='th-3')

    def script(argv):
        out = Path(argv[-1])
        if out.name in ('1.jpg', '2.jpg'):
            return ffmpeg_that_writes(argv)
        if out.name == '3.jpg':
            return FakeProc(raise_on_communicate=None)   # exit 0, no file
        return FakeProc(returncode=1)
    fake_exec(script)
    assert run(file_meta.generate_thumbnails(row['id'], '/v/t.mkv', 10.0)) == 2


def test_generate_thumbnails_survives_a_missing_ffmpeg(db, fake_exec, events, thumbs_dir):
    """ffmpeg not installed must read as "no thumbnails", not take the
    metadata task down with an exception."""
    row = db.add_download(file='t.mkv', status='done', message_id='th-4')
    fake_exec(lambda argv: FileNotFoundError('ffmpeg'))
    assert run(file_meta.generate_thumbnails(row['id'], '/v/t.mkv', 10.0)) == 0


def test_generate_thumbnails_kills_a_hung_ffmpeg(db, fake_exec, thumbs_dir, monkeypatch):
    row = db.add_download(file='t.mkv', status='done', message_id='th-5')
    procs = []

    class Hung(FakeProc):
        async def wait(self):
            raise asyncio.TimeoutError()

    def script(argv):
        procs.append(Hung())
        return procs[-1]
    fake_exec(script)
    assert run(file_meta.generate_thumbnails(row['id'], '/v/t.mkv', 10.0)) == 0
    assert all(p.killed for p in procs)


def test_delete_thumbnails_removes_the_folder_and_resets_the_count(db, thumbs_dir):
    row = db.add_download(file='t.mkv', status='done', message_id='th-6')
    db.update_download_by_id(row['id'], thumb_count=3)
    (thumbs_dir / str(row['id'])).mkdir(parents=True)
    (thumbs_dir / str(row['id']) / '1.jpg').write_bytes(b'x')
    file_meta.delete_thumbnails(row['id'])
    assert not (thumbs_dir / str(row['id'])).exists()
    assert db.get_download_by_id(row['id'])['thumb_count'] == 0
    file_meta.delete_thumbnails(row['id'])   # nothing there: still fine
    assert file_meta.get_thumbs_dir() == thumbs_dir


# --- the background poll ---------------------------------------------------------

class ScriptedDB:
    """get_download_by_message_id answers from a script: each call pops the
    next row, the last one sticks. None means "the download is gone"."""

    def __init__(self, *rows):
        self.rows = list(rows)
        self.updates = []

    def get_download_by_message_id(self, _msg_id):
        row = self.rows.pop(0) if len(self.rows) > 1 else self.rows[0]
        return dict(row) if row else None

    def update_download_by_message_id(self, msg_id, **kw):
        self.updates.append(kw)
        # The real to_dict() hands file_meta back parsed
        if isinstance(kw.get('file_meta'), str):
            kw = {**kw, 'file_meta': json.loads(kw['file_meta'])}
        for row in self.rows:
            if row:
                row.update(kw)

    def update_download_by_id(self, _id, **kw):
        self.updates.append(kw)


def dl(**over):
    base = {'id': 7, 'message_id': 'pm', 'file': 'clip.mkv', 'status': 'downloading',
            'downloaded_bytes': 0, 'file_meta': None, 'downloaded_from': 'telegram', 'url': None}
    base.update(over)
    return base


@pytest.fixture
def poll(db, monkeypatch, fake_exec, events, thumbs_dir):
    monkeypatch.setattr(file_meta, 'POLL_INTERVAL', 0)
    made = []

    async def gen(download_id, path, duration):
        made.append((download_id, path, duration))
        return 3
    monkeypatch.setattr(file_meta, 'generate_thumbnails', gen)

    def with_db(*rows):
        scripted = ScriptedDB(*rows)
        monkeypatch.setattr(file_meta, 'get_db', lambda: scripted)
        return scripted
    with_db.made = made
    return with_db


def test_poll_gives_up_on_a_download_that_disappears(poll):
    poll(None)
    run(file_meta.poll_and_extract_meta('pm'))
    assert poll.made == []


def test_poll_gives_up_once_the_download_fails_before_it_can_probe(poll):
    db = poll(dl(downloaded_bytes=10), dl(status='failed', downloaded_bytes=10))
    run(file_meta.poll_and_extract_meta('pm'))
    assert db.updates == [] and poll.made == []


def test_poll_ignores_a_non_video(poll, fake_exec):
    poll(dl(file='doc.pdf'))
    run(file_meta.poll_and_extract_meta('pm'))
    assert fake_exec.calls == []


def test_poll_stops_when_meta_is_already_stored(poll, fake_exec):
    poll(dl(file_meta={'video': {}}))
    run(file_meta.poll_and_extract_meta('pm'))
    assert fake_exec.calls == [] and poll.made == []


def test_poll_waits_for_enough_bytes_then_probes_then_thumbnails_on_completion(poll, fake_exec, events):
    (DOWNLOAD_DIR / 'clip.mkv').write_bytes(b'x')
    db = poll(
        dl(downloaded_bytes=100),                               # too little to probe
        dl(downloaded_bytes=file_meta.MIN_BYTES_FOR_PROBE),     # phase 1 done
        dl(downloaded_bytes=file_meta.MIN_BYTES_FOR_PROBE),     # phase 2 probes it
        dl(status='done', downloaded_bytes=5 * 10 ** 6),        # phase 3
    )
    run(file_meta.poll_and_extract_meta('pm'))
    assert len(fake_exec.calls) == 1                            # one probe
    assert 'file_meta' in db.updates[0]
    assert poll.made == [(7, str(DOWNLOAD_DIR / 'clip.mkv'), 123.46)]
    assert events[0][0] == 'download:meta'


def test_poll_keeps_probing_while_ffprobe_fails_and_stops_when_the_download_ends(poll, fake_exec):
    (DOWNLOAD_DIR / 'clip.mkv').write_bytes(b'x')
    fake_exec(lambda argv: FakeProc(returncode=1))
    poll(dl(downloaded_bytes=file_meta.MIN_BYTES_FOR_PROBE),
         dl(downloaded_bytes=file_meta.MIN_BYTES_FOR_PROBE),
         dl(status='done'))
    run(file_meta.poll_and_extract_meta('pm'))
    assert len(fake_exec.calls) >= 2 and poll.made == []


def test_poll_notices_meta_stored_by_someone_else(poll, fake_exec):
    """A probe elsewhere (the sync job) landing between the phases counts."""
    (DOWNLOAD_DIR / 'clip.mkv').write_bytes(b'x')
    poll(dl(downloaded_bytes=file_meta.MIN_BYTES_FOR_PROBE),
         dl(status='done', file_meta={'video': {}, 'duration': 9.0}))
    run(file_meta.poll_and_extract_meta('pm'))
    assert fake_exec.calls == []
    assert poll.made == [(7, str(DOWNLOAD_DIR / 'clip.mkv'), 9.0)]


def test_poll_skips_thumbnails_without_a_duration(poll, fake_exec):
    (DOWNLOAD_DIR / 'clip.mkv').write_bytes(b'x')
    fake_exec(lambda argv: FakeProc(json.dumps({'streams': [{'codec_type': 'video'}], 'format': {}}).encode()))
    poll(dl(status='done'))
    run(file_meta.poll_and_extract_meta('pm'))
    assert poll.made == []


def test_poll_skips_thumbnails_when_the_file_moved_before_completion(poll, fake_exec):
    (DOWNLOAD_DIR / 'clip.mkv').write_bytes(b'x')
    db = poll(dl(downloaded_bytes=file_meta.MIN_BYTES_FOR_PROBE),
              dl(downloaded_bytes=file_meta.MIN_BYTES_FOR_PROBE),
              dl(status='done'))
    original = db.get_download_by_message_id

    def vanish(msg_id):
        row = original(msg_id)
        if row and row.get('status') == 'done':
            (DOWNLOAD_DIR / 'clip.mkv').unlink(missing_ok=True)
        return row
    db.get_download_by_message_id = vanish
    run(file_meta.poll_and_extract_meta('pm'))
    assert poll.made == []


# --- one real run -------------------------------------------------------------------

HAVE_FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')


@pytest.mark.skipif(not HAVE_FFMPEG, reason='ffmpeg/ffprobe not installed')
def test_real_ffprobe_and_ffmpeg_on_a_tiny_clip(db, tmp_path, events, thumbs_dir):
    clip = tmp_path / 'tiny.mp4'
    subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-f', 'lavfi',
                    '-i', 'testsrc=duration=1:size=64x48:rate=5', '-pix_fmt', 'yuv420p',
                    '-y', str(clip)], check=True, timeout=60)
    probe = run(file_meta.probe_video(str(clip)))
    meta = file_meta.extract_meta(probe)
    assert (meta['video']['width'], meta['video']['height']) == (64, 48)
    assert 0.9 <= meta['duration'] <= 1.1

    row = db.add_download(file='tiny.mp4', status='done', message_id='real-1')
    made = run(file_meta.generate_thumbnails(row['id'], str(clip), meta['duration']))
    assert made >= 1
    assert (thumbs_dir / str(row['id']) / '1.jpg').stat().st_size > 0

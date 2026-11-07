"""The yt-dlp handler, driven without yt-dlp.

The subprocess is a stub whose stdout yields scripted lines (progress,
"Destination:", "already been downloaded"), `--dump-json` is a canned
CompletedProcess, Socket.IO is a recorder and the records go through the real
DatabaseManager on the per-test SQLite DB. Coroutines run under asyncio.run;
the real event-loop thread is never started.
"""
import asyncio
import json
import subprocess
import sys
import types
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from backend import ytdlp_handler as yh
from backend.ytdlp_handler import YtdlpDownloader


# --- doubles ----------------------------------------------------------------

class ScriptedStdout:
    """Async line iterator. Items are bytes/str lines or callables run in
    between lines (a clock tick, a cancel); `block=True` hangs forever after
    the last item, which is what a cancel test needs to catch mid-read."""

    def __init__(self, items, block=False):
        self.items = list(items)
        self.block = block

    def __aiter__(self):
        return self

    async def __anext__(self):
        while self.items:
            item = self.items.pop(0)
            if callable(item):
                item()
                continue
            return item.encode() if isinstance(item, str) else item
        if self.block:
            await asyncio.Event().wait()
        raise StopAsyncIteration


class StubProcess:
    def __init__(self, lines=(), returncode=0, block=False, hang_on_wait=False):
        self.stdout = ScriptedStdout(lines, block=block)
        self.pid = 4242
        self.returncode = None
        self._rc = returncode
        self.hang_on_wait = hang_on_wait
        self.terminated = False
        self.killed = False

    async def wait(self):
        if self.hang_on_wait:
            await asyncio.sleep(3600)
        self.returncode = self._rc
        return self._rc

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


class FakeSocket:
    def __init__(self):
        self.events = []

    def emit(self, event, data=None):
        self.events.append((event, data))

    def of(self, event):
        return [d for e, d in self.events if e == event]


class FakeWebApp:
    def __init__(self):
        self.stats_emitted = 0

    def emit_stats(self):
        self.stats_emitted += 1


class Clock:
    """Stand-in for the handler's `datetime`: `now()` is whatever the test
    says, so the 1s progress throttle can be driven deterministically."""

    def __init__(self):
        self.t = datetime(2026, 1, 1, 12, 0, 0)

    def now(self):
        return self.t

    def tick(self, seconds):
        self.t += timedelta(seconds=seconds)


@pytest.fixture
def sock(monkeypatch):
    import backend.web_app.base as base
    s = FakeSocket()
    monkeypatch.setattr(base, 'socketio', s)
    monkeypatch.setattr(base, '_web_app', FakeWebApp())
    return s


class NoRealBrowser:
    """Guard: a failed stub run must never launch Playwright from a test."""

    def __init__(self, *a, **k):
        raise AssertionError('a test reached the real browser fallback')


@pytest.fixture
def dl(db, sock, monkeypatch):
    """A downloader with no cookies; the browser fallback is fenced off."""
    import backend.browser_downloader as bd
    monkeypatch.setattr(bd, 'BrowserDownloader', NoRealBrowser)
    monkeypatch.setattr(YtdlpDownloader, 'COOKIES_FROM_BROWSER', None)
    monkeypatch.setattr(YtdlpDownloader, 'COOKIES_FILE', None)
    return YtdlpDownloader(download_tasks={})


@pytest.fixture
def spawn(monkeypatch):
    """Replace asyncio.create_subprocess_exec; returns a holder whose
    `.process` is what the next call hands back and `.cmds` the argv lists."""
    holder = types.SimpleNamespace(process=StubProcess(), cmds=[], error=None)

    async def fake_exec(*cmd, **kwargs):
        holder.cmds.append(list(cmd))
        if holder.error:
            raise holder.error
        return holder.process

    monkeypatch.setattr(yh.asyncio, 'create_subprocess_exec', fake_exec)
    return holder


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(yh, 'datetime', c)
    return c


def record(db, message_id='m1', url='https://www.youtube.com/watch?v=1', **kw):
    kw.setdefault('file', 'clip.mp4')
    kw.setdefault('status', 'downloading')
    kw.setdefault('downloaded_from', 'youtube')
    return db.add_download(message_id=message_id, url=url, **kw)


def completed(stdout='', stderr='', returncode=0):
    return subprocess.CompletedProcess(args=['yt-dlp'], returncode=returncode,
                                       stdout=stdout, stderr=stderr)


# --- YTDLP_PATH / cookies / domain ------------------------------------------

def test_ytdlp_binary_lives_in_the_venv():
    root = Path(yh.__file__).resolve().parent.parent.parent
    assert Path(YtdlpDownloader.YTDLP_PATH) == root / 'venv' / 'bin' / 'yt-dlp'


@pytest.mark.parametrize('url, domain', [
    ('https://www.youtube.com/watch?v=1', 'youtube'),
    ('https://youtube.com/watch?v=1', 'youtube'),
    ('https://x.com/a/status/1', 'x'),
    ('https://www.bbc.co.uk/iplayer', 'bbc'),
    ('https://media.example.com.br/v', 'example'),
    ('http://localhost:8080/v', 'localhost:8080'),
])
def test_get_domain_strips_www_and_tlds(dl, url, domain):
    assert dl.get_domain(url) == domain


def test_get_domain_never_raises(dl):
    assert dl.get_domain('http://[::1') == 'unknown'


def test_cookie_args_prefer_the_browser(dl, monkeypatch, tmp_path):
    cookies = tmp_path / 'cookies.txt'
    cookies.write_text('# Netscape HTTP Cookie File\n')
    monkeypatch.setattr(YtdlpDownloader, 'COOKIES_FILE', str(cookies))
    assert dl._get_cookie_args() == ['--cookies', str(cookies)]
    monkeypatch.setattr(YtdlpDownloader, 'COOKIES_FROM_BROWSER', 'firefox')
    assert dl._get_cookie_args() == ['--cookies-from-browser', 'firefox']


def test_cookie_args_skip_a_missing_file(dl, monkeypatch, tmp_path):
    monkeypatch.setattr(YtdlpDownloader, 'COOKIES_FILE', str(tmp_path / 'nope.txt'))
    assert dl._get_cookie_args() == []


# --- parse_progress ---------------------------------------------------------

def test_parse_progress_reads_a_fragment_line(dl):
    line = '[download]  45.2% of ~  85.48MiB at  831.64KiB/s ETA 01:01 (frag 101/247)'
    info = dl.parse_progress(line)
    assert info['progress'] == 45.2
    assert info['total_bytes'] == int(85.48 * 1024 ** 2)
    assert info['downloaded_bytes'] == int(info['total_bytes'] * 45.2 / 100)
    assert info['speed'] == pytest.approx(831.64)  # KB/s
    assert info['pending_time'] == 61
    assert 'complete' not in info


@pytest.mark.parametrize('unit, mult', [
    ('KiB', 1024), ('KB', 1000), ('MiB', 1024 ** 2), ('MB', 1000 ** 2),
    ('GiB', 1024 ** 3), ('GB', 1000 ** 3),
])
def test_parse_progress_converts_each_unit(dl, unit, mult):
    info = dl.parse_progress(f'[download]  10.0% of 2.00{unit} at 1.00MiB/s ETA 00:10')
    assert info['total_bytes'] == int(2.0 * mult)


def test_parse_progress_reads_an_eta_with_hours(dl):
    info = dl.parse_progress('[download]   1.0% of 10.00GiB at 1.00MiB/s ETA 01:02:03')
    assert info['pending_time'] == 3723


def test_parse_progress_detects_completion(dl):
    assert dl.parse_progress('[download] 100% of 10.00MiB in 00:05') == {'progress': 100, 'complete': True}
    assert dl.parse_progress('[download] /x/clip.mp4 has already been downloaded') == \
        {'progress': 100, 'complete': True}


def test_parse_progress_ignores_other_output(dl):
    assert dl.parse_progress('[youtube] 1: Downloading webpage') is None
    assert dl.parse_progress('[download] Destination: /x/clip.mp4') is None
    assert dl.parse_progress('[download]  45.2% of 85.48MiB at Unknown speed ETA Unknown') is None


# --- check_url --------------------------------------------------------------

DUMP = {
    'title': 'A Clip', 'duration': 120, 'ext': 'mp4', 'uploader': 'Someone',
    'filesize_approx': 5000,
    'formats': [
        {'format_id': '140', 'ext': 'm4a', 'vcodec': 'none', 'acodec': 'mp4a'},
        {'format_id': '18', 'ext': 'mp4', 'height': 360, 'width': 640,
         'vcodec': 'avc1', 'acodec': 'mp4a', 'filesize': 1000, 'tbr': 500},
        {'format_id': '137', 'ext': 'mp4', 'height': 1080, 'width': 1920,
         'vcodec': 'avc1', 'acodec': 'none', 'filesize_approx': 9000, 'tbr': 4000},
        {'format_id': '137-dup', 'ext': 'mp4', 'height': 1080, 'width': 1920,
         'vcodec': 'avc1', 'acodec': 'none'},
        {'format_id': '248', 'ext': 'webm', 'height': 1080, 'vcodec': 'vp9', 'acodec': 'none'},
    ],
}


def test_check_url_lists_video_formats_best_first(dl, monkeypatch):
    calls = []

    def fake_run(cmd, **kw):
        calls.append((cmd, kw))
        return completed(stdout=json.dumps(DUMP), stderr='WARNING: no js runtime\nother noise')
    monkeypatch.setattr(yh.subprocess, 'run', fake_run)

    res = dl.check_url('https://www.youtube.com/watch?v=1')
    assert res['supported'] is True
    assert res['title'] == 'A Clip' and res['uploader'] == 'Someone'
    assert res['filesize'] == 5000 and res['duration'] == 120
    ids = [f['format_id'] for f in res['formats']]
    # audio-only dropped, (1080, mp4) deduplicated, sorted by height descending
    assert ids == ['137', '248', '18']
    assert res['best_format_id'] == '137'
    assert res['formats'][0]['label'] == '1080p (MP4) - no audio'
    assert res['formats'][-1]['label'] == '360p (MP4)'
    assert res['formats'][0]['filesize'] == 9000
    assert res['warnings'] == ['WARNING: no js runtime']
    cmd, kw = calls[0]
    assert cmd[0] == YtdlpDownloader.YTDLP_PATH
    assert '--dump-json' in cmd and '--no-download' in cmd and cmd[-1] == 'https://www.youtube.com/watch?v=1'
    assert kw['timeout'] == 60


def test_check_url_offers_best_when_nothing_has_video(dl, monkeypatch):
    info = {'title': 'Podcast', 'ext': 'm4a', 'filesize': 42,
            'formats': [{'format_id': '140', 'ext': 'm4a', 'vcodec': 'none', 'acodec': 'mp4a'}]}
    monkeypatch.setattr(yh.subprocess, 'run', lambda *a, **k: completed(stdout=json.dumps(info)))
    res = dl.check_url('https://x/1')
    assert res['formats'] == [{'format_id': 'best', 'ext': 'm4a', 'resolution': 'best', 'height': None,
                               'filesize': 42, 'has_audio': True, 'label': 'Best available'}]
    assert res['best_format_id'] == 'best'
    assert 'warnings' not in res


def test_check_url_passes_cookies(dl, monkeypatch, tmp_path):
    cookies = tmp_path / 'c.txt'
    cookies.write_text('')
    monkeypatch.setattr(YtdlpDownloader, 'COOKIES_FILE', str(cookies))
    seen = {}
    monkeypatch.setattr(yh.subprocess, 'run',
                        lambda cmd, **k: seen.update(cmd=cmd) or completed(stdout=json.dumps(DUMP)))
    dl.check_url('https://x/1')
    assert seen['cmd'][seen['cmd'].index('--cookies') + 1] == str(cookies)


@pytest.mark.parametrize('stderr, error', [
    ('ERROR: Unsupported URL: https://x', 'Unsupported URL'),
    ('ERROR: [youtube] 1: Video unavailable', 'Video unavailable'),
    ('ERROR: Private video. Sign in', 'Private video'),
    ('ERROR: something else entirely', 'ERROR: something else entirely'),
    ('', 'Unknown error'),
])
def test_check_url_maps_known_failures(dl, monkeypatch, stderr, error):
    monkeypatch.setattr(yh.subprocess, 'run', lambda *a, **k: completed(stderr=stderr, returncode=1))
    assert dl.check_url('https://x/1') == {'supported': False, 'error': error}


def test_check_url_with_no_output(dl, monkeypatch):
    monkeypatch.setattr(yh.subprocess, 'run', lambda *a, **k: completed(stdout='  \n'))
    assert dl.check_url('https://x/1')['error'] == 'No output from yt-dlp'
    monkeypatch.setattr(yh.subprocess, 'run', lambda *a, **k: completed(stdout='', stderr='WARNING: x'))
    assert dl.check_url('https://x/1')['error'] == 'WARNING: x'


def test_check_url_reports_unparseable_json(dl, monkeypatch):
    monkeypatch.setattr(yh.subprocess, 'run', lambda *a, **k: completed(stdout='not json', stderr='boom'))
    res = dl.check_url('https://x/1')
    assert res['supported'] is False and res['error'] == 'Failed to parse video info: boom'
    monkeypatch.setattr(yh.subprocess, 'run', lambda *a, **k: completed(stdout='not json'))
    assert dl.check_url('https://x/1')['error'].startswith('Failed to parse video info: ')


@pytest.mark.parametrize('exc, error', [
    (subprocess.TimeoutExpired(cmd='yt-dlp', timeout=60), 'Request timed out'),
    (FileNotFoundError('yt-dlp'), 'yt-dlp is not installed'),
    (RuntimeError('odd'), 'odd'),
])
def test_check_url_maps_exceptions(dl, monkeypatch, exc, error):
    def raise_it(*a, **k):
        raise exc
    monkeypatch.setattr(yh.subprocess, 'run', raise_it)
    assert dl.check_url('https://x/1') == {'supported': False, 'error': error}


# --- emitters ---------------------------------------------------------------

def test_emitters_broadcast_and_refresh_stats(dl, sock):
    import backend.web_app.base as base
    dl.emit_progress('m1', 10.0, 100, 1000, 5.0, 90)
    dl.emit_status('m1', 'failed', 'bad')
    dl.emit_status('m1', 'done')
    dl.emit_new_download({'message_id': 'm1'})
    assert sock.of('download:progress') == [{'message_id': 'm1', 'progress': 10.0, 'downloaded_bytes': 100,
                                             'total_bytes': 1000, 'speed': 5.0, 'pending_time': 90}]
    assert sock.of('download:status') == [{'message_id': 'm1', 'status': 'failed', 'error': 'bad'},
                                          {'message_id': 'm1', 'status': 'done'}]
    assert sock.of('download:new') == [{'message_id': 'm1'}]
    assert base._web_app.stats_emitted == 2


def test_emitters_are_silent_without_socketio(dl, sock, monkeypatch):
    import backend.web_app.base as base
    monkeypatch.setattr(base, 'socketio', None)
    dl.emit_progress('m1', 1, 1, 1, 1, None)
    dl.emit_status('m1', 'done')
    dl.emit_new_download({})
    assert sock.events == []


# --- download(): command line -----------------------------------------------

def run(coro):
    return asyncio.run(coro)


def test_download_command_resumes_and_fails_fast(dl, db, spawn):
    record(db)
    run(dl.download('https://www.youtube.com/watch?v=1', 'm1'))
    cmd = spawn.cmds[0]
    assert cmd[0] == YtdlpDownloader.YTDLP_PATH
    assert cmd[-1] == 'https://www.youtube.com/watch?v=1'
    for flag in ('-c', '--newline', '--no-mtime'):
        assert flag in cmd
    for flag, value in (('--socket-timeout', '30'), ('--retries', '10'),
                        ('--fragment-retries', '10'), ('--retry-sleep', '5')):
        assert cmd[cmd.index(flag) + 1] == value
    assert '-f' not in cmd
    # No custom title: yt-dlp names the file from its own title
    template = cmd[cmd.index('-o') + 1]
    assert template.endswith('%(title)s.%(ext)s')
    assert Path(template).parent == yh.DOWNLOAD_DIR / 'Videos'


def test_download_requests_the_format_with_best_audio(dl, db, spawn):
    record(db)
    run(dl.download('https://x/1', 'm1', format_id='137'))
    cmd = spawn.cmds[0]
    assert cmd[cmd.index('-f') + 1] == '137+bestaudio/best/137'


def test_download_best_format_adds_no_selector(dl, db, spawn):
    record(db)
    run(dl.download('https://x/1', 'm1', format_id='best'))
    assert '-f' not in spawn.cmds[0]


def test_download_uses_the_custom_title_sanitized(dl, db, spawn):
    record(db)
    run(dl.download('https://x/1', 'm1', custom_title='Ep: 1 / "Pilot"?'))
    template = spawn.cmds[0][spawn.cmds[0].index('-o') + 1]
    assert Path(template).name == 'Ep 1  Pilot.%(ext)s'


def test_download_goes_to_the_sources_folder(dl, db, spawn, tmp_path):
    folder = tmp_path / 'tube'
    db.add_download_type_map('youtube', folder=str(folder))
    record(db)
    run(dl.download('https://www.youtube.com/watch?v=1', 'm1'))
    template = spawn.cmds[0][spawn.cmds[0].index('-o') + 1]
    assert Path(template).parent == folder and folder.is_dir()


def test_download_adds_cookie_args(dl, db, spawn, monkeypatch):
    monkeypatch.setattr(YtdlpDownloader, 'COOKIES_FROM_BROWSER', 'chrome')
    record(db)
    run(dl.download('https://x/1', 'm1'))
    cmd = spawn.cmds[0]
    assert cmd[cmd.index('--cookies-from-browser') + 1] == 'chrome'


# --- download(): progress, throttling, completion ---------------------------

def test_download_records_progress_and_finishes_done(dl, db, sock, spawn):
    record(db)
    spawn.process = StubProcess([
        '[youtube] 1: Downloading webpage',
        '',
        '[download] Destination: /tmp/anywhere/My Clip.mp4',
        '[download]  50.0% of 10.00MiB at 1.00MiB/s ETA 00:05',
        '[download] 100% of 10.00MiB in 00:10',
    ])
    run(dl.download('https://x/1', 'm1'))
    row = db.get_download_by_message_id('m1')
    assert row['status'] == 'done' and row['progress'] == 100
    assert row['speed'] == 0 and row['pending_time'] == 0
    assert row['file'] == 'My Clip.mp4'
    assert row['total_bytes'] == 10 * 1024 ** 2
    progress = sock.of('download:progress')
    assert [p['progress'] for p in progress] == [50.0]
    assert progress[0]['pending_time'] == 5
    assert sock.of('download:status') == [{'message_id': 'm1', 'status': 'done'}]
    assert 'm1' not in dl.processes and 'm1' not in dl.download_tasks


def test_progress_is_throttled_to_one_update_per_second(dl, db, sock, spawn, clock):
    record(db)
    line = '[download]  {}% of 10.00MiB at 1.00MiB/s ETA 00:05'
    spawn.process = StubProcess([
        line.format('10.0'),
        lambda: clock.tick(0.4),
        line.format('20.0'),          # inside the same second: dropped
        lambda: clock.tick(0.7),
        line.format('30.0'),          # 1.1s after the last one sent
        lambda: clock.tick(2),
        '[download] 100% of 10.00MiB in 00:10',  # complete: never emitted as progress
    ])
    run(dl.download('https://x/1', 'm1'))
    assert [p['progress'] for p in sock.of('download:progress')] == [10.0, 30.0]
    assert db.get_download_by_message_id('m1')['status'] == 'done'


def test_a_throttled_line_still_updates_total_bytes(dl, db, spawn, clock):
    """The first line is always sent; its total is what the metrics see."""
    record(db)
    spawn.process = StubProcess(['[download]   1.0% of 1.00MiB at 1.00MiB/s ETA 00:05',
                                 '[download]   2.0% of 1.00MiB at 1.00MiB/s ETA 00:05'])
    run(dl.download('https://x/1', 'm1'))
    assert db.get_download_by_message_id('m1')['downloaded_bytes'] == int(1024 ** 2 * 0.01)


def test_already_downloaded_finishes_early(dl, db, sock, spawn):
    record(db)
    proc = StubProcess(['[download] /x/clip.mp4 has already been downloaded',
                        '[download]  50.0% of 10.00MiB at 1.00MiB/s ETA 00:05'], returncode=1)
    spawn.process = proc
    run(dl.download('https://x/1', 'm1'))
    row = db.get_download_by_message_id('m1')
    assert row['status'] == 'done' and row['progress'] == 100
    assert sock.of('download:progress') == []     # returned before the next line
    assert proc.returncode is None                 # process.wait() never ran
    assert 'm1' not in dl.processes


# --- download(): failure, fallback, cancel ----------------------------------

def test_a_failed_run_falls_back_to_the_browser_and_can_succeed(dl, db, sock, spawn, monkeypatch):
    record(db)
    spawn.process = StubProcess(['ERROR: HTTP Error 403: Forbidden'], returncode=1)
    seen = {}

    async def fake_fallback(url, output_dir, message_id, _db):
        seen.update(url=url, output_dir=output_dir, message_id=message_id)
        return {'success': True, 'file_path': str(output_dir / 'from browser.mp4')}
    monkeypatch.setattr(dl, '_try_browser_fallback', fake_fallback)

    run(dl.download('https://x/1', 'm1'))
    assert seen == {'url': 'https://x/1', 'output_dir': yh.DOWNLOAD_DIR / 'Videos', 'message_id': 'm1'}
    row = db.get_download_by_message_id('m1')
    assert row['status'] == 'done' and row['file'] == 'from browser.mp4'
    assert sock.of('download:status')[-1]['status'] == 'done'


def test_both_methods_failing_marks_failed_with_the_reason(dl, db, sock, spawn, monkeypatch):
    record(db)
    spawn.process = StubProcess(['ERROR: HTTP Error 403: Forbidden'], returncode=1)

    async def fake_fallback(*a):
        return {'error': 'Browser fallback not available (Playwright not installed)'}
    monkeypatch.setattr(dl, '_try_browser_fallback', fake_fallback)

    run(dl.download('https://x/1', 'm1'))
    row = db.get_download_by_message_id('m1')
    assert row['status'] == 'failed' and row['speed'] == 0
    assert row['error'] == 'Browser fallback not available (Playwright not installed)'
    assert sock.of('download:status')[-1] == {
        'message_id': 'm1', 'status': 'failed',
        'error': 'Browser fallback not available (Playwright not installed)'}


def test_a_fallback_without_a_reason_gets_a_default_one(dl, db, spawn, monkeypatch):
    record(db)
    spawn.process = StubProcess([], returncode=2)

    async def fake_fallback(*a):
        return {}
    monkeypatch.setattr(dl, '_try_browser_fallback', fake_fallback)
    run(dl.download('https://x/1', 'm1'))
    assert db.get_download_by_message_id('m1')['error'] == 'Download failed (yt-dlp and browser fallback)'


def test_a_missing_binary_fails_the_download(dl, db, sock, spawn):
    record(db)
    spawn.error = FileNotFoundError(2, 'No such file', YtdlpDownloader.YTDLP_PATH)
    run(dl.download('https://x/1', 'm1'))
    row = db.get_download_by_message_id('m1')
    assert row['status'] == 'failed'
    assert 'No such file' in row['error']
    assert sock.of('download:status')[-1]['status'] == 'failed'
    assert 'm1' not in dl.download_tasks


def test_cancel_terminates_the_process_and_marks_stopped(dl, db, sock, spawn):
    record(db)
    proc = StubProcess(['[download]  50.0% of 10.00MiB at 1.00MiB/s ETA 00:05'], block=True)
    spawn.process = proc

    async def scenario():
        task = asyncio.ensure_future(dl.download('https://x/1', 'm1'))
        dl.download_tasks['m1'] = task
        while 'm1' not in dl.processes:
            await asyncio.sleep(0)
        await asyncio.sleep(0.01)
        task.cancel()
        await task  # the handler swallows the cancel on its way out
        return task
    task = run(scenario())
    assert task.done() and not task.cancelled()
    assert proc.terminated and not proc.killed
    row = db.get_download_by_message_id('m1')
    assert row['status'] == 'stopped' and row['speed'] == 0
    assert sock.of('download:status')[-1] == {'message_id': 'm1', 'status': 'stopped'}
    assert 'm1' not in dl.processes and 'm1' not in dl.download_tasks


def test_cancel_kills_a_process_that_ignores_terminate(dl, db, spawn, monkeypatch):
    record(db)
    proc = StubProcess([], block=True, hang_on_wait=True)
    spawn.process = proc
    real_wait_for = asyncio.wait_for
    monkeypatch.setattr(yh.asyncio, 'wait_for', lambda aw, timeout: real_wait_for(aw, timeout=0.02))

    async def scenario():
        task = asyncio.ensure_future(dl.download('https://x/1', 'm1'))
        while 'm1' not in dl.processes:
            await asyncio.sleep(0)
        await asyncio.sleep(0.01)
        task.cancel()
        await task
    run(scenario())
    assert proc.terminated and proc.killed
    assert db.get_download_by_message_id('m1')['status'] == 'stopped'


# --- _try_browser_fallback --------------------------------------------------

def test_browser_fallback_drives_the_browser_downloader(dl, db, sock, monkeypatch, tmp_path):
    record(db)
    import backend.browser_downloader as bd
    made = {}

    class FakeBrowserDownloader:
        def __init__(self, output_dir, progress_callback):
            made['dir'] = output_dir
            self.cb = progress_callback
            self.closed = False
            made['obj'] = self

        async def download(self, url):
            self.cb(25.0, 250, 1000)
            return {'success': True, 'file_path': str(made['dir'] / 'x.mp4')}

        async def close(self):
            self.closed = True
    monkeypatch.setattr(bd, 'BrowserDownloader', FakeBrowserDownloader)

    res = run(dl._try_browser_fallback('https://x/1', tmp_path, 'm1', db))
    assert res['success'] is True
    assert made['dir'] == tmp_path and made['obj'].closed
    row = db.get_download_by_message_id('m1')
    assert (row['progress'], row['downloaded_bytes'], row['total_bytes']) == (25.0, 250, 1000)
    assert sock.of('download:progress')[0]['progress'] == 25.0


def test_browser_fallback_closes_the_browser_on_error(dl, db, monkeypatch, tmp_path):
    import backend.browser_downloader as bd
    closed = []

    class Exploding:
        def __init__(self, *a):
            pass

        async def download(self, url):
            raise RuntimeError('chromium missing')

        async def close(self):
            closed.append(True)
    monkeypatch.setattr(bd, 'BrowserDownloader', Exploding)
    res = run(dl._try_browser_fallback('https://x/1', tmp_path, 'm1', db))
    assert res == {'error': 'Browser fallback failed: chromium missing'}
    assert closed == [True]


def test_browser_fallback_without_playwright(dl, db, monkeypatch, tmp_path):
    # None in sys.modules makes the import raise ImportError, which is what a
    # box without Playwright produces.
    monkeypatch.setitem(sys.modules, 'backend.browser_downloader', None)
    res = run(dl._try_browser_fallback('https://x/1', tmp_path, 'm1', db))
    assert res == {'error': 'Browser fallback not available (Playwright not installed)'}


# --- start_download ---------------------------------------------------------

@pytest.fixture
def scheduled(monkeypatch):
    """Capture what the handler schedules on the loop instead of running it.
    The coroutine's bound arguments are read off its frame, then it's closed
    so nothing is left un-awaited."""
    captured = []

    class FakeFuture:
        def __init__(self):
            self.callbacks = []
            self._done = False

        def add_done_callback(self, cb):
            self.callbacks.append(cb)

        def done(self):
            return self._done

        def cancel(self):
            self._done = True

        def result(self):
            return None

    def fake_schedule(coro, loop):
        captured.append({'name': coro.__name__, 'args': dict(coro.cr_frame.f_locals), 'loop': loop})
        coro.close()
        return FakeFuture()
    monkeypatch.setattr(yh.asyncio, 'run_coroutine_threadsafe', fake_schedule)
    return captured


LOOP = object()


def test_start_download_creates_the_record_and_schedules_it(dl, db, sock, scheduled):
    res = dl.start_download('https://www.youtube.com/watch?v=1', LOOP, format_id='137',
                            title='A Clip', ext='mkv', filesize=777, author='Someone')
    assert res.get('error') is None
    row = db.get_download_by_message_id(res['message_id'])
    assert row['status'] == 'downloading'
    assert row['file'] == 'A Clip.mkv'
    assert row['downloaded_from'] == 'youtube' and row['url'] == 'https://www.youtube.com/watch?v=1'
    assert row['format_id'] == '137' and row['total_bytes'] == 777 and row['author'] == 'Someone'
    assert row['queue_position'] is not None
    assert sock.of('download:new')[0]['message_id'] == res['message_id']

    names = [c['name'] for c in scheduled]
    assert names == ['download', 'poll_and_extract_meta']
    args = scheduled[0]['args']
    assert (args['url'], args['message_id'], args['format_id'], args['custom_title']) == \
        ('https://www.youtube.com/watch?v=1', res['message_id'], '137', 'A Clip')
    assert scheduled[0]['loop'] is LOOP
    assert res['message_id'] in dl.download_tasks
    assert scheduled[0]['args']['custom_title'] == 'A Clip'


def test_start_download_applies_rename_rules_before_the_template(dl, db, scheduled):
    from backend.rename import invalidate_rules_cache
    db.add_rename_rule(pattern=r'[._]', replacement=' ', name='dots')
    invalidate_rules_cache()
    res = dl.start_download('https://x/1', LOOP, title='My.Show.S01E01', ext='mp4')
    assert res['file'] == 'My Show S01E01.mp4'
    # The stem of the *renamed* file is what yt-dlp is told to use as the title
    assert scheduled[0]['args']['custom_title'] == 'My Show S01E01'


def test_start_download_sanitizes_an_unsafe_title(dl, db, scheduled):
    res = dl.start_download('https://x/1', LOOP, title='../../etc/passwd', ext='mp4')
    assert '/' not in res['file'] and '..' not in res['file']


def test_start_download_checks_the_url_when_no_title_is_given(dl, db, scheduled, monkeypatch):
    monkeypatch.setattr(dl, 'check_url', lambda url: {
        'supported': True, 'title': 'Checked', 'ext': 'webm', 'filesize': 123})
    res = dl.start_download('https://x/1', LOOP)
    assert res['file'] == 'Checked.webm' and res['total_bytes'] == 123


def test_start_download_refuses_an_unsupported_url(dl, db, sock, scheduled, monkeypatch):
    monkeypatch.setattr(dl, 'check_url', lambda url: {'supported': False, 'error': 'Unsupported URL'})
    assert dl.start_download('https://x/1', LOOP) == {'error': 'Unsupported URL'}
    assert db.get_all_downloads() == [] and scheduled == [] and sock.events == []


def test_start_download_skips_metadata_polling_for_non_video(dl, db, scheduled):
    dl.start_download('https://x/1', LOOP, title='Song', ext='mp3')
    assert [c['name'] for c in scheduled] == ['download']


def test_start_download_waits_in_the_queue_when_full(dl, db, sock, scheduled, monkeypatch):
    from backend import download_queue as dq
    monkeypatch.setattr(dq, '_notify', lambda: None)
    dq.set_limits({'global': 1})
    record(db, message_id='busy')  # one slot, taken
    res = dl.start_download('https://x/1', LOOP, title='Later', ext='mp4')
    assert res['status'] == 'waiting' and res['queue_position'] is not None
    assert scheduled == [] and res['message_id'] not in dl.download_tasks
    assert sock.of('download:new')[0]['status'] == 'waiting'


def test_task_errors_are_reported_by_the_done_callback(dl, db, scheduled, capsys):
    dl.start_download('https://x/1', LOOP, title='T', ext='mp4')
    future = next(iter(dl.download_tasks.values()))

    class Failed:
        def result(self):
            raise RuntimeError('loop blew up')
    future.callbacks[0](Failed())
    assert 'loop blew up' in capsys.readouterr().out


# --- resume_download --------------------------------------------------------

def test_resume_needs_a_url_a_message_id_and_a_loop(dl, db, scheduled):
    assert dl.resume_download({'message_id': 'm1'}, LOOP) is False
    assert dl.resume_download({'url': 'https://x/1'}, LOOP) is False
    assert dl.resume_download({'url': 'https://x/1', 'message_id': 'm1'}, None) is False
    assert scheduled == []


def test_resume_restarts_from_the_record(dl, db, sock, scheduled):
    row = record(db, status='failed', error='boom', file='Renamed Clip.mkv', format_id='22')
    assert dl.resume_download(row, LOOP) is True
    fresh = db.get_download_by_message_id('m1')
    assert fresh['status'] == 'downloading' and fresh['error'] is None and fresh['speed'] == 0
    assert sock.of('download:status') == [{'message_id': 'm1', 'status': 'downloading'}]
    args = scheduled[0]['args']
    # -c is on every command line; the stored name (already renamed) is fed
    # back as the title so the .part is found again, and the format is kept
    assert (args['format_id'], args['custom_title']) == ('22', 'Renamed Clip')
    assert 'm1' in dl.download_tasks


def test_resume_handles_a_file_without_extension(dl, db, scheduled):
    assert dl.resume_download({'url': 'https://x/1', 'message_id': 'm1', 'file': 'bare'}, LOOP)
    assert scheduled[0]['args']['custom_title'] == 'bare'
    assert dl.resume_download({'url': 'https://x/1', 'message_id': 'm2', 'file': ''}, LOOP)
    assert scheduled[1]['args']['custom_title'] is None


class RunningTask:
    """A run_coroutine_threadsafe future for a download still in flight.
    `deregisters` mimics the coroutine's finally: popping itself on cancel."""

    def __init__(self, tasks, message_id, deregisters=True):
        self.tasks, self.message_id, self.deregisters = tasks, message_id, deregisters
        self.cancelled = False

    def done(self):
        return self.cancelled

    def cancel(self):
        self.cancelled = True
        if self.deregisters:
            self.tasks.pop(self.message_id, None)


def test_resume_declines_a_download_already_running(dl, db, scheduled):
    task = RunningTask(dl.download_tasks, 'm1')
    dl.download_tasks['m1'] = task
    assert dl.resume_download({'url': 'https://x/1', 'message_id': 'm1'}, LOOP) is True
    assert scheduled == [] and not task.cancelled
    assert dl.download_tasks['m1'] is task


def test_forced_resume_stops_the_old_task_and_waits_for_it(dl, db, scheduled, monkeypatch):
    record(db)
    task = RunningTask(dl.download_tasks, 'm1')
    dl.download_tasks['m1'] = task
    proc = StubProcess()
    dl.processes['m1'] = proc
    monkeypatch.setattr(yh.time, 'sleep', lambda s: None)
    assert dl.resume_download({'url': 'https://x/1', 'message_id': 'm1', 'file': 'a.mp4'}, LOOP, force=True)
    assert task.cancelled and proc.terminated
    assert len(scheduled) == 1
    assert dl.download_tasks['m1'] is not task


def test_forced_resume_gives_up_on_a_task_that_will_not_stop(dl, db, scheduled, monkeypatch):
    task = RunningTask(dl.download_tasks, 'm1', deregisters=False)
    dl.download_tasks['m1'] = task
    ticks = iter(range(0, 10_000, 5))
    fake_time = types.SimpleNamespace(time=lambda: float(next(ticks)), sleep=lambda s: None)
    monkeypatch.setattr(yh, 'time', fake_time)
    assert dl.resume_download({'url': 'https://x/1', 'message_id': 'm1'}, LOOP, force=True) is False
    assert scheduled == [] and task.cancelled


# --- stop_download ----------------------------------------------------------

def test_stop_terminates_the_process_and_cancels_the_task(dl):
    proc = StubProcess()
    task = RunningTask(dl.download_tasks, 'm1', deregisters=False)
    dl.processes['m1'] = proc
    dl.download_tasks['m1'] = task
    dl.stop_download('m1')
    assert proc.terminated and task.cancelled


def test_stop_ignores_an_unknown_download(dl):
    dl.stop_download('nope')  # nothing to do, nothing raised


# --- end to end on a real (private) loop ------------------------------------

def test_start_download_runs_to_done_on_a_loop_thread(dl, db, sock, spawn, monkeypatch):
    """The whole path: admit -> schedule on the loop -> stub yt-dlp -> done."""
    import threading

    async def no_meta(message_id):
        return None
    monkeypatch.setattr(yh, 'poll_and_extract_meta', no_meta)
    spawn.process = StubProcess(['[download] Destination: /x/Live Clip.mp4',
                                 '[download] 100% of 1.00MiB in 00:01'])
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        res = dl.start_download('https://x/1', loop, title='Live Clip', ext='mp4')
        future = dl.download_tasks[res['message_id']]
        future.result(timeout=10)
        row = db.get_download_by_message_id(res['message_id'])
        assert row['status'] == 'done' and row['file'] == 'Live Clip.mp4'
        assert res['message_id'] not in dl.download_tasks
        assert spawn.cmds[0][spawn.cmds[0].index('-o') + 1].endswith('Live Clip.%(ext)s')
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()


# --- version / upgrade routes -----------------------------------------------

def test_ytdlp_version_route_runs_the_venv_binary(app, client, auth, monkeypatch):
    app.ytdlp_downloader = YtdlpDownloader({})
    seen = {}
    monkeypatch.setattr(subprocess, 'run',
                        lambda cmd, **k: seen.update(cmd=cmd) or completed(stdout='2026.01.01\n'))
    res = client.get('/api/jobs/ytdlp-version', headers=auth)
    assert res.get_json() == {'version': '2026.01.01'}
    assert seen['cmd'] == [YtdlpDownloader.YTDLP_PATH, '--version']


def test_ytdlp_version_route_reports_a_broken_binary(app, client, auth, monkeypatch):
    app.ytdlp_downloader = YtdlpDownloader({})

    def missing(*a, **k):
        raise FileNotFoundError('yt-dlp')
    monkeypatch.setattr(subprocess, 'run', missing)
    body = client.get('/api/jobs/ytdlp-version', headers=auth).get_json()
    assert body['version'] is None and 'yt-dlp' in body['error']


def test_ytdlp_upgrade_job_pip_installs_into_the_venv(client, auth, monkeypatch):
    from backend import jobs
    calls = []
    versions = iter(['2025.12.01', '2026.01.01'])

    def fake_run(cmd, **k):
        calls.append(cmd)
        if cmd[1:] == ['--version']:
            return completed(stdout=next(versions) + '\n')
        return completed()
    monkeypatch.setattr(jobs.subprocess, 'run', fake_run)
    body = client.post('/api/jobs/ytdlp-upgrade', headers=auth).get_json()
    assert body['old_version'] == '2025.12.01' and body['new_version'] == '2026.01.01'
    assert body['upgraded'] is True
    assert calls[0][0] == YtdlpDownloader.YTDLP_PATH
    assert calls[1][-3:] == ['install', '--upgrade', 'yt-dlp'] and calls[1][0].endswith('venv/bin/pip')


def test_ytdlp_upgrade_job_surfaces_a_pip_failure(client, auth, monkeypatch):
    from backend import jobs

    def fake_run(cmd, **k):
        if cmd[1:] == ['--version']:
            return completed(stdout='2025.12.01')
        return completed(stderr='No matching distribution', returncode=1)
    monkeypatch.setattr(jobs.subprocess, 'run', fake_run)
    res = client.post('/api/jobs/ytdlp-upgrade', headers=auth)
    assert res.status_code == 500
    assert 'No matching distribution' in res.get_json()['error']

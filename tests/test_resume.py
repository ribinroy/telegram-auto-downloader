"""backend/resume.py: the one resume path shared by the retry button, the
download queue and the network watchdog. Every handler is a small stub -
resuming must dispatch to the right one with the right `force`, and never
raise, because its callers are a route and a daemon thread."""
import asyncio
import threading
from types import SimpleNamespace

import pytest

from backend import resume
from backend.web_app import base as web_base


# --- handler stubs --------------------------------------------------------

class FakeVps:
    def __init__(self, resume_ok=True, stop_ok=True):
        self.calls = []
        self.resume_ok = resume_ok
        self.stop_ok = stop_ok

    def stop_download(self, message_id):
        self.calls.append(('stop', message_id))
        return self.stop_ok

    def resume_download(self, message_id):
        self.calls.append(('resume', message_id))
        return self.resume_ok


class FakeYtdlp:
    def __init__(self, resume_ok=True):
        self.calls = []
        self.resume_ok = resume_ok

    def resume_download(self, download, loop, force=False):
        self.calls.append((download['message_id'], loop, force))
        return self.resume_ok


class FakeTelegram:
    """Telethon's resume is a coroutine on the client's own loop; the stub
    runs a real loop on a thread so run_coroutine_threadsafe() is exercised
    for real, with nothing behind it that could reach the network."""

    def __init__(self, loop, resume_ok=True, delay=0.0):
        self.loop = loop
        self.calls = []
        self.resume_ok = resume_ok
        self.delay = delay

    async def resume_download(self, message_id, force=False):
        self.calls.append((message_id, force))
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.resume_ok


@pytest.fixture
def tg_loop():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True, name='test-tg-loop')
    thread.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


@pytest.fixture
def web(monkeypatch):
    """A stand-in for the WebApp with nothing wired; tests attach handlers."""
    stub = SimpleNamespace(vps_downloader=None, telegram_downloader=None,
                           ytdlp_downloader=None, event_loop=None)
    monkeypatch.setattr(web_base, '_web_app', stub)
    return stub


@pytest.fixture
def retries(monkeypatch):
    recorded = []
    monkeypatch.setattr(resume.metrics, 'record_retry', recorded.append)
    return recorded


def rec(message_id='m1', source='telegram', url=None, **over):
    row = {'message_id': message_id, 'downloaded_from': source, 'url': url,
           'status': 'failed', 'file': 'f.bin'}
    row.update(over)
    return row


# --- source_of -------------------------------------------------------------

@pytest.mark.parametrize('download, expected', [
    ({'downloaded_from': 'vps'}, 'vps'),
    ({'downloaded_from': 'VPS', 'url': 'https://x'}, 'vps'),
    ({'downloaded_from': 'telegram'}, 'telegram'),
    ({'downloaded_from': 'Telegram', 'url': 'https://x'}, 'telegram'),
    ({'downloaded_from': 'youtube.com', 'url': 'https://youtu.be/x'}, 'ytdlp'),
    ({'downloaded_from': 'youtube.com'}, 'telegram'),       # no url: not yt-dlp's
    ({'downloaded_from': None, 'url': 'https://x'}, 'ytdlp'),
    ({}, 'telegram'),
])
def test_source_of_picks_the_owning_handler(download, expected):
    assert resume.source_of(download) == expected


# --- guards ----------------------------------------------------------------

def test_no_web_app_means_nothing_can_be_resumed(monkeypatch, retries):
    monkeypatch.setattr(web_base, '_web_app', None)
    assert resume.resume_download(rec()) is False
    assert retries == []


def test_a_record_without_a_message_id_is_declined(web, retries):
    web.vps_downloader = FakeVps()
    assert resume.resume_download(rec(message_id=None, source='vps')) is False
    assert web.vps_downloader.calls == []


# --- vps -------------------------------------------------------------------

def test_vps_resume_without_force_leaves_the_running_transfer_alone(web, retries):
    web.vps_downloader = FakeVps()
    assert resume.resume_download(rec(source='vps')) is True
    assert web.vps_downloader.calls == [('resume', 'm1')]
    assert retries == ['vps']


def test_vps_force_stops_the_transfer_before_restarting_it(web, retries):
    web.vps_downloader = FakeVps()
    assert resume.resume_download(rec(source='vps'), force=True) is True
    assert web.vps_downloader.calls == [('stop', 'm1'), ('resume', 'm1')]


def test_vps_that_refuses_to_stop_is_not_restarted_on_top_of_itself(web, retries):
    """Two threads writing one partial file is worse than a wedged one."""
    web.vps_downloader = FakeVps(stop_ok=False)
    assert resume.resume_download(rec(source='vps'), force=True) is False
    assert web.vps_downloader.calls == [('stop', 'm1')]
    assert retries == []


def test_vps_handler_not_wired_declines(web, retries):
    assert resume.resume_download(rec(source='vps')) is False


def test_vps_already_running_declines_without_counting_a_retry(web, retries):
    web.vps_downloader = FakeVps(resume_ok=False)
    assert resume.resume_download(rec(source='vps')) is False
    assert retries == []


# --- telegram --------------------------------------------------------------

def test_telegram_resume_runs_on_the_clients_loop_with_force(web, tg_loop, retries):
    web.telegram_downloader = FakeTelegram(tg_loop)
    assert resume.resume_download(rec(message_id='12345'), force=True) is True
    assert web.telegram_downloader.calls == [(12345, True)]
    assert retries == ['telegram']


def test_telegram_resume_passes_force_false_by_default(web, tg_loop, retries):
    web.telegram_downloader = FakeTelegram(tg_loop)
    assert resume.resume_download(rec(message_id=777)) is True
    assert web.telegram_downloader.calls == [(777, False)]


def test_telegram_declines_a_message_id_that_is_not_a_telegram_id(web, tg_loop, retries):
    web.telegram_downloader = FakeTelegram(tg_loop)
    assert resume.resume_download(rec(message_id='not-an-int')) is False
    assert web.telegram_downloader.calls == []


def test_telegram_handler_not_wired_or_not_connected_declines(web, retries):
    assert resume.resume_download(rec(message_id='1')) is False
    web.telegram_downloader = FakeTelegram(loop=None)       # client not started yet
    assert resume.resume_download(rec(message_id='1')) is False
    assert web.telegram_downloader.calls == []


def test_telegram_already_running_declines(web, tg_loop, retries):
    web.telegram_downloader = FakeTelegram(tg_loop, resume_ok=False)
    assert resume.resume_download(rec(message_id='1')) is False
    assert retries == []


def test_a_telegram_resume_that_never_answers_is_a_failure_not_a_hang(web, tg_loop, retries, monkeypatch):
    monkeypatch.setattr(resume, 'RESUME_TIMEOUT', 0.05)
    web.telegram_downloader = FakeTelegram(tg_loop, delay=2.0)
    assert resume.resume_download(rec(message_id='1')) is False
    assert retries == []


# --- yt-dlp ----------------------------------------------------------------

def test_ytdlp_resume_gets_the_record_the_loop_and_force(web, retries):
    web.ytdlp_downloader = FakeYtdlp()
    web.event_loop = object()
    row = rec(source='youtube.com', url='https://youtu.be/x')
    assert resume.resume_download(row, force=True) is True
    assert web.ytdlp_downloader.calls == [('m1', web.event_loop, True)]
    assert retries == ['youtube.com']           # the domain, not 'ytdlp'


def test_ytdlp_needs_both_the_handler_and_its_loop(web, retries):
    row = rec(source='youtube.com', url='https://youtu.be/x')
    assert resume.resume_download(row) is False
    web.ytdlp_downloader = FakeYtdlp()
    assert resume.resume_download(row) is False          # loop still missing
    assert web.ytdlp_downloader.calls == []


def test_ytdlp_already_running_declines(web, retries):
    web.ytdlp_downloader = FakeYtdlp(resume_ok=False)
    web.event_loop = object()
    assert resume.resume_download(rec(source='x.com', url='https://x')) is False
    assert retries == []


# --- the contract with callers ---------------------------------------------

def test_a_handler_that_raises_never_takes_the_caller_down(web, retries):
    class Broken:
        def resume_download(self, message_id):
            raise RuntimeError('ssh exploded')
    web.vps_downloader = Broken()
    assert resume.resume_download(rec(source='vps')) is False
    assert retries == []


def test_a_queue_start_is_not_counted_as_a_retry(web, retries):
    web.vps_downloader = FakeVps()
    assert resume.resume_download(rec(source='vps'), count_retry=False) is True
    assert retries == []


def test_resume_by_id_looks_the_record_up(db, web, retries):
    web.vps_downloader = FakeVps()
    row = db.add_download(file='a', status='stopped', message_id='by-id',
                          downloaded_from='vps', url='/r/a')
    assert resume.resume_by_id(row['id'], force=True) is True
    assert web.vps_downloader.calls == [('stop', 'by-id'), ('resume', 'by-id')]
    assert resume.resume_by_id(row['id'] + 1000) is False

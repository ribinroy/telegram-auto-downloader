"""Telegram handler, second half: magnet links handed to the VPS torrent
client, the live progress trackers, the "download" reply that pulls a finished
torrent VPS->DownLee, and the chat query commands.

The torrent dispatchers (`torrent_add_magnet`, `torrent_get`, ...) and the SFTP
opener are replaced at the package boundary the handler imports them from;
the trackers run with `interval=0` so their polling loops finish at once.
Fakes and fixtures come from test_telegram_handler.py.
"""
import asyncio
import json
from types import SimpleNamespace

import pytest
from telethon.tl.types import User as TgUser

import backend.web_app as web_pkg
from backend import telegram_handler as th
from backend.web_app.torrent import write_torrent_settings
from test_telegram_handler import (  # noqa: F401 - fixtures
    CHAT, FakeEvent, FakeMessage, clock, run, settle, sio, tg, tg_env, web,
)


def transmission_default(local_dir=None):
    """A configured Transmission that is the Telegram default."""
    sub = {'url': 'http://vps:9091/transmission/rpc'}
    if local_dir:
        sub['local_dir'] = local_dir
    write_torrent_settings({'transmission': sub, 'qbittorrent': {}, 'telegram_default': 'transmission'})


@pytest.fixture
def torrent(monkeypatch):
    """Fake dispatchers; `calls` records every client call in order."""
    calls = []
    state = SimpleNamespace(calls=calls, add_result=None, add_error=None, dirs_error=None)

    def telegram_dirs(client):
        calls.append(('dirs', client))
        if state.dirs_error:
            raise state.dirs_error
        return ('/home6/u/telegram/downloads', '/home6/u/telegram/progress')

    def add_magnet(client, magnet, download_dir=None, incomplete_dir=None):
        calls.append(('add', client, magnet, download_dir, incomplete_dir))
        if state.add_error:
            raise state.add_error
        return state.add_result or {'name': 'Ubuntu.iso', 'hash': 'abc123', 'duplicate': False}

    def set_location(client, hashes, location):
        calls.append(('move', client, hashes, location))
    monkeypatch.setattr(web_pkg, 'torrent_telegram_dirs', telegram_dirs)
    monkeypatch.setattr(web_pkg, 'torrent_add_magnet', add_magnet)
    monkeypatch.setattr(web_pkg, 'torrent_set_location', set_location)
    return state


@pytest.fixture
def tracked(tg, monkeypatch):
    """Replace the two long-running trackers with recorders."""
    seen = {'torrent': [], 'downlee': []}

    async def noop():
        pass

    def track_torrent(reply, torrent_hash, name, client):
        seen['torrent'].append((reply, torrent_hash, name, client))
        return noop()

    def track_downlee(msg, message_id, name):
        seen['downlee'].append((msg, message_id, name))
        return noop()
    monkeypatch.setattr(tg, '_track_torrent_progress', track_torrent)
    monkeypatch.setattr(tg, '_track_downlee_progress', track_downlee)
    return seen


MAGNET = 'magnet:?xt=urn:btih:ABC123&dn=Ubuntu'


# ---------------------------------------------------------------------------
# Magnets in a channel
# ---------------------------------------------------------------------------

def test_a_magnet_goes_to_the_channels_client_into_the_telegram_dirs(tg, db, torrent, tracked):
    transmission_default()
    ev = FakeEvent(tg.client, text=f'grab this {MAGNET} please')

    async def go():
        await tg._handle_new_file(ev)
        await settle()
    run(go())
    assert torrent.calls == [
        ('dirs', 'transmission'),
        ('add', 'transmission', MAGNET, '/home6/u/telegram/downloads', '/home6/u/telegram/progress'),
    ]
    assert [m.text for m in ev.replies] == ['`Ubuntu.iso` download progress: 0%']
    assert tracked['torrent'] == [(ev.replies[0], 'abc123', 'Ubuntu.iso', 'transmission')]
    assert db.get_all_downloads() == []                 # the torrent lives on the VPS, no local record


def test_the_channel_setting_overrides_the_default_client(tg, torrent, tracked):
    transmission_default()
    tg.set_channel_torrent_client(CHAT, 'qbittorrent')
    ev = FakeEvent(tg.client, text=MAGNET)
    run(tg._handle_new_file(ev))
    assert torrent.calls[0] == ('dirs', 'qbittorrent')


def test_without_a_client_the_bot_says_so(tg, torrent, tracked):
    ev = FakeEvent(tg.client, text=MAGNET)
    run(tg._handle_new_file(ev))
    assert torrent.calls == []
    assert ev.replies[0].text.startswith('❌ No torrent client set')
    # Even the reply failing is fine
    ev = FakeEvent(tg.client, text=MAGNET)
    ev.reply_error = RuntimeError('flood')
    run(tg._handle_new_file(ev))


def test_an_unready_client_is_reported_once_per_message(tg, torrent, tracked):
    transmission_default()
    torrent.dirs_error = ValueError('Transmission is not configured')
    ev = FakeEvent(tg.client, text=f'{MAGNET} and {MAGNET}2')
    run(tg._handle_new_file(ev))
    assert [m.text for m in ev.replies] == ['❌ Torrent client not ready: Transmission is not configured']
    assert [c[0] for c in torrent.calls] == ['dirs']
    ev = FakeEvent(tg.client, text=MAGNET)
    ev.reply_error = RuntimeError('flood')
    run(tg._handle_new_file(ev))                              # the failed reply is swallowed too


def test_every_magnet_in_a_message_is_added_and_failures_do_not_stop_the_rest(tg, torrent, tracked, monkeypatch):
    transmission_default()
    results = iter([RuntimeError('tracker refused'), {'name': 'Second', 'hash': 'h2', 'duplicate': True},
                    {'name': None, 'hash': None}])

    def add_magnet(client, magnet, download_dir=None, incomplete_dir=None):
        r = next(results)
        if isinstance(r, Exception):
            raise r
        return r
    monkeypatch.setattr(web_pkg, 'torrent_add_magnet', add_magnet)
    ev = FakeEvent(tg.client, text=f'{MAGNET}1\n{MAGNET}2\nMAGNET:?xt=urn:btih:UPPER')
    run(tg._handle_new_file(ev))
    assert [m.text for m in ev.replies] == [
        '❌ Could not add magnet: tracker refused',
        '🧲 Already in torrent client: Second',
        '`torrent` download progress: 0%',
    ]
    # Only the duplicate had a hash to track; the nameless add had none
    assert [t[1] for t in tracked['torrent']] == ['h2']
    # A failing add whose error reply also fails is logged, nothing more
    def failing_add(client, magnet, download_dir=None, incomplete_dir=None):
        raise RuntimeError('down')
    monkeypatch.setattr(web_pkg, 'torrent_add_magnet', failing_add)
    ev = FakeEvent(tg.client, text=MAGNET)
    ev.reply_error = RuntimeError('flood')
    run(tg._handle_new_file(ev))
    assert ev.replies == []


# ---------------------------------------------------------------------------
# Torrent progress tracker
# ---------------------------------------------------------------------------

def track(tg, reply, polls, monkeypatch, **kw):
    """Run _track_torrent_progress over a scripted sequence of torrent_get answers."""
    answers = list(polls)

    def torrent_get(client, torrent_hash):
        assert (client, torrent_hash) == ('transmission', 'abc123')
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a
    monkeypatch.setattr(web_pkg, 'torrent_get', torrent_get)
    kw.setdefault('max_polls', len(answers))
    run(tg._track_torrent_progress(reply, 'abc123', 'placeholder', 'transmission', interval=0, **kw))
    return answers


def test_tracker_edits_on_change_and_records_the_completed_torrent(tg, torrent, monkeypatch):
    reply = FakeMessage(CHAT)
    track(tg, reply, [
        RuntimeError('rpc timeout'),                                  # logged, polled again
        {'name': 'Ubuntu.iso', 'percent_done': 10.4},
        {'name': 'Ubuntu.iso', 'percent_done': 10.4},                 # same text: no edit
        {'name': 'Ubuntu.iso', 'percent_done': 100, 'download_dir': '/home6/u/final/',
         'content_path': '/home6/u/telegram/progress/Ubuntu', 'total_size': 4096},
        {'name': 'never polled'},
    ], monkeypatch)
    assert reply.edits == [
        '`Ubuntu.iso` download progress: 10%',
        '`Ubuntu.iso` download complete. Reply "download" to this message to download it to DownLee.',
    ]
    assert torrent.calls[-2:] == [('move', 'transmission', ['abc123'], '/home6/u/final'), ('dirs', 'transmission')]
    pending = tg._pending_downlee[(CHAT, reply.id)]
    assert pending['name'] == 'Ubuntu.iso' and pending['size'] == 4096
    assert pending['msg'] is reply and pending['client'] == 'transmission'
    # Where the files might be, in order, with the duplicate progress-dir entry dropped
    assert pending['candidates'] == [
        '/home6/u/telegram/progress/Ubuntu',
        '/home6/u/final/Ubuntu',
        '/home6/u/telegram/downloads/Ubuntu',
    ]


def test_tracker_without_a_content_path_uses_the_torrent_name(tg, torrent, monkeypatch):
    reply = FakeMessage(CHAT)
    torrent.dirs_error = RuntimeError('no config')          # telegram dirs unavailable: skipped
    track(tg, reply, [{'name': 'Show.S01', 'percent_done': 100, 'download_dir': ''}], monkeypatch)
    assert tg._pending_downlee[(CHAT, reply.id)]['candidates'] == []
    assert not any(c[0] == 'move' for c in torrent.calls)  # no download dir: nothing to move to


def test_tracker_records_the_torrent_even_when_the_move_fails(tg, torrent, monkeypatch):
    def failing_move(client, hashes, location):
        raise RuntimeError('rpc down')
    monkeypatch.setattr(web_pkg, 'torrent_set_location', failing_move)
    reply = FakeMessage(CHAT)
    track(tg, reply, [{'name': 'Show.S01', 'percent_done': 100, 'download_dir': '/home6/u/final'}], monkeypatch)
    assert tg._pending_downlee[(CHAT, reply.id)]['candidates'][0] == '/home6/u/final/Show.S01'
    assert reply.edits[-1].startswith('`Show.S01` download complete')


def test_tracker_stops_on_removal_error_or_the_poll_cap(tg, torrent, monkeypatch):
    reply = FakeMessage(CHAT)
    track(tg, reply, [None], monkeypatch)
    assert reply.edits == ['🧲 placeholder: removed from torrent client']

    reply = FakeMessage(CHAT)
    track(tg, reply, [{'name': 'Bad', 'error': 'tracker says no'}], monkeypatch)
    assert reply.edits == ['❌ Bad: tracker says no']

    reply = FakeMessage(CHAT)
    left = track(tg, reply, [{'percent_done': 50}, {'percent_done': 60}, {'percent_done': 70}], monkeypatch, max_polls=2)
    assert len(left) == 1
    assert reply.edits == ['`placeholder` download progress: 50%', '`placeholder` download progress: 60%',
                           '⬇️ placeholder: still downloading — check the dashboard']
    assert tg._pending_downlee == {}


def test_safe_edit_swallows_edit_failures(tg):
    msg = FakeMessage(CHAT)
    msg.edit_error = RuntimeError('message not modified')
    run(tg._safe_edit(msg, 'x'))
    assert msg.edits == []


# ---------------------------------------------------------------------------
# "download" reply -> VPS->DownLee transfer
# ---------------------------------------------------------------------------

def test_only_a_download_reply_to_a_pending_prompt_triggers_the_pull(tg, monkeypatch):
    started = []

    async def start(pending):
        started.append(pending)
    monkeypatch.setattr(tg, '_start_downlee_from_torrent', start)
    prompt = FakeMessage(CHAT)
    tg._pending_downlee[(CHAT, prompt.id)] = {'name': 'Ubuntu.iso', 'msg': prompt}

    assert run(tg._maybe_handle_downlee_reply(FakeEvent(tg.client, text='download'))) is False       # not a reply
    assert run(tg._maybe_handle_downlee_reply(FakeEvent(tg.client, text='download', reply_to=999))) is False
    assert run(tg._maybe_handle_downlee_reply(FakeEvent(tg.client, text='thanks!', reply_to=prompt.id))) is False
    assert run(tg._maybe_handle_downlee_reply(FakeEvent(tg.client, text='download', reply_to=prompt.id, chat_id=-2))) is False
    assert started == [] and (CHAT, prompt.id) in tg._pending_downlee

    # Through the top of the file handler, case-insensitive, trigger once
    run(tg._handle_new_file(FakeEvent(tg.client, text='  Download it  ', reply_to=prompt.id)))
    assert started == [{'name': 'Ubuntu.iso', 'msg': prompt}]
    assert tg._pending_downlee == {}
    assert run(tg._maybe_handle_downlee_reply(FakeEvent(tg.client, text='download', reply_to=prompt.id))) is False


@pytest.fixture
def vps(web, monkeypatch):
    """A VPS downloader on the web app whose start_download is recorded."""
    calls = []
    state = SimpleNamespace(calls=calls, result={'status': 'started', 'message_id': 'uuid-1'}, error=None)

    def start_download(path, size, dest=None):
        calls.append((path, size, dest))
        if state.error:
            raise state.error
        return state.result
    web.vps_downloader = SimpleNamespace(start_download=start_download)
    monkeypatch.setattr(th.TelegramDownloader, '_resolve_existing_remote',
                        staticmethod(lambda candidates: candidates[0] if candidates else None))
    return state


def pending_for(msg, **extra):
    return {'candidates': ['/home6/u/final/Ubuntu', '/home6/u/telegram/progress/Ubuntu'],
            'name': 'Ubuntu.iso', 'size': 4096, 'msg': msg, 'client': 'transmission', **extra}


def test_the_pull_starts_at_the_clients_local_folder_and_is_tracked(tg, vps, tracked):
    transmission_default(local_dir=' /mnt/media/torrents ')
    msg = FakeMessage(CHAT)
    run(tg._start_downlee_from_torrent(pending_for(msg)))
    assert vps.calls == [('/home6/u/final/Ubuntu', 4096, '/mnt/media/torrents')]
    assert msg.edits == ['⬇️ `Ubuntu.iso` downloading to DownLee: 0%']
    assert tracked['downlee'] == [(msg, 'uuid-1', 'Ubuntu.iso')]


def test_the_pull_without_a_local_folder_or_client_uses_the_default_destination(tg, vps, tracked):
    transmission_default()
    msg = FakeMessage(CHAT)
    run(tg._start_downlee_from_torrent(pending_for(msg)))
    run(tg._start_downlee_from_torrent(pending_for(msg, client=None)))
    run(tg._start_downlee_from_torrent(pending_for(msg, client='deluge')))
    assert [c[2] for c in vps.calls] == [None, None, None]
    # A legacy pending entry carries a single `path`
    legacy = {'path': '/home6/u/old', 'name': 'Old', 'msg': msg}
    run(tg._start_downlee_from_torrent(legacy))
    assert vps.calls[-1] == ('/home6/u/old', 0, None)


def test_the_pull_reports_every_way_it_cannot_start(tg, vps, tracked, monkeypatch):
    msg = FakeMessage(CHAT)
    vps.result = None                                         # handler returned nothing: no tracker
    run(tg._start_downlee_from_torrent(pending_for(msg)))
    assert msg.edits[-1] == '⬇️ `Ubuntu.iso` downloading to DownLee: 0%' and tracked['downlee'] == []

    vps.result = {'error': 'already downloaded'}
    run(tg._start_downlee_from_torrent(pending_for(msg)))
    assert msg.edits[-1] == '❌ `Ubuntu.iso`: already downloaded'

    vps.error = RuntimeError('ssh refused')
    run(tg._start_downlee_from_torrent(pending_for(msg)))
    assert msg.edits[-1] == '❌ `Ubuntu.iso`: could not start download to DownLee'

    monkeypatch.setattr(th.TelegramDownloader, '_resolve_existing_remote', staticmethod(lambda c: None))
    run(tg._start_downlee_from_torrent(pending_for(msg)))
    assert msg.edits[-1] == '❌ `Ubuntu.iso`: files not found on the VPS yet — try again shortly'

    tg_web = web_pkg.get_web_app()
    tg_web.vps_downloader = None
    run(tg._start_downlee_from_torrent(pending_for(msg)))
    assert msg.edits[-1] == '`Ubuntu.iso` — VPS downloader unavailable'
    assert len(vps.calls) == 3


def test_resolve_existing_remote_checks_each_candidate_over_sftp(tg, fake_sftp, monkeypatch):
    closed = []
    ssh = SimpleNamespace(close=lambda: closed.append(True))
    monkeypatch.setattr(web_pkg, 'open_vps_sftp', lambda: (ssh, fake_sftp))
    resolve = th.TelegramDownloader._resolve_existing_remote
    assert resolve(['/home6/tester/nope/Show.S01', '/home6/tester/downloads/Show.S01', '/home6/tester/downloads/movie.mkv']) \
        == '/home6/tester/downloads/Show.S01'
    assert resolve(['/home6/tester/nope', '/home6/tester/also-nope']) is None
    assert resolve([]) is None
    assert closed == [True, True]                             # the session is closed either way

    def broken():
        raise ValueError('VPS not configured')
    monkeypatch.setattr(web_pkg, 'open_vps_sftp', broken)
    assert resolve(['/first', '/second']) == '/first'         # can't check: assume the first


def test_resolve_existing_remote_survives_a_close_failure(tg, fake_sftp, monkeypatch):
    def close():
        raise OSError('already closed')
    monkeypatch.setattr(web_pkg, 'open_vps_sftp', lambda: (SimpleNamespace(close=close), fake_sftp))
    assert th.TelegramDownloader._resolve_existing_remote(['/home6/tester/notes.txt']) == '/home6/tester/notes.txt'


def test_downlee_tracker_follows_the_transfer_record(tg, db):
    msg = FakeMessage(CHAT)
    rec = db.add_download(file='Ubuntu', status='downloading', downloaded_from='vps', url='/home6/u/final/Ubuntu')
    mid = rec['message_id']

    async def go():
        db.update_download_by_message_id(mid, progress=40.4)
        await tg._track_downlee_progress(msg, mid, 'Ubuntu.iso', interval=0, max_polls=2)   # same text twice: one edit
        db.update_download_by_message_id(mid, status='done')
        await tg._track_downlee_progress(msg, mid, 'Ubuntu.iso', interval=0, max_polls=5)
    run(go())
    assert msg.edits == ['⬇️ `Ubuntu.iso` downloading to DownLee: 40%',
                         '⬇️ `Ubuntu.iso`: still downloading to DownLee — check the dashboard',
                         '✅ `Ubuntu.iso` downloaded to DownLee']


def test_downlee_tracker_reports_failures_and_vanished_records(tg, db):
    msg = FakeMessage(CHAT)
    rec = db.add_download(file='Ubuntu', status='failed', downloaded_from='vps', url='/x', error='disk full')
    run(tg._track_downlee_progress(msg, rec['message_id'], 'U', interval=0))
    rec2 = db.add_download(file='Other', status='stopped', downloaded_from='vps', url='/y')
    run(tg._track_downlee_progress(msg, rec2['message_id'], 'O', interval=0))
    run(tg._track_downlee_progress(msg, 'no-such-id', 'N', interval=0))
    assert msg.edits == ['❌ `U` DownLee download failed: disk full', '❌ `O` DownLee download stopped']


# ---------------------------------------------------------------------------
# Chat queries
# ---------------------------------------------------------------------------

def test_default_queries_are_seeded_once(tg, db):
    assert [q['key'] for q in tg.get_queries()] == ['health', 'hello']
    assert db.get_setting('bot_queries_seeded') == '1'
    # Once seeded, an emptied table stays empty - the user deleted them on purpose
    db.delete_bot_query('health')
    db.delete_bot_query('hello')
    assert tg.get_queries() == []


def test_query_env_restores_the_standard_path_and_exposes_the_sender(tg, monkeypatch):
    monkeypatch.setenv('PATH', '/opt/venv/bin')
    env = th.TelegramDownloader._query_env({'SENDER_NAME': 'Ann', 'EMPTY': None, 'N': 7})
    assert env['PATH'].split(':') == ['/opt/venv/bin', '/usr/local/sbin', '/usr/local/bin',
                                      '/usr/sbin', '/usr/bin', '/sbin', '/bin']
    assert env['DOWNLOAD_DIR'] == str(th.DOWNLOAD_DIR)
    assert env['SENDER_NAME'] == 'Ann' and env['N'] == '7' and 'EMPTY' not in env


def test_query_output_formatting():
    fmt = th.TelegramDownloader._format_query_output
    assert fmt('  out\n', '', 0) == 'out'
    assert fmt('', 'err', 2) == 'err\n(exit code 2)'
    assert fmt('', '', 0) == '(no output)'
    assert fmt(None, None, 1) == '(exit code 1)'


def test_run_query_sync_and_async(tg, monkeypatch):
    run_sync = th.TelegramDownloader.run_query_sync
    assert run_sync('echo "hi $WHO"', {'WHO': 'there'}) == 'hi there'
    assert run_sync('echo oops >&2; exit 3') == 'oops\n(exit code 3)'
    assert run(th.TelegramDownloader.run_query_command('echo "$DOWNLOAD_DIR"')) == str(th.DOWNLOAD_DIR)
    assert run(th.TelegramDownloader.run_query_command('echo e >&2; exit 1')) == 'e\n(exit code 1)'
    monkeypatch.setattr(th, 'QUERY_TIMEOUT', 0.2)
    # `exec` so the kill lands on the command itself, not just the shell in
    # front of it - otherwise the orphaned sleep holds the pipe open
    assert run_sync('exec sleep 3') == '⏱️ Timed out after 0.2s'

    async def timed_out():
        res = await th.TelegramDownloader.run_query_command('exec sleep 3')
        await asyncio.sleep(0.1)       # let the killed child's pipes close before the loop does
        return res
    assert run(timed_out()) == '⏱️ Timed out after 0.2s'


# ---------------------------------------------------------------------------
# Mentions
# ---------------------------------------------------------------------------

def ann():
    return TgUser(id=7, first_name='Ann', last_name='Lee', username='ann')


def mention(tg, text, sender=None, **kw):
    kw.setdefault('mentioned', True)
    ev = FakeEvent(tg.client, text=text, sender=sender or ann(), **kw)
    run(tg._handle_mention(ev))
    return [m.text for m in ev.replies]


def test_every_message_registers_its_sender_once(tg, db):
    ev = FakeEvent(tg.client, text='hello all', sender=ann())
    run(tg._handle_mention(ev))
    users = [u for u in db.get_users() if u['telegram_id'] == '7']
    assert len(users) == 1 and users[0]['role'] == 'user' and users[0]['display_name'] == 'Ann Lee'
    assert tg._seen_users[7] == ('ann', 'Ann Lee')
    assert ev.replies == []                                   # not a mention: no command handling
    # Bots, non-users and unresolvable senders are not registered
    run(tg._handle_mention(FakeEvent(tg.client, text='x', sender=TgUser(id=8, first_name='B', bot=True))))
    run(tg._handle_mention(FakeEvent(tg.client, text='x', sender=SimpleNamespace(id=9))))
    ev = FakeEvent(tg.client, text='x', sender=ann())
    ev.sender_error = RuntimeError('privacy')
    run(tg._handle_mention(ev))
    assert sorted(u['telegram_id'] for u in db.get_users() if u['telegram_id']) == ['7']


def test_queries_are_for_admins_only(tg, db):
    assert mention(tg, '@DownLeeBot health') == ['⛔ Sorry, only admins can run queries.']
    assert mention(tg, 'help') == ['⛔ Sorry, only admins can run queries.']
    # A sender that can't be resolved has no role either
    ev = FakeEvent(tg.client, text='health', sender=None, mentioned=True)
    run(tg._handle_mention(ev))
    assert [m.text for m in ev.replies] == ['⛔ Sorry, only admins can run queries.']
    # Unknown keys, empty text and over-long text are ignored outright
    assert mention(tg, '@downleebot') == []
    assert mention(tg, 'nosuchquery') == []
    assert mention(tg, 'h' * 65) == []


def test_an_admin_runs_a_query_with_the_sender_in_its_environment(tg, db):
    mention(tg, 'hi')                                         # registers Ann
    user = next(u for u in db.get_users() if u['telegram_id'] == '7')
    db.update_user_role(user['id'], 'admin')
    db.upsert_bot_query('who', 'echo "$SENDER_NAME|$SENDER_USERNAME|$SENDER_ID|$CHAT_TITLE"')
    assert mention(tg, '@downleebot hello') == ['Hello Ann Lee, hope you are good? 😊']
    assert mention(tg, ' WHO ', is_private=True, mentioned=False) == ['Ann Lee|ann|7|Test chat']
    assert mention(tg, 'help') == ['Available queries: health, hello, who']


def test_a_query_with_no_chat_title_and_long_output(tg, db):
    mention(tg, 'hi')
    user = next(u for u in db.get_users() if u['telegram_id'] == '7')
    db.update_user_role(user['id'], 'admin')
    db.upsert_bot_query('big', 'head -c 5000 /dev/zero | tr "\\0" x')
    ev = FakeEvent(tg.client, text='big', sender=ann(), mentioned=True)

    async def no_chat():
        raise RuntimeError('no chat')
    ev.get_chat = no_chat
    run(tg._handle_mention(ev))
    assert len(ev.replies) == 1 and len(ev.replies[0].text) == 4000


def test_mention_handler_never_raises(tg, monkeypatch):
    async def boom():
        raise RuntimeError('get_me failed')
    tg.client.get_me = boom
    assert mention(tg, 'health') == []


def test_a_bot_without_a_username_still_answers(tg, db):
    tg.client.me.username = None
    mention(tg, 'hi')
    user = next(u for u in db.get_users() if u['telegram_id'] == '7')
    db.update_user_role(user['id'], 'admin')
    assert mention(tg, 'help') == ['Available queries: health, hello']


def test_the_registered_handlers_route_to_the_real_methods(tg, monkeypatch):
    seen = []

    async def file_handler(event):
        seen.append(('file', event))

    async def mention_handler(event):
        seen.append(('mention', event))
    monkeypatch.setattr(tg, '_handle_new_file', file_handler)
    monkeypatch.setattr(tg, '_handle_mention', mention_handler)
    ev = FakeEvent(tg.client, text='x')
    for cb, _builder in tg.client.handlers:
        run(cb(ev))
    assert [k for k, _ in seen] == ['mention', 'file']
    # Re-registering swaps both, never stacks them
    tg._register_handler()
    assert len(tg.client.handlers) == 2
    assert json.dumps(tg.get_channels())                      # still serialisable for the settings UI

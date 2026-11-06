"""Telegram handler: client setup, channels, web login, the startup greeting
and the download path itself (routing, rename rules, queue admission,
progress throttling, retries, pause/resume).

No Telethon client is ever started. `FakeTelegramClient` stands in for it -
it records what the handler sends and edits, and `iter_download` serves bytes
from the fake message's media, raising on demand so the retry/backoff path can
be driven. The real DatabaseManager runs on the conftest SQLite database.
Every coroutine runs under asyncio.run; nothing blocks.

The second half of the handler (magnets, the VPS->DownLee hand-off, chat
queries) lives in test_telegram_torrents_queries.py, which imports the fakes
from here.
"""
import asyncio
import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from telethon.errors import SessionPasswordNeededError
from telethon.tl.types import Channel, PeerChannel, User as TgUser

from backend import download_queue as dq
from backend import telegram_handler as th
from backend.web_app import base as web_base

CHAT = -1001234567890
_real_sleep = asyncio.sleep          # the fakes yield with this even when a test patches asyncio.sleep


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeSocket:
    def __init__(self):
        self.events = []

    def emit(self, event, data=None):
        self.events.append((event, data))

    def of(self, name):
        return [d for e, d in self.events if e == name]


class FakeWebApp:
    """What get_web_app() hands out: stats emits counted, downloaders unwired."""

    def __init__(self):
        self.stats_emitted = 0
        self.vps_downloader = None
        self.ytdlp_downloader = None
        self.telegram_downloader = None
        self.event_loop = None

    def emit_stats(self):
        self.stats_emitted += 1


class FakeClock:
    """Drives the module's `datetime.now()`; the fake client ticks it per chunk."""

    def __init__(self, start=datetime(2024, 1, 2, 3, 4, 5)):
        self.now = start
        self.step = 0

    def tick(self, seconds=None):
        self.now += timedelta(seconds=self.step if seconds is None else seconds)


_ids = iter(range(1000, 10 ** 6))


class FakeMessage:
    """A message the bot sent (a reply or a status message), editable."""

    def __init__(self, chat_id=CHAT, text=''):
        self.id = next(_ids)
        self.chat_id = chat_id
        self.text = text
        self.edits = []
        self.edit_error = None

    async def edit(self, text):
        await _real_sleep(0)
        if self.edit_error:
            raise self.edit_error
        self.edits.append(text)
        return self


class FakeFile:
    def __init__(self, name, mime_type, size):
        self.name = name
        self.mime_type = mime_type
        self.size = size


class FakeEvent:
    """A NewMessage event. Doubles as the Message object `get_messages`
    returns for its own id, which is what restart_download re-fetches."""

    def __init__(self, client, *, chat_id=CHAT, text='', data=None, name='clip.mp4',
                 mime_type='video/mp4', size=None, sender='default', reply_to=None,
                 mentioned=False, is_private=False, post_author=None):
        self.client = client
        self.id = next(_ids)
        self.chat_id = chat_id
        self.raw_text = text
        if data is not None:
            self.file = FakeFile(name, mime_type, len(data) if size is None else size)
            self.media = SimpleNamespace(data=data)
        else:
            self.file = None
            self.media = None
        self.message = SimpleNamespace(
            id=self.id,
            reply_to=SimpleNamespace(reply_to_msg_id=reply_to) if reply_to else None,
            post_author=post_author)
        if sender == 'default':
            sender = SimpleNamespace(id=42, username='alice', first_name='Alice')
        self.sender = sender
        self.sender_error = None
        self.mentioned = mentioned
        self.is_private = is_private
        self.chat = SimpleNamespace(title='Test chat')
        self.replies = []
        self.reply_error = None
        client.messages[(chat_id, self.id)] = self

    async def reply(self, text, **_kw):
        await _real_sleep(0)
        if self.reply_error:
            raise self.reply_error
        msg = FakeMessage(self.chat_id, text)
        self.replies.append(msg)
        self.client.messages[(self.chat_id, msg.id)] = msg
        return msg

    async def get_sender(self):
        if self.sender_error:
            raise self.sender_error
        return self.sender

    async def get_chat(self):
        return self.chat


class _Done:
    """An already-finished awaitable (not a coroutine, so discarding it is silent)."""

    def __await__(self):
        return
        yield  # noqa: unreachable - makes this a generator


class FakeTelegramClient:
    """Stands in for telethon.TelegramClient. Nothing here touches a socket."""

    def __init__(self, session=None, api_id=None, api_hash=None):
        self.session, self.api_id, self.api_hash = session, api_id, api_hash
        self.handlers = []                    # (callback, event builder)
        self.messages = {}                    # (chat_id, msg_id) -> message-like
        self.sent = []                        # (chat_id, text)
        self.send_error = None
        self.get_messages_error = None
        # iter_download control: one entry per call - None succeeds, an
        # exception raises at once, (n, exc) yields n chunks then raises
        self.chunk_failures = []
        self.chunk_size = 4
        self.chunk_gate = None                # asyncio.Event a chunk waits on (cancel tests)
        self.clock = None
        self.download_calls = []              # resume offsets seen
        self.entities = {}                    # identifier -> entity or exception
        self.dialogs = []
        self.participants = {}                # chat_id -> list or exception
        self.me = SimpleNamespace(id=1, username='downleebot', bot=False,
                                  first_name='Down', last_name='Lee', phone='+10000')
        self.connected = True
        self.authorized = True
        self.authorized_error = None
        self.disconnected = 0
        self.logged_out = 0
        self.sign_in_calls = []
        self.sign_in_error = None

    def add_event_handler(self, cb, builder):
        self.handlers.append((cb, builder))

    def remove_event_handler(self, cb):
        self.handlers = [h for h in self.handlers if h[0] is not cb]

    def is_connected(self):
        return self.connected

    async def connect(self):
        self.connected = True

    def disconnect(self):
        # Telethon's disconnect() hands back an awaitable when a loop is
        # running; stop() calls it bare, set_api_credentials awaits it.
        self.disconnected += 1
        self.connected = False
        return _Done()

    async def run_until_disconnected(self):
        pass

    async def is_user_authorized(self):
        if self.authorized_error:
            raise self.authorized_error
        return self.authorized

    async def get_me(self):
        return self.me

    async def log_out(self):
        self.logged_out += 1
        self.authorized = False

    async def send_message(self, chat_id, text):
        if self.send_error:
            raise self.send_error
        msg = FakeMessage(chat_id, text)
        self.sent.append((chat_id, text))
        self.messages[(chat_id, msg.id)] = msg
        return msg

    async def get_messages(self, chat_id, ids=None):
        await _real_sleep(0)
        if self.get_messages_error:
            raise self.get_messages_error
        return self.messages.get((chat_id, ids))

    async def get_entity(self, identifier):
        if identifier not in self.entities:
            raise ValueError(f'Could not find the input entity for {identifier}')
        ent = self.entities[identifier]
        if isinstance(ent, Exception):
            raise ent
        return ent

    async def iter_dialogs(self):
        for d in self.dialogs:
            yield d

    async def get_dialogs(self, limit=200):
        return list(self.dialogs)[:limit]

    async def get_participants(self, chat_id):
        p = self.participants.get(chat_id, [])
        if isinstance(p, Exception):
            raise p
        return p

    async def send_code_request(self, phone):
        self.code_requested = phone
        return SimpleNamespace(phone_code_hash='hash123')

    async def sign_in(self, **kw):
        self.sign_in_calls.append(kw)
        if self.sign_in_error:
            err, self.sign_in_error = self.sign_in_error, None
            raise err
        self.authorized = True

    async def iter_download(self, media, offset=0, file_size=0, request_size=0):
        self.download_calls.append(offset)
        plan = self.chunk_failures.pop(0) if self.chunk_failures else None
        fail_after, exc = (plan if isinstance(plan, tuple) else (None, plan))
        if exc is not None and fail_after is None:
            raise exc
        data = media.data[offset:]
        for n, i in enumerate(range(0, len(data), self.chunk_size)):
            if fail_after is not None and n >= fail_after:
                raise exc
            if self.chunk_gate is not None:
                await self.chunk_gate.wait()
            if self.clock:
                self.clock.tick()
            yield data[i:i + self.chunk_size]


def run(coro):
    return asyncio.run(coro)


async def settle(n=5):
    """Let background tasks the handler spawned get their turn."""
    for _ in range(n):
        await _real_sleep(0)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sio(monkeypatch):
    sock = FakeSocket()
    monkeypatch.setattr(web_base, 'socketio', sock)
    return sock


@pytest.fixture
def web(monkeypatch):
    w = FakeWebApp()
    monkeypatch.setattr(web_base, '_web_app', w)
    return w


@pytest.fixture
def clock(monkeypatch):
    c = FakeClock()

    class FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return c.now

    monkeypatch.setattr(th, 'datetime', FakeDatetime)
    return c


@pytest.fixture
def tg_env(db, sio, web, clock, monkeypatch, tmp_path):
    """Everything the constructor reads, pointed away from the deployment:
    a fake client class, test API credentials, a temp download dir and a
    temp greeting sentinel (the real one sits in the project root)."""
    monkeypatch.setattr(th, 'TelegramClient', FakeTelegramClient)
    monkeypatch.setattr(th, 'API_ID', 4242)
    monkeypatch.setattr(th, 'API_HASH', 'env-hash')
    monkeypatch.setattr(th, 'CHAT_ID', CHAT)
    monkeypatch.setattr(th, 'SKIP_STARTUP_GREETING', False)
    monkeypatch.setattr(th, 'SKIP_GREETING_FILE', tmp_path / '.skip-greeting')
    monkeypatch.setattr(th, 'DOWNLOAD_DIR', tmp_path / 'downloads')
    monkeypatch.setattr(th, 'MAX_RETRIES', 3)
    meta_polls = []

    async def fake_poll(message_id):
        meta_polls.append(message_id)
    monkeypatch.setattr(th, 'poll_and_extract_meta', fake_poll)
    from backend import rename
    rename.invalidate_rules_cache()
    return SimpleNamespace(meta_polls=meta_polls, tmp_path=tmp_path)


@pytest.fixture
def tg(tg_env, clock):
    downloader = th.TelegramDownloader(download_tasks={})
    downloader.client.clock = clock
    downloader.meta_polls = tg_env.meta_polls
    return downloader


@pytest.fixture
def fast_sleep(monkeypatch):
    """Records the handler's backoff sleeps instead of waiting them out."""
    calls = []

    async def fake_sleep(seconds):
        calls.append(seconds)
        await _real_sleep(0)
    monkeypatch.setattr(th.asyncio, 'sleep', fake_sleep)
    return calls


def row(db, event_or_id):
    mid = event_or_id if isinstance(event_or_id, int) else event_or_id.id
    return db.get_download_by_message_id(mid)


# ---------------------------------------------------------------------------
# Construction, credentials, channels
# ---------------------------------------------------------------------------

def test_constructor_seeds_channels_from_env_and_registers_handlers(tg, db):
    assert tg.chat_ids() == [CHAT]
    assert json.loads(db.get_setting(th.CHANNELS_SETTING_KEY)) == [{'id': CHAT, 'title': str(CHAT)}]
    assert tg.get_api_config() == {'configured': True, 'api_id': 4242, 'has_hash': True, 'source': 'env'}
    # One mention handler plus one file handler for the channel list
    assert len(tg.client.handlers) == 2
    assert tg.default_chat_id() == CHAT


def test_without_credentials_there_is_no_client(tg_env, monkeypatch):
    monkeypatch.setattr(th, 'API_HASH', 'your_api_hash_here')
    downloader = th.TelegramDownloader(download_tasks={})
    assert downloader.client is None
    assert downloader.get_api_config()['configured'] is False
    assert run(downloader.set_api_credentials(1, '')) == {'error': 'API hash is required'}
    assert run(downloader.list_dialogs()) == []
    assert run(downloader.add_channel('@x')) == {'error': 'Telegram is not connected'}
    assert run(downloader.send_login_code('+1')) == {'error': 'Configure the API ID and hash first'}
    assert run(downloader.submit_bot_token('t')) == {'error': 'Configure the API ID and hash first'}
    assert run(downloader.get_status())['api_configured'] is False
    downloader.stop()          # no client to disconnect


def test_credentials_saved_in_the_database_win_over_env(tg, db):
    old_client = tg.client
    res = run(tg.set_api_credentials(999, 'db-hash'))
    assert res['status'] == 'saved' and res['source'] == 'database'
    assert tg.client is not old_client and tg.client.api_id == 999
    assert old_client.disconnected == 1
    assert len(tg.client.handlers) == 2          # re-registered on the new client
    # A blank hash keeps the saved one
    run(tg.set_api_credentials(1000, ''))
    assert tg.api_hash == 'db-hash' and tg.api_id == 1000
    # A fresh instance reads them back, decrypted
    again = th.TelegramDownloader(download_tasks={})
    assert (again.api_id, again.api_hash, again.api_source) == (1000, 'db-hash', 'database')


def test_a_corrupt_api_setting_falls_back_to_env(tg_env, db):
    db.set_setting(th.API_SETTING_KEY, '{not json')
    downloader = th.TelegramDownloader(download_tasks={})
    assert downloader.api_source == 'env'


def test_channels_setting_is_read_back_and_bad_json_reseeds(tg_env, db):
    db.set_setting(th.CHANNELS_SETTING_KEY, json.dumps([{'id': -5, 'title': 'Five'}, 'junk', {'title': 'no id'}]))
    assert th.TelegramDownloader(download_tasks={}).get_channels() == [{'id': -5, 'title': 'Five'}]
    db.set_setting(th.CHANNELS_SETTING_KEY, '[broken')
    assert th.TelegramDownloader(download_tasks={}).chat_ids() == [CHAT]


def test_no_channels_means_no_file_handler(tg_env, monkeypatch):
    monkeypatch.setattr(th, 'CHAT_ID', 0)
    downloader = th.TelegramDownloader(download_tasks={})
    assert downloader.chat_ids() == []
    assert len(downloader.client.handlers) == 1          # mentions only
    assert downloader.default_chat_id() == 0


def test_add_and_remove_channel(tg, db):
    tg.client.entities['@ann'] = TgUser(id=77, first_name='Ann', last_name='Lee')

    async def go():
        res = await tg.add_channel(' @ann ')
        await settle()
        return res
    assert run(go())['channels'][-1] == {'id': 77, 'title': 'Ann Lee'}
    assert run(tg.add_channel('@ann')) == {'error': '"Ann Lee" is already being monitored'}
    assert len(json.loads(db.get_setting(th.CHANNELS_SETTING_KEY))) == 2
    assert run(tg.remove_channel(77))['channels'] == [{'id': CHAT, 'title': str(CHAT)}]
    # A numeric string is resolved as an id, in its marked form
    tg.client.entities[-1009876543210] = Channel(id=9876543210, title='Docs', photo=None, date=None)

    async def numeric():
        res = await tg.add_channel('9876543210')
        await settle()
        return res
    assert run(numeric())['channels'][-1] == {'id': -1009876543210, 'title': 'Docs'}


def test_numeric_ids_are_tried_in_every_marked_form(tg):
    channel = Channel(id=1234567890, title='Movies', photo=None, date=None)
    tg.client.entities[CHAT] = channel
    # A bare id is retried as -100<id>
    assert run(tg._resolve_entity(1234567890)) is channel
    # A positive id with nothing found scans dialogs
    tg.client.entities.clear()
    tg.client.dialogs = [SimpleNamespace(id=-1234567890, entity='via-dialogs')]
    assert run(tg._resolve_entity(1234567890)) == 'via-dialogs'
    # A bot can't scan dialogs, so the first error is what comes back
    tg.client.me.bot = True
    with pytest.raises(ValueError, match='1234567890'):
        run(tg._resolve_entity(1234567890))
    # Non-numeric identifiers go straight through
    tg.client.entities['@x'] = 'entity-x'
    assert run(tg._resolve_entity('@x')) == 'entity-x'


def test_refresh_channel_titles_normalizes_ids_and_names(tg, db):
    tg.channels = [{'id': 1234567890, 'title': '1234567890'}, {'id': -5, 'title': 'Named'}]
    tg.client.entities[CHAT] = Channel(id=1234567890, title='Movies', photo=None, date=None)
    run(tg.refresh_channel_titles())
    assert tg.channels[0] == {'id': CHAT, 'title': 'Movies'}
    assert tg.channels[1] == {'id': -5, 'title': 'Named'}           # already named: untouched
    assert json.loads(db.get_setting(th.CHANNELS_SETTING_KEY))[0]['id'] == CHAT
    # An unresolvable one is logged and left alone
    tg.channels = [{'id': 99, 'title': '99'}]
    run(tg.refresh_channel_titles())
    assert tg.channels == [{'id': 99, 'title': '99'}]


def test_per_channel_torrent_client_beats_the_global_default(tg, monkeypatch):
    monkeypatch.setattr('backend.web_app.torrent.get_telegram_default', lambda: 'qbittorrent')
    assert tg.torrent_client_for_chat(CHAT) == 'qbittorrent'
    assert tg.set_channel_torrent_client(CHAT, 'transmission')['channels'][0]['torrent_client'] == 'transmission'
    assert tg.torrent_client_for_chat(CHAT) == 'transmission'
    assert tg.torrent_client_for_chat(-999) == 'qbittorrent'          # unknown chat -> default
    assert tg.set_channel_torrent_client(CHAT, 'none')['channels'][0] == {'id': CHAT, 'title': str(CHAT)}
    assert tg.set_channel_torrent_client(CHAT, 'deluge') == {'error': 'Unknown torrent client'}
    assert tg.set_channel_torrent_client(-999, 'transmission') == {'error': 'Channel is not monitored'}


def test_list_dialogs_sorts_chats_before_people(tg):
    tg.client.dialogs = [
        SimpleNamespace(id=3, title='zed', is_channel=False, is_group=False, entity=SimpleNamespace(username='zed')),
        SimpleNamespace(id=CHAT, title='Movies', is_channel=True, is_group=False, entity=SimpleNamespace()),
        SimpleNamespace(id=2, title=None, is_channel=False, is_group=True, entity=SimpleNamespace(username='grp')),
    ]
    out = run(tg.list_dialogs())
    assert [(d['id'], d['type'], d['monitored']) for d in out] == [
        (2, 'group', False), (CHAT, 'channel', True), (3, 'user', False)]
    assert out[0]['title'] == '2' and out[1]['username'] is None
    tg.client.me.bot = True
    with pytest.raises(ValueError, match='Bot accounts'):
        run(tg.list_dialogs())


def test_sync_channel_members_registers_people_and_skips_the_rest(tg, db):
    tg.client.participants[CHAT] = [
        TgUser(id=7, first_name='Ann', last_name='Lee', username='ann'),
        TgUser(id=8, first_name='Bot', bot=True),
        TgUser(id=9, first_name='Gone', deleted=True),
        SimpleNamespace(id=10),                      # a Chat/Channel entry, not a user
    ]
    tg.channels.append({'id': -404, 'title': 'broken'})
    tg.client.participants[-404] = RuntimeError('admins only')
    assert run(tg.sync_channel_members()) == 1
    users = {u['telegram_id']: u for u in db.get_users() if u.get('telegram_id')}
    assert list(users) == ['7']               # the bot, the deleted account and the chat entry were skipped
    assert users['7']['username'] == 'ann' and users['7']['display_name'] == 'Ann Lee'
    assert tg._seen_users[7] == ('ann', 'Ann Lee')


# ---------------------------------------------------------------------------
# Web login flow
# ---------------------------------------------------------------------------

def test_status_reports_the_signed_in_user(tg):
    tg.client.connected = False
    assert run(tg.get_status()) == {'api_configured': True, 'connected': False, 'authorized': False,
                                    'awaiting_code': False, 'user': None}
    tg.client.connected = True
    status = run(tg.get_status())
    assert status['authorized'] is True
    assert status['user'] == {'id': 1, 'username': 'downleebot', 'first_name': 'Down',
                              'last_name': 'Lee', 'phone': '+10000', 'is_bot': False}
    tg.client.authorized_error = RuntimeError('flood')
    assert run(tg.get_status())['authorized'] is False       # logged, not raised


def test_phone_login_with_two_factor_password(tg):
    assert run(tg.submit_login_code('111')) == {'error': 'No pending login. Request a code first.'}
    tg.client.connected = False
    assert run(tg.send_login_code('+15550001')) == {'status': 'code_sent'}
    assert tg.client.connected and tg._login_code_hash == 'hash123'
    assert run(tg.get_status())['awaiting_code'] is True

    tg.client.sign_in_error = SessionPasswordNeededError(request=None)
    assert run(tg.submit_login_code('12345')) == {'status': 'password_required'}
    assert tg.client.sign_in_calls[-1] == {'phone': '+15550001', 'code': '12345', 'phone_code_hash': 'hash123'}
    assert tg._login_code_hash == 'hash123'                   # still pending

    async def finish():
        res = await tg.submit_password('hunter2')
        await settle()
        return res
    assert run(finish()) == {'status': 'authorized'}
    assert tg.authorized and tg._login_phone is None and tg._login_code_hash is None
    # Authorizing greets every monitored chat
    assert [c for c, _ in tg.client.sent] == [CHAT]


def test_code_login_without_two_factor(tg):
    run(tg.send_login_code('+1'))
    assert run(tg.submit_login_code('999')) == {'status': 'authorized'}
    assert tg.authorized


def test_bot_token_login_and_logout(tg):
    tg.client.connected = False
    assert run(tg.submit_bot_token('  123:abc  ')) == {'status': 'authorized'}
    assert tg.client.sign_in_calls == [{'bot_token': '123:abc'}]
    assert run(tg.logout()) == {'status': 'logged_out'}
    assert tg.client.logged_out == 1 and tg.authorized is False


# ---------------------------------------------------------------------------
# Startup greeting
# ---------------------------------------------------------------------------

def test_sentinel_file_is_consumed_as_it_is_read(tg_env, tmp_path):
    sentinel = tmp_path / '.skip-greeting'
    sentinel.touch()
    assert th.TelegramDownloader._consume_greeting_sentinel() is True
    assert not sentinel.exists()
    assert th.TelegramDownloader._consume_greeting_sentinel() is False


def test_every_mute_folds_into_skip_greeting(tg_env, monkeypatch, tmp_path):
    assert th.TelegramDownloader(download_tasks={}).skip_greeting is False
    assert th.TelegramDownloader(download_tasks={}, skip_greeting=True).skip_greeting is True
    monkeypatch.setattr(th, 'SKIP_STARTUP_GREETING', True)
    assert th.TelegramDownloader(download_tasks={}).skip_greeting is True
    monkeypatch.setattr(th, 'SKIP_STARTUP_GREETING', False)
    (tmp_path / '.skip-greeting').touch()
    assert th.TelegramDownloader(download_tasks={}).skip_greeting is True
    assert not (tmp_path / '.skip-greeting').exists()


def test_sentinel_errors_are_logged_not_raised(tg_env, monkeypatch, tmp_path):
    bad = tmp_path / 'dir-not-file'
    bad.mkdir()
    (bad / 'x').touch()                       # unlink() on a non-empty dir -> OSError
    monkeypatch.setattr(th, 'SKIP_GREETING_FILE', bad)
    assert th.TelegramDownloader._consume_greeting_sentinel() is False


@pytest.mark.parametrize('hour,expected', [(6, 'Good Morning'), (13, 'Good Afternoon'), (22, 'Good Evening'), (3, 'Good Evening')])
def test_greeting_follows_the_clock(tg, clock, hour, expected):
    clock.now = datetime(2024, 1, 2, hour, 0, 0)
    tg.channels.append({'id': -2, 'title': 'second'})
    run(tg.send_startup_greeting())
    assert tg.client.sent == [(CHAT, f'{expected}, reporting for duty 🫡'), (-2, f'{expected}, reporting for duty 🫡')]


def test_skip_greeting_is_one_shot(tg_env):
    downloader = th.TelegramDownloader(download_tasks={}, skip_greeting=True)
    run(downloader.send_startup_greeting())
    assert downloader.client.sent == [] and downloader.skip_greeting is False
    run(downloader.send_startup_greeting())          # a later login in the same process greets
    assert len(downloader.client.sent) == 1


def test_a_failed_greeting_does_not_raise(tg):
    tg.client.send_error = RuntimeError('chat not found')
    run(tg.send_startup_greeting())
    assert tg.client.sent == []


# ---------------------------------------------------------------------------
# WebSocket emits and status messages
# ---------------------------------------------------------------------------

def test_emits_stringify_the_message_id(tg, sio, web):
    tg.emit_status(5, 'failed', error='boom')
    tg.emit_status(5, 'done')
    tg.emit_new_download({'message_id': '5'})
    tg.emit_deleted(5)
    assert sio.of('download:status') == [{'message_id': '5', 'status': 'failed', 'error': 'boom'},
                                         {'message_id': '5', 'status': 'done'}]
    assert sio.of('download:new') == [{'message_id': '5'}]
    assert sio.of('download:deleted') == [{'message_id': '5'}]
    assert web.stats_emitted == 1


def test_progress_emits_are_throttled_to_one_per_second(tg, sio, web, clock):
    tg.emit_progress(5, 10.0, 100, 1000, 2.5, 360)
    tg.emit_progress(5, 20.0, 200, 1000, 2.5, 320)          # same second: dropped
    clock.tick(1)
    tg.emit_progress(5, 30.0, 300, 1000, 2.5, 280)
    assert [p['progress'] for p in sio.of('download:progress')] == [10.0, 30.0]
    assert sio.of('download:progress')[0] == {'message_id': '5', 'progress': 10.0, 'downloaded_bytes': 100,
                                              'total_bytes': 1000, 'speed': 2.5, 'pending_time': 360}
    assert web.stats_emitted == 2


def test_nothing_is_emitted_without_a_socket(tg, monkeypatch):
    monkeypatch.setattr(web_base, 'socketio', None)
    tg.emit_status(1, 'done')
    tg.emit_progress(1, 1, 1, 1, 1, None)
    tg.emit_new_download({})
    tg.emit_deleted(1)                      # nothing raised


def test_edit_status_message_texts(tg):
    ev = FakeEvent(tg.client, data=b'')
    run(tg.edit_status_message(ev, {'_status_msg_id': None}))        # nothing to edit
    status_msg = run(ev.reply('⬇️ Status: Downloading'))
    entry = {'_status_msg_id': status_msg.id, 'progress': 42.0, 'downloaded_bytes': 2048, 'total_bytes': 4096}
    run(tg.edit_status_message(ev, entry))
    run(tg.edit_status_message(ev, entry, 'Paused'))
    run(tg.edit_status_message(ev, entry, 'Something else'))
    assert status_msg.edits == ['⬇️ Status: Downloading 42.0% (2.0KB/4.0KB)', '⏸️ Status: Paused', ' Status: Something else']
    status_msg.edit_error = RuntimeError('deleted')
    run(tg.edit_status_message(ev, entry, 'Failed'))                 # logged, not raised


def test_update_status_message_looks_the_message_up_in_the_db(tg, db):
    status_msg = FakeMessage(CHAT)
    tg.client.messages[(CHAT, status_msg.id)] = status_msg
    db.add_download(file='a.mkv', status='paused', message_id=11, chat_id=CHAT)
    run(tg.update_status_message(11, 'Paused'))                      # no status_msg_id yet
    db.update_download_by_message_id(11, status_msg_id=status_msg.id)
    run(tg.update_status_message(11, 'Paused'))
    assert status_msg.edits == ['⏸️ Status: Paused']
    # Legacy rows without chat_id use the default chat
    db.add_download(file='b.mkv', status='stopped', message_id=12)
    db.update_download_by_message_id(12, status_msg_id=status_msg.id)
    run(tg.update_status_message(12, 'Stopped'))
    assert status_msg.edits[-1] == '🛑 Status: Stopped'
    tg.client.get_messages_error = RuntimeError('gone')
    run(tg.update_status_message(12, 'Stopped'))                     # logged, not raised
    run(tg.update_status_message(404, 'Stopped'))                    # unknown download: no-op


# ---------------------------------------------------------------------------
# New file -> download
# ---------------------------------------------------------------------------

async def download(tg, ev):
    """Handle the event and wait for the download task it started."""
    await tg._handle_new_file(ev)
    task = tg.download_tasks.get(ev.id)
    if task:
        await task
    await settle()
    return task


def test_a_video_attachment_is_downloaded_and_reported(tg, db, sio, web, tmp_path):
    ev = FakeEvent(tg.client, data=b'0123456789abcdef', name='Clip.mp4')
    run(download(tg, ev))

    path = tmp_path / 'downloads' / 'Videos' / 'Clip.mp4'
    assert path.read_bytes() == b'0123456789abcdef'
    rec = row(db, ev)
    assert rec['status'] == 'done' and rec['progress'] == 100 and rec['total_bytes'] == 16
    assert rec['author'] == 'alice:42' and rec['chat_id'] == str(CHAT)
    assert rec['queue_position'] is None and rec['speed'] == 0
    assert ev.id not in tg.download_tasks
    assert tg.meta_polls == [ev.id]                    # video: metadata probe scheduled

    assert sio.of('download:new')[0]['message_id'] == str(ev.id)
    assert sio.of('download:status') == [{'message_id': str(ev.id), 'status': 'done'}]
    progress = sio.of('download:progress')
    assert len(progress) == 1 and progress[0]['downloaded_bytes'] == 4     # same second: throttled
    # The chat reply tracks the download
    status_msg = ev.replies[0]
    assert status_msg.text == '⬇️ Status: Downloading'
    assert rec['status_msg_id'] == status_msg.id
    assert '✅ Status: Downloaded' in status_msg.edits
    assert any(e.startswith('⬇️ Status: Downloading 25.0%') for e in status_msg.edits)


@pytest.mark.parametrize('mime,folder', [('image/png', 'Images'), ('application/pdf', 'Documents'), (None, 'Documents')])
def test_attachments_are_filed_by_mime_type(tg, mime, folder, tmp_path):
    ev = FakeEvent(tg.client, data=b'abc', name='thing.bin', mime_type=mime)
    run(download(tg, ev))
    assert (tmp_path / 'downloads' / folder / 'thing.bin').exists()
    assert tg.meta_polls == []                         # not a video


def test_the_telegram_source_mapping_overrides_the_folder(tg, db, tmp_path):
    custom = tmp_path / 'library' / 'tg'
    db.add_download_type_map('telegram', is_secured=True, folder=str(custom))
    ev = FakeEvent(tg.client, data=b'abc', name='a.mp4')
    run(download(tg, ev))
    assert (custom / 'a.mp4').read_bytes() == b'abc'
    # hidden is never stamped on the record - it's computed from the spec at query time
    assert 'hidden' not in row(db, ev)
    assert db.get_download_type_map('telegram')['is_secured'] is True


def test_rename_rules_apply_before_the_file_is_opened(tg, db, tmp_path):
    db.add_rename_rule(pattern=r'\.', replacement=' ', name='dots to spaces')
    from backend.rename import invalidate_rules_cache
    invalidate_rules_cache()
    ev = FakeEvent(tg.client, data=b'abc', name='My.Show.S01E01.mkv')
    run(download(tg, ev))
    folder = tmp_path / 'downloads' / 'Videos'
    assert sorted(p.name for p in folder.iterdir()) == ['My Show S01E01.mkv']
    assert row(db, ev)['file'] == 'My Show S01E01.mkv'


def test_an_attachment_name_cannot_escape_the_folder(tg, db, tmp_path):
    ev = FakeEvent(tg.client, data=b'abc', name='../../evil.mkv')
    run(download(tg, ev))
    folder = tmp_path / 'downloads' / 'Videos'
    assert [p.name for p in folder.iterdir()] == ['evil.mkv']
    assert not (tmp_path / 'evil.mkv').exists()


def test_a_nameless_attachment_gets_a_timestamp(tg, db, clock, tmp_path):
    ev = FakeEvent(tg.client, data=b'abc', name=None, mime_type='application/octet-stream')
    run(download(tg, ev))
    assert (tmp_path / 'downloads' / 'Documents' / '20240102_030405').exists()


def test_author_falls_back_to_first_name_post_author_or_nothing(tg, db):
    ev = FakeEvent(tg.client, data=b'a', sender=SimpleNamespace(id=9, username=None, first_name='Bob'))
    run(download(tg, ev))
    assert row(db, ev)['author'] == 'Bob:9'
    ev = FakeEvent(tg.client, data=b'a', sender=SimpleNamespace(id=9, username=None, first_name=None))
    run(download(tg, ev))
    assert row(db, ev)['author'] == '9'
    ev = FakeEvent(tg.client, data=b'a', sender=None, post_author='Editor')
    run(download(tg, ev))
    assert row(db, ev)['author'] == 'Editor'
    ev = FakeEvent(tg.client, data=b'a')
    ev.sender_error = RuntimeError('privacy')
    run(download(tg, ev))
    assert row(db, ev)['author'] is None


def test_messages_without_a_file_are_ignored(tg, db):
    ev = FakeEvent(tg.client, text='just chatting')
    run(download(tg, ev))
    assert db.get_all_downloads() == [] and ev.replies == []


def test_a_full_queue_parks_the_download_and_replies_with_its_place(tg, db, sio):
    dq.set_limits({'global': 1})
    db.add_download(file='busy.mkv', status='downloading', message_id=1, queue_position=0)
    ev = FakeEvent(tg.client, data=b'abc', name='next.mp4')
    run(download(tg, ev))
    rec = row(db, ev)
    assert rec['status'] == 'waiting' and rec['queue_position'] == 1
    assert ev.id not in tg.download_tasks and rec['downloaded_bytes'] == 0
    assert ev.replies[0].text == '⏳ Status: Waiting (#2 in queue)'
    assert rec['status_msg_id'] == ev.replies[0].id            # the restart edits this reply later
    assert sio.of('download:new')[0]['status'] == 'waiting'
    assert sio.of('queue:changed')                      # open pages refetch the queue
    assert tg.meta_polls == []


def test_a_failed_queue_reply_still_leaves_the_download_waiting(tg, db):
    dq.set_limits({'global': 1})
    db.add_download(file='busy.mkv', status='downloading', message_id=1, queue_position=0)
    ev = FakeEvent(tg.client, data=b'abc', name='next.mp4')
    ev.reply_error = RuntimeError('flood wait')
    run(download(tg, ev))
    assert row(db, ev)['status'] == 'waiting' and row(db, ev)['status_msg_id'] is None


def test_a_failed_status_reply_does_not_stop_the_download(tg, db):
    ev = FakeEvent(tg.client, data=b'abc', name='a.mp4')
    ev.reply_error = RuntimeError('flood wait')
    run(download(tg, ev))
    assert row(db, ev)['status'] == 'done' and row(db, ev)['status_msg_id'] is None


def test_progress_is_reported_once_a_second_with_speed_and_eta(tg, db, sio, clock):
    clock.step = 1
    tg.client.chunk_size = 2048
    ev = FakeEvent(tg.client, data=b'x' * 8192, name='big.mp4')
    run(download(tg, ev))
    progress = sio.of('download:progress')
    assert [p['progress'] for p in progress] == [25.0, 50.0, 75.0, 100.0]
    assert progress[0]['speed'] == 2.0                               # 2048 B over 1 s
    assert progress[0]['pending_time'] == pytest.approx(3.0)         # 6144 B left at 2 KB/s
    assert progress[-1]['pending_time'] == 0
    assert row(db, ev)['status'] == 'done'


def test_a_transient_error_is_retried_with_backoff_from_the_partial_file(tg, db, sio, fast_sleep):
    data = b'0123456789abcdef'
    tg.client.chunk_failures = [RuntimeError('net down'), (2, RuntimeError('dropped')), None]
    ev = FakeEvent(tg.client, data=data, name='r.mp4')
    run(download(tg, ev))
    assert fast_sleep == [5, 10]
    assert tg.client.download_calls == [0, 0, 8]        # third attempt resumes past the 8 bytes on disk
    assert row(db, ev)['status'] == 'done'
    path = th.DOWNLOAD_DIR / 'Videos' / 'r.mp4'
    assert path.read_bytes() == data
    assert row(db, ev)['error'] == 'Attempt 2/3 failed: dropped'
    assert sio.of('download:status') == [{'message_id': str(ev.id), 'status': 'done'}]


def test_max_retries_marks_the_download_failed(tg, db, sio, fast_sleep, monkeypatch):
    monkeypatch.setattr(th, 'MAX_RETRIES', 7)
    tg.client.chunk_failures = [RuntimeError(f'fail {i}') for i in range(7)]
    ev = FakeEvent(tg.client, data=b'abc', name='f.mp4')
    run(download(tg, ev))
    assert fast_sleep == [5, 10, 20, 40, 60, 60, 60]                 # doubled, capped at 60s
    rec = row(db, ev)
    assert rec['status'] == 'failed' and rec['error'] == 'Attempt 7/7 failed: fail 6'
    assert rec['speed'] == 0 and rec['pending_time'] is None
    assert sio.of('download:status') == [{'message_id': str(ev.id), 'status': 'failed'}]
    assert '❌ Status: Failed' in ev.replies[0].edits
    assert ev.id not in tg.download_tasks


def test_pause_cancels_the_task_and_leaves_the_status_to_the_api(tg, db, sio):
    async def go():
        tg.client.chunk_gate = asyncio.Event()
        ev = FakeEvent(tg.client, data=b'x' * 8, name='p.mp4')
        await tg._handle_new_file(ev)
        task = tg.download_tasks[ev.id]
        await settle()
        assert not task.done()
        tg.pause_download(ev.id)                 # what /api/pause does after writing 'paused'
        db.update_download_by_message_id(ev.id, status='paused')
        await asyncio.wait({task})
        assert task.cancelled() is False         # CancelledError is absorbed inside safe_download
        assert ev.id not in tg.download_tasks
        assert row(db, ev)['status'] == 'paused'
        assert sio.of('download:status') == []
        tg.pause_download(ev.id)                 # nothing running: no-op
    run(go())


def test_resume_leaves_a_running_download_alone_unless_forced(tg, db):
    async def go():
        tg.client.chunk_gate = asyncio.Event()
        ev = FakeEvent(tg.client, data=b'0123456789', name='v.mp4')
        await tg._handle_new_file(ev)
        first = tg.download_tasks[ev.id]
        await settle()
        assert await tg.resume_download(ev.id) is True
        assert tg.download_tasks[ev.id] is first         # untouched

        tg.client.chunk_gate = None
        assert await tg.resume_download(ev.id, force=True) is True
        assert first.done()                               # the old task exited before the new one started
        second = tg.download_tasks[ev.id]
        assert second is not first
        await second
        await settle()
        assert row(db, ev)['status'] == 'done'
        assert (th.DOWNLOAD_DIR / 'Videos' / 'v.mp4').read_bytes() == b'0123456789'
        # The restart edits the original status message rather than posting a new one
        assert '⬇️ Status: Downloading' in ev.replies[0].edits and len(ev.replies) == 1
    run(go())


def test_restart_resumes_from_the_bytes_on_disk(tg, db, tmp_path):
    folder = th.DOWNLOAD_DIR / 'Videos'
    folder.mkdir(parents=True)
    (folder / 'part.mp4').write_bytes(b'01234')
    ev = FakeEvent(tg.client, data=b'0123456789', name='part.mp4')
    db.add_download(file='part.mp4', status='stopped', message_id=ev.id, chat_id=CHAT, total_bytes=10)

    async def go():
        assert await tg.restart_download(ev.id) is True
        await tg.download_tasks[ev.id]
        await settle()
    run(go())
    assert tg.client.download_calls == [5]
    assert (folder / 'part.mp4').read_bytes() == b'0123456789'
    assert row(db, ev)['status'] == 'done'


def test_restart_refuses_when_there_is_nothing_to_restart(tg, db):
    assert run(tg.restart_download(404)) is False                     # no record
    ev = FakeEvent(tg.client, data=b'abc')
    db.add_download(file='x.mp4', status='failed', message_id=ev.id, chat_id=CHAT)
    tg.client.get_messages_error = RuntimeError('offline')
    assert run(tg.restart_download(ev.id)) is False                   # can't fetch the message
    tg.client.get_messages_error = None
    ev.file = None
    assert run(tg.restart_download(ev.id)) is False                   # message lost its attachment
    ev.file = FakeFile('x.mp4', 'video/mp4', 3)
    db.update_download_by_message_id(ev.id, file='')
    assert run(tg.restart_download(ev.id)) is False                   # no filename stored
    assert run(tg.resume_download(404)) is False                      # resume of nothing restarts nothing


def test_post_restart_meta_fills_in_what_is_missing(tg, db, monkeypatch):
    calls = []

    async def extract(message_id):
        calls.append(('meta', message_id))
        db.update_download_by_message_id(message_id, file_meta=json.dumps({'duration': 12.5}))
        return True

    async def thumbs(download_id, file_path, duration):
        calls.append(('thumbs', download_id, file_path, duration))
        return 4
    monkeypatch.setattr('backend.file_meta.extract_and_store_meta', extract)
    monkeypatch.setattr('backend.file_meta.generate_thumbnails', thumbs)
    monkeypatch.setattr('backend.file_meta.find_file', lambda name, source=None: f'/media/{name}')
    rec = db.add_download(file='v.mp4', status='done', message_id=21)

    async def finished():
        return None

    async def failing():
        raise RuntimeError('download died')

    async def go():
        await tg._post_restart_meta(21, asyncio.create_task(finished()))
        await tg._post_restart_meta(21, asyncio.create_task(failing()))       # swallowed, nothing done
        db.update_download_by_message_id(21, status='stopped')
        await tg._post_restart_meta(21, asyncio.create_task(finished()))      # not done: nothing
        await tg._post_restart_meta(404, asyncio.create_task(finished()))     # unknown: nothing
    run(go())
    assert calls == [('meta', '21'), ('thumbs', rec['id'], '/media/v.mp4', 12.5)]

    # A record deleted while metadata was being probed gets no thumbnails
    async def extract_then_delete(message_id):
        calls.append(('meta', message_id))
        db.delete_download_by_message_id(message_id)
        return True
    monkeypatch.setattr('backend.file_meta.extract_and_store_meta', extract_then_delete)
    db.add_download(file='w.mp4', status='done', message_id=23)

    async def again():
        await tg._post_restart_meta(23, asyncio.create_task(finished()))
    run(again())
    assert calls[-1] == ('meta', '23')


def test_post_restart_meta_skips_thumbnails_without_a_duration(tg, db, monkeypatch):
    calls = []

    async def thumbs(*a):
        calls.append(a)
    monkeypatch.setattr('backend.file_meta.generate_thumbnails', thumbs)
    db.add_download(file='v.mp4', status='done', message_id=22)
    db.update_download_by_message_id(22, file_meta=json.dumps({'codec': 'h264'}))

    async def finished():
        return None

    async def go():
        await tg._post_restart_meta(22, asyncio.create_task(finished()))
    run(go())
    assert calls == []


def test_restart_schedules_meta_extraction_for_videos(tg, db, monkeypatch):
    seen = []

    async def fake_post(message_id, task):
        seen.append(message_id)
        await task
    monkeypatch.setattr(tg, '_post_restart_meta', fake_post)
    ev = FakeEvent(tg.client, data=b'abc', name='v.mkv')
    db.add_download(file='v.mkv', status='stopped', message_id=ev.id, chat_id=CHAT)

    async def go():
        await tg.restart_download(ev.id)
        await tg.download_tasks[ev.id]
        await settle()
    run(go())
    assert seen == [ev.id]


# ---------------------------------------------------------------------------
# Run loop
# ---------------------------------------------------------------------------

def test_run_connects_authorizes_and_exits_on_stop(tg):
    tg.client.connected = False

    async def until_disconnected():
        tg._stopping = True
    tg.client.run_until_disconnected = until_disconnected
    run(tg._run())
    assert tg.client.connected and tg.authorized is False            # reset once the loop ends
    assert len(tg.client.sent) == 1                                  # greeted on authorization


def test_run_waits_for_credentials_and_survives_client_errors(tg, fast_sleep):
    tg.client = None

    async def stop_on_sleep(seconds):
        fast_sleep.append(seconds)
        tg._stopping = True
    th.asyncio.sleep = stop_on_sleep
    run(tg._run())
    assert fast_sleep == [2]

    tg._stopping = False
    tg.client = FakeTelegramClient()
    tg.client.connected = False
    tg.client.authorized = False
    fast_sleep.clear()
    run(tg._run())                      # unauthorized: waits for a web login, no greeting
    assert tg.client.sent == [] and fast_sleep == [2]

    tg._stopping = False
    tg.client.authorized_error = RuntimeError('network unreachable')
    fast_sleep.clear()
    run(tg._run())                      # logged, backs off, loops
    assert fast_sleep == [2]


def test_start_and_stop(tg):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        tg._stopping = True
        tg.start()
        assert tg.loop is loop
    finally:
        asyncio.set_event_loop(None)
        loop.close()
    # With no current loop (set_event_loop(None) was called) it makes its own
    tg.start()
    try:
        assert tg.loop is not loop and not tg.loop.is_closed()
    finally:
        tg.loop.close()
        asyncio.set_event_loop(None)
    tg.stop()
    assert tg.client.disconnected == 1

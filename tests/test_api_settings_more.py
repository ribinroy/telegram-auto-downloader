"""The settings routes test_api_settings.py leaves alone: yt-dlp cookies,
the Telegram account/channel routes (unwired, and against a stub client on
a real event loop), user roles and the bot's query snippets."""
import asyncio
import threading

import pytest

from backend.web_app.routes import settings as settings_routes


# --- cookies ---------------------------------------------------------------------

@pytest.fixture
def cookies_file(tmp_path, monkeypatch):
    """The deployment's real cookies.txt sits at the project root; the
    tests write to a temp copy of that path."""
    path = tmp_path / 'cookies.txt'
    monkeypatch.setattr(settings_routes, 'COOKIES_FILE', path)
    return path


def test_the_settings_page_and_ytdlp_agree_on_where_cookies_live():
    """Saved from the UI, read by yt-dlp: one file, or the save is useless."""
    from backend.ytdlp_handler import YtdlpDownloader
    assert str(settings_routes.COOKIES_FILE) == YtdlpDownloader.COOKIES_FILE


def test_cookies_start_empty(client, db, auth, cookies_file):
    assert client.get('/api/settings/cookies', headers=auth).get_json() == {'cookies': ''}


def test_saving_cookies_adds_the_netscape_header_and_reads_back(client, db, auth, cookies_file):
    pasted = '\r\n\r\n.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc\r\n'
    res = client.post('/api/settings/cookies', headers=auth, json={'cookies': pasted})
    assert res.get_json() == {'status': 'saved'}
    text = cookies_file.read_text()
    assert text.startswith('# Netscape HTTP Cookie File\n.example.com\tTRUE')
    assert '\r' not in text and text.endswith('\n')
    assert client.get('/api/settings/cookies', headers=auth).get_json() == {'cookies': text}


@pytest.mark.parametrize('header', ['# Netscape HTTP Cookie File', '# HTTP Cookie File'])
def test_an_existing_header_is_kept_once(header):
    out = settings_routes._normalize_netscape_cookies(f'{header}\n.a\tTRUE\t/\tFALSE\t0\tk\tv')
    assert out.count('Cookie File') == 1 and out.startswith(header)


def test_saving_blank_cookies_removes_the_file(client, db, auth, cookies_file):
    cookies_file.write_text('# Netscape HTTP Cookie File\n')
    assert client.post('/api/settings/cookies', headers=auth,
                       json={'cookies': '  \n'}).status_code == 200
    assert not cookies_file.exists()
    # ...and removing what isn't there is fine too
    assert client.post('/api/settings/cookies', headers=auth, json={}).status_code == 200


def test_a_failed_cookie_write_is_a_500(client, db, auth, cookies_file):
    cookies_file.mkdir()                        # write_text onto a directory fails
    res = client.post('/api/settings/cookies', headers=auth, json={'cookies': 'x=y'})
    assert res.status_code == 500 and res.get_json()['error']


# --- Telegram, unwired ---------------------------------------------------------------

def test_telegram_api_config_reports_unconfigured_without_a_client(client, db, auth):
    body = client.get('/api/settings/telegram/api', headers=auth).get_json()
    assert body == {'configured': False, 'api_id': None, 'has_hash': False, 'source': None}


@pytest.mark.parametrize('body,error', [
    ({}, 'API ID is required'),
    ({'api_id': 'abc'}, 'must be a number'),
    ({'api_id': 0}, 'API ID is required'),
])
def test_saving_api_credentials_validates_the_id(client, db, auth, body, error):
    res = client.post('/api/settings/telegram/api', headers=auth, json=body)
    assert res.status_code == 400 and error in res.get_json()['error']


def test_telegram_status_without_a_client_is_an_honest_disconnected(client, db, auth):
    body = client.get('/api/settings/telegram/status', headers=auth).get_json()
    assert body['connected'] is False and body['authorized'] is False
    assert body['channels'] == [] and body['error']


@pytest.mark.parametrize('path,body,missing', [
    ('/api/settings/telegram/api', {'api_id': 1, 'api_hash': 'h'}, None),
    ('/api/settings/telegram/send-code', {}, 'Phone number is required'),
    ('/api/settings/telegram/send-code', {'phone': '+100'}, None),
    ('/api/settings/telegram/verify-code', {}, 'Code is required'),
    ('/api/settings/telegram/verify-code', {'code': '12 345'}, None),
    ('/api/settings/telegram/verify-password', {}, 'Password is required'),
    ('/api/settings/telegram/verify-password', {'password': 'x'}, None),
    ('/api/settings/telegram/bot-login', {}, 'Bot token is required'),
    ('/api/settings/telegram/bot-login', {'token': 't'}, None),
    ('/api/settings/telegram/logout', {}, None),
    ('/api/settings/telegram/channels', {}, 'required'),
    ('/api/settings/telegram/channels', {'chat': '@chan'}, None),
    ('/api/users/sync', {}, None),
])
def test_telegram_posts_fail_cleanly_without_a_client(client, db, auth, path, body, missing):
    res = client.post(path, headers=auth, json=body)
    assert res.status_code == 400
    assert (missing or 'not running') in res.get_json()['error'] or missing is None


def test_telegram_gets_without_a_client(client, db, auth):
    assert client.get('/api/settings/telegram/channels', headers=auth).get_json() == {'channels': []}
    assert client.get('/api/settings/telegram/dialogs', headers=auth).status_code == 400
    assert client.get('/api/settings/queries', headers=auth).get_json() == {'queries': []}


def test_channel_ids_must_be_integers(client, db, auth):
    assert client.delete('/api/settings/telegram/channels/abc', headers=auth).status_code == 400
    assert client.patch('/api/settings/telegram/channels/abc', headers=auth, json={}).status_code == 400
    # A negative id (every Telegram channel) is routed, and refused for the
    # right reason when nothing is wired up
    res = client.patch('/api/settings/telegram/channels/-100123', headers=auth,
                       json={'torrent_client': 'qbittorrent'})
    assert res.status_code == 400 and 'not configured' in res.get_json()['error']
    assert client.delete('/api/settings/telegram/channels/-100123', headers=auth).status_code == 400


# --- Telegram, against a stub client --------------------------------------------------

class FakeTelegram:
    """Just enough of TelegramDownloader for the routes: coroutines that run
    on a real loop in a daemon thread, the way _telegram_call needs."""

    def __init__(self, loop):
        self.loop = loop
        self.calls = []
        self.channels = [{'id': -100, 'title': 'Chan'}]
        self.fail = None                        # name of the method that answers {'error'}

    def _answer(self, name, ok):
        self.calls.append(name)
        return {'error': f'{name} refused'} if self.fail == name else ok

    def get_api_config(self):
        return {'configured': True, 'api_id': 1, 'has_hash': True, 'source': 'database'}

    async def set_api_credentials(self, api_id, api_hash):
        self.calls.append(('creds', api_id, api_hash))
        return self._answer('creds', {'status': 'saved', **self.get_api_config()})

    async def get_status(self):
        return {'connected': True, 'authorized': True, 'awaiting_code': False, 'user': 'me'}

    def get_channels(self):
        return list(self.channels)

    async def send_login_code(self, phone):
        return self._answer('send', {'status': 'code_sent', 'phone': phone})

    async def submit_login_code(self, code):
        return self._answer('code', {'status': 'authorized', 'code': code})

    async def submit_password(self, password):
        return self._answer('password', {'status': 'authorized'})

    async def submit_bot_token(self, token):
        return self._answer('bot', {'status': 'authorized', 'token': token})

    async def logout(self):
        return self._answer('logout', {'status': 'logged_out'})

    async def add_channel(self, identifier):
        return self._answer('add', {'channels': self.channels + [{'id': -200, 'title': identifier}]})

    async def remove_channel(self, chat_id):
        return self._answer('remove', {'channels': [], 'removed': chat_id})

    def set_channel_torrent_client(self, chat_id, client):
        self.calls.append(('route', chat_id, client))
        if chat_id != -100:
            return {'error': 'Channel is not monitored'}
        return {'channels': self.channels}

    async def list_dialogs(self):
        return [{'id': -100, 'title': 'Chan'}]

    async def sync_channel_members(self):
        return 3

    def get_queries(self):
        return [{'key': 'uptime', 'command': 'uptime'}]


@pytest.fixture
def telegram(app):
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    fake = FakeTelegram(loop)
    app.telegram_downloader = fake
    yield fake
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


def test_api_credentials_are_saved_through_the_client(client, db, auth, telegram):
    res = client.post('/api/settings/telegram/api', headers=auth, json={'api_id': '42', 'api_hash': ' h '})
    assert res.status_code == 200 and res.get_json()['status'] == 'saved'
    assert telegram.calls[0] == ('creds', 42, 'h')
    assert client.get('/api/settings/telegram/api', headers=auth).get_json()['configured'] is True
    telegram.fail = 'creds'
    assert client.post('/api/settings/telegram/api', headers=auth, json={'api_id': 42}).status_code == 400


def test_status_carries_the_channels(client, db, auth, telegram):
    body = client.get('/api/settings/telegram/status', headers=auth).get_json()
    assert body['authorized'] is True and body['channels'] == [{'id': -100, 'title': 'Chan'}]
    assert client.get('/api/settings/telegram/channels', headers=auth).get_json() == \
        {'channels': [{'id': -100, 'title': 'Chan'}]}
    assert client.get('/api/settings/telegram/dialogs', headers=auth).get_json() == \
        {'dialogs': [{'id': -100, 'title': 'Chan'}]}


def test_the_login_steps(client, db, auth, telegram):
    assert client.post('/api/settings/telegram/send-code', headers=auth,
                       json={'phone': ' +1 555 '}).get_json() == {'status': 'code_sent', 'phone': '+1 555'}
    # Spaces people type between digit groups are dropped
    assert client.post('/api/settings/telegram/verify-code', headers=auth,
                       json={'code': '12 34 5'}).get_json()['code'] == '12345'
    assert client.post('/api/settings/telegram/verify-password', headers=auth,
                       json={'password': 'pw'}).get_json() == {'status': 'authorized'}
    assert client.post('/api/settings/telegram/bot-login', headers=auth,
                       json={'token': ' 1:abc '}).get_json()['token'] == '1:abc'
    assert client.post('/api/settings/telegram/logout', headers=auth).get_json() == {'status': 'logged_out'}


@pytest.mark.parametrize('step,path,body', [
    ('code', '/api/settings/telegram/verify-code', {'code': '1'}),
    ('bot', '/api/settings/telegram/bot-login', {'token': 't'}),
    ('add', '/api/settings/telegram/channels', {'chat': 'x'}),
])
def test_a_refusal_from_the_client_is_a_400(client, db, auth, telegram, step, path, body):
    telegram.fail = step
    res = client.post(path, headers=auth, json=body)
    assert res.status_code == 400 and 'refused' in res.get_json()['error']


def test_a_client_exception_is_a_400_with_the_message(client, db, auth, telegram):
    async def exploding(phone):
        raise RuntimeError('flood wait')
    telegram.send_login_code = exploding
    res = client.post('/api/settings/telegram/send-code', headers=auth, json={'phone': '+1'})
    assert res.status_code == 400 and res.get_json()['error'] == 'flood wait'


def test_channels_are_added_removed_and_routed(client, db, auth, telegram):
    res = client.post('/api/settings/telegram/channels', headers=auth, json={'chat': ' @new '})
    assert [c['title'] for c in res.get_json()['channels']] == ['Chan', '@new']
    assert client.delete('/api/settings/telegram/channels/-100', headers=auth).get_json()['removed'] == -100

    res = client.patch('/api/settings/telegram/channels/-100', headers=auth,
                       json={'torrent_client': 'qbittorrent'})
    assert res.status_code == 200 and telegram.calls[-1] == ('route', -100, 'qbittorrent')
    res = client.patch('/api/settings/telegram/channels/-999', headers=auth, json={})
    assert res.status_code == 400 and 'not monitored' in res.get_json()['error']


# --- users ------------------------------------------------------------------------------

def test_users_are_listed_and_roles_changed(client, db, auth, telegram):
    tg = db.upsert_telegram_user(5551, username='bob', display_name='Bob')
    users = client.get('/api/users', headers=auth).get_json()['users']
    assert {u['username'] for u in users} == {'admin', 'bob'}

    res = client.patch(f"/api/users/{tg['id']}", headers=auth, json={'role': ' Admin '})
    assert res.status_code == 200 and res.get_json()['user']['role'] == 'admin'
    assert db.get_telegram_user_role(5551) == 'admin'
    assert client.patch(f"/api/users/{tg['id']}", headers=auth, json={'role': 'user'}).status_code == 200

    synced = client.post('/api/users/sync', headers=auth).get_json()
    assert synced['synced'] == 3 and len(synced['users']) == 2


def test_role_changes_are_validated(client, db, auth):
    admin = db.get_user_by_username('admin').id
    assert client.patch(f'/api/users/{admin}', headers=auth, json={'role': 'owner'}).status_code == 400
    assert client.patch(f'/api/users/{admin}', headers=auth, json={}).status_code == 400
    assert client.patch('/api/users/99999', headers=auth, json={'role': 'user'}).status_code == 404
    # A web-login account can't be demoted - it holds the only password
    res = client.patch(f'/api/users/{admin}', headers=auth, json={'role': 'user'})
    assert res.status_code == 400 and 'always admins' in res.get_json()['error']
    assert client.patch(f'/api/users/{admin}', headers=auth, json={'role': 'admin'}).status_code == 200


# --- bot queries ------------------------------------------------------------------------

def test_queries_come_from_the_client_when_wired(client, db, auth, telegram):
    assert client.get('/api/settings/queries', headers=auth).get_json() == \
        {'queries': [{'key': 'uptime', 'command': 'uptime'}]}


@pytest.mark.parametrize('body,error', [
    ({'key': 'disk'}, 'required'),
    ({'command': 'df'}, 'required'),
    ({'key': 'disk space', 'command': 'df'}, 'single word'),
    ({'key': 'k' * 65, 'command': 'df'}, 'single word'),
    ({'key': 'HELP', 'command': 'ls'}, 'reserved'),
])
def test_saving_a_query_is_validated(client, db, auth, body, error):
    res = client.post('/api/settings/queries', headers=auth, json=body)
    assert res.status_code == 400 and error in res.get_json()['error']


def test_queries_are_upserted_renamed_and_deleted(client, db, auth):
    from backend.database import BotQuery
    res = client.post('/api/settings/queries', headers=auth, json={'key': ' Disk ', 'command': ' df -h '})
    assert [(q['key'], q['command']) for q in res.get_json()['queries']] == [('disk', 'df -h')]
    client.post('/api/settings/queries', headers=auth, json={'key': 'space', 'command': 'du'})
    # Renaming disk onto the live key "space" replaces it (soft-deleting the old space)
    res = client.post('/api/settings/queries', headers=auth,
                      json={'key': 'space', 'command': 'df /', 'original_key': 'disk'})
    assert [(q['key'], q['command']) for q in res.get_json()['queries']] == [('space', 'df /')]
    session = db.get_session()
    try:
        rows = session.query(BotQuery).order_by(BotQuery.id).all()
        assert [(r.key, r.deleted_at is None) for r in rows] == [('space', True), ('space', False)]
    finally:
        db.close_session()
    assert client.delete('/api/settings/queries/space', headers=auth).get_json() == {'queries': []}
    assert client.delete('/api/settings/queries/space', headers=auth).status_code == 200   # idempotent


def test_a_query_can_be_tried_from_the_settings_page(client, db, auth):
    res = client.post('/api/settings/queries/test', headers=auth,
                      json={'command': 'echo "hi $SENDER_USERNAME"'})
    assert res.status_code == 200 and res.get_json()['output'] == 'hi admin'
    assert client.post('/api/settings/queries/test', headers=auth, json={}).status_code == 400

"""The data layer on its own: migrating a legacy schema (and doing nothing
the second time), the live-rows-only unique indexes, refresh sessions,
Telegram users, password hash upgrades and the queue bookkeeping that the
route tests only touch indirectly."""
import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

import backend.database as database
from backend.database import DatabaseManager, User


# --- migrations ---------------------------------------------------------------------------

LEGACY_DOWNLOADS = """
CREATE TABLE downloads (
    id INTEGER PRIMARY KEY, message_id VARCHAR(100), file VARCHAR(500) NOT NULL,
    status VARCHAR(50), progress FLOAT, speed FLOAT, error TEXT,
    updated_at TIMESTAMP, created_at TIMESTAMP, downloaded_bytes BIGINT,
    total_bytes BIGINT, pending_time FLOAT, downloaded_from VARCHAR(100), url TEXT,
    is_deleted BOOLEAN DEFAULT 0, paused_files TEXT)
"""
LEGACY_USERS = """
CREATE TABLE users (
    id INTEGER PRIMARY KEY, username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(64), role VARCHAR(20), created_at TIMESTAMP)
"""


@pytest.fixture
def legacy_url(tmp_path):
    """A database as an old release left it: no soft-delete timestamps, the
    paused-files list, labels, bot queries in a settings blob."""
    url = f'sqlite:///{tmp_path / "legacy.db"}'
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text(LEGACY_DOWNLOADS))
        conn.execute(text(
            "INSERT INTO downloads (message_id, file, status, is_deleted, paused_files) VALUES "
            "('old-1', 'a.mkv', 'done', 1, '[\"ep1.mkv\", \"ep2.mkv\"]'), "
            "('old-2', 'b.mkv', 'done', 0, NULL), "
            "('old-3', 'c.mkv', 'done', 0, 'not json'), "
            "('old-4', 'd.mkv', 'done', 0, '[]')"))
        conn.execute(text(LEGACY_USERS))
        conn.execute(text("INSERT INTO users (username, password_hash, role) VALUES (:u, :h, 'admin')"),
                     {'u': 'admin', 'h': User.legacy_sha256('admin')})
        conn.execute(text("INSERT INTO users (username, password_hash, role) VALUES (:u, :h, 'admin')"),
                     {'u': 'other', 'h': User.legacy_sha256('something-else')})
        conn.execute(text(
            'CREATE TABLE vps_watch_folders (id INTEGER PRIMARY KEY, path VARCHAR(500) UNIQUE, '
            'created_at TIMESTAMP)'))
        conn.execute(text("INSERT INTO vps_watch_folders (path) VALUES ('/old/watch')"))
        conn.execute(text(
            'CREATE TABLE download_type_maps (id INTEGER PRIMARY KEY, downloaded_from VARCHAR(100) UNIQUE, '
            'is_secured BOOLEAN, folder VARCHAR(255), quality VARCHAR(50), created_at TIMESTAMP, '
            'updated_at TIMESTAMP)'))
        conn.execute(text("INSERT INTO download_type_maps (downloaded_from, folder) VALUES ('youtube.com', '/before')"))
        conn.execute(text(
            'CREATE TABLE settings (id INTEGER PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL, '
            'value TEXT, updated_at TIMESTAMP)'))
        conn.execute(text("INSERT INTO settings (key, value) VALUES ('bot_queries', :v)"),
                     {'v': json.dumps([{'key': ' Uptime ', 'command': 'uptime'}, {'key': '', 'command': 'x'}])})
        conn.execute(text(
            'CREATE TABLE labels (id INTEGER PRIMARY KEY, folder VARCHAR(255), quality VARCHAR(50), '
            'is_hidden BOOLEAN)'))
        conn.execute(text(
            'CREATE TABLE source_labels (id INTEGER PRIMARY KEY, source VARCHAR(100), path VARCHAR(500), '
            'label_id INTEGER)'))
        conn.execute(text("INSERT INTO labels (folder, quality, is_hidden) VALUES ('/mnt/yt', '1080p', 1), "
                          "('/mnt/private', NULL, 1)"))
        conn.execute(text("INSERT INTO source_labels (source, path, label_id) VALUES "
                          "('youtube.com', NULL, 1), ('vimeo.com', NULL, 2), ('vps', '/old/watch', 2)"))
    engine.dispose()
    return url


def columns(url, table):
    return {c['name'] for c in inspect(create_engine(url)).get_columns(table)}


def test_a_legacy_schema_is_brought_up_to_date(legacy_url):
    db = DatabaseManager(legacy_url)

    cols = columns(legacy_url, 'downloads')
    assert 'is_deleted' not in cols and 'deleted_at' in cols
    assert {'file_deleted', 'author', 'file_meta', 'thumb_count', 'status_msg_id', 'chat_id',
            'dest_base', 'queue_position', 'format_id', 'vr_projection', 'file_count',
            'file_status'} <= cols
    rows = {d['message_id']: d for d in db.get_all_downloads(include_deleted=True)}
    assert rows['old-1']['deleted_at'] and rows['old-2']['deleted_at'] is None
    assert rows['old-1']['file_status'] == {'ep1.mkv': 'paused', 'ep2.mkv': 'paused'}
    assert rows['old-3']['file_status'] == {} and rows['old-4']['file_status'] == {}
    assert [d['message_id'] for d in db.get_all_downloads()] != []   # the live rows still list

    # Users: the still-default admin password must be changed; others not
    assert {'telegram_id', 'display_name', 'must_change_password', 'token_version'} <= columns(legacy_url, 'users')
    admin = db.get_user_by_username('admin')
    assert db.user_must_change_password(admin.id) is True
    assert db.user_must_change_password(db.get_user_by_username('other').id) is False
    assert db.get_auth_state(admin.id)['token_version'] == 0

    # Watched folders grew their spec/connection columns
    assert {'auto_sync', 'host', 'port', 'username', 'folder', 'is_secured', 'deleted_at'} <= \
        columns(legacy_url, 'vps_watch_folders')

    # Labels folded back into specs: an existing mapping updated, a new one created,
    # the watched folder given the per-folder spec
    yt = db.get_download_type_map('youtube.com')
    assert (yt['folder'], yt['quality'], yt['is_secured']) == ('/mnt/yt', '1080p', True)
    vimeo = db.get_download_type_map('vimeo.com')
    assert (vimeo['folder'], vimeo['is_secured']) == ('/mnt/private', True)
    watch = db.get_vps_watch_folder_for_path('/old/watch/x.mkv')
    assert (watch['folder'], watch['is_secured']) == ('/mnt/private', True)
    assert db.get_setting('labels_to_specs_migrated') == '1'

    # Bot queries moved from the settings blob into their table
    assert [(q['key'], q['command']) for q in db.get_bot_queries()] == [('uptime', 'uptime')]
    assert db.get_setting('bot_queries') is None
    assert db.get_setting('bot_queries_seeded') == '1'

    # The live-rows unique indexes exist
    indexes = {i['name'] for i in inspect(db.engine).get_indexes('download_type_maps')}
    assert 'uq_download_type_maps_live' in indexes


def test_migrations_are_idempotent(legacy_url):
    DatabaseManager(legacy_url)
    again = DatabaseManager(legacy_url)              # nothing to do, nothing breaks
    assert len(again.get_all_downloads(include_deleted=True)) == 4
    assert [q['key'] for q in again.get_bot_queries()] == ['uptime']
    # Re-running the label migration does not undo a later edit
    yt = again.get_download_type_map('youtube.com')
    again.update_download_type_map(yt['id'], folder='/edited')
    DatabaseManager(legacy_url)
    assert again.get_download_type_map('youtube.com')['folder'] == '/edited'


def test_a_fresh_database_is_created_whole(tmp_path):
    url = f'sqlite:///{tmp_path / "fresh.db"}'
    db = DatabaseManager(url)
    assert 'deleted_at' in columns(url, 'downloads')
    assert db.get_bot_queries() == [] and db.get_all_downloads() == []
    # init_database wires the global and seeds the admin
    manager = database.init_database(f'sqlite:///{tmp_path / "global.db"}')
    try:
        assert database.get_db() is manager
        assert manager.get_user_by_username('admin') is not None
    finally:
        database.db_manager = None


# --- live-rows-only uniqueness ----------------------------------------------------------------

def test_two_live_mappings_for_one_source_are_impossible_at_the_index(db):
    from backend.database import DownloadTypeMap
    db.add_download_type_map('a.com')
    session = db.get_session()
    try:
        session.add(DownloadTypeMap(downloaded_from='a.com'))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
    finally:
        db.close_session()
    # ...while a soft-deleted twin is fine
    row = db.get_download_type_map('a.com')
    assert db.delete_download_type_map(row['id']) is True
    assert db.delete_download_type_map(row['id']) is False
    assert 'error' not in db.add_download_type_map('a.com')
    assert db.update_download_type_map(row['id'], folder='/x') == {'error': 'Mapping not found'}
    assert db.get_secured_mapping_ids() == []
    db.update_download_type_map(db.get_download_type_map('a.com')['id'], is_secured=True)
    assert len(db.get_secured_mapping_ids()) == 1


def test_two_live_bot_queries_for_one_key_are_impossible_at_the_index(db):
    from backend.database import BotQuery
    db.upsert_bot_query('k', 'a')
    session = db.get_session()
    try:
        session.add(BotQuery(key='k', command='b'))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
    finally:
        db.close_session()
    assert db.delete_bot_query('K') is True and db.delete_bot_query('k') is False
    assert db.upsert_bot_query('k', 'c')['command'] == 'c'
    # A rename from a key that doesn't exist falls back to upserting the new key
    assert db.upsert_bot_query('k', 'd', original_key='ghost')['command'] == 'd'
    assert [q['command'] for q in db.get_bot_queries()] == ['d']


# --- downloads ---------------------------------------------------------------------------------

def test_lookups_and_updates_by_file_and_by_chat(db):
    db.add_download(file='a.mkv', status='downloading', message_id='7', chat_id=-100)
    db.add_download(file='b.mkv', status='downloading', message_id='7', chat_id=-200)
    assert db.get_download('a.mkv')['chat_id'] == '-100'
    assert db.get_download('zzz') is None
    assert db.get_download_by_message_id('7', chat_id=-100)['file'] == 'a.mkv'
    assert db.get_download_by_message_id('7')['file'] == 'b.mkv'          # newest wins without a chat
    assert db.update_download_by_message_id('7', chat_id=-100, progress=50)['file'] == 'a.mkv'
    assert db.get_download('a.mkv')['progress'] == 50
    assert db.update_download('a.mkv', speed=9)['speed'] == 9
    assert db.update_download('zzz', speed=9) is None
    assert db.update_download_by_id(99999, speed=1) is None
    assert db.update_download_by_message_id('nope', speed=1) is None


def test_soft_deletes_by_every_handle(db):
    a = db.add_download(file='a.mkv', status='done', message_id='x-1')
    b = db.add_download(file='b.mkv', status='done', message_id='x-2')
    db.add_download(file='c.mkv', status='done', message_id='x-3')
    assert db.delete_download('a.mkv') is True and db.delete_download('a.mkv') is True  # idempotent stamp
    assert db.delete_download('zzz') is False
    assert db.delete_download_by_id(b['id']) is True and db.delete_download_by_id(99999) is False
    assert db.delete_download_by_message_id('x-3') is True and db.delete_download_by_message_id('x-9') is False
    assert db.get_all_downloads() == []
    assert len(db.get_all_downloads(include_deleted=True)) == 3
    assert db.get_downloads_by_status('done') == []


def test_queue_positions_are_kept_only_while_queued(db):
    db.add_download(file='run', status='downloading', message_id='q-1', queue_position=0)
    w1 = db.add_download(file='w1', status='waiting', message_id='q-2', queue_position=1)
    db.add_download(file='w2', status='waiting', message_id='q-3', queue_position=2)
    done = db.add_download(file='done', status='done', message_id='q-4', queue_position=9)
    assert done['queue_position'] is None                        # never queued: no rank
    assert [d['file'] for d in db.get_waiting_downloads()] == ['w1', 'w2']
    assert [d['file'] for d in db.get_queue_order()] == ['run', 'w1', 'w2']
    assert db.next_queue_position() == 3

    # Leaving the queue drops the rank, whichever write moved it
    db.update_download_by_id(w1['id'], status='stopped')
    assert db.get_download_by_id(w1['id'])['queue_position'] is None
    assert db.get_waiting_downloads()[0]['file'] == 'w2'

    # A reorder: unlisted running stay ahead, unlisted waiting fall behind
    db.add_download(file='w3', status='waiting', message_id='q-5', queue_position=None)
    ordered = db.set_queue_positions(['q-5', 'ghost'])
    assert [(d['file'], d['queue_position']) for d in ordered] == [('run', 0), ('w3', 1), ('w2', 2)]

    db.delete_download_by_message_id('q-1')
    db.delete_download_by_message_id('q-3')
    db.delete_download_by_message_id('q-5')
    assert db.next_queue_position() == 0


def test_vps_lookups_by_remote_path(db):
    db.add_download(file='a', status='done', downloaded_from='vps', message_id='v-1', url='/r/a')
    older = db.add_download(file='a', status='failed', downloaded_from='vps', message_id='v-2', url='/r/a')
    assert db.vps_download_exists('/r/a') is True and db.vps_download_exists('/r/b') is False
    assert [d['message_id'] for d in db.get_vps_downloads_for_path('/r/a')] == ['v-2', 'v-1']
    db.delete_download_by_id(older['id'])
    assert [d['message_id'] for d in db.get_vps_downloads_for_path('/r/a')] == ['v-1']


# --- watched folders -------------------------------------------------------------------------------

def test_watched_folders_dedupe_per_connection_and_backfill(db):
    first = db.add_vps_watch_folder('/w', host='h1', username='u')
    assert db.add_vps_watch_folder('/w', host='h1', username='u')['id'] == first['id']
    second = db.add_vps_watch_folder('/w', host='h2', username='u')
    assert second['id'] != first['id']                         # same path, other box
    legacy = db.add_vps_watch_folder('/legacy')
    assert db.set_vps_watch_folder_connection(legacy['id'], 'h1', 2222, 'u')['port'] == 2222
    assert db.set_vps_watch_folder_connection(99999, 'h', 22, 'u') is None
    assert db.update_vps_watch_folder(99999, auto_sync=True) is None
    row = db.update_vps_watch_folder(first['id'], auto_sync=1, folder='', is_secured='yes')
    assert (row['auto_sync'], row['folder'], row['is_secured']) == (True, None, True)
    assert db.delete_vps_watch_folder(99999) is False


# --- settings ---------------------------------------------------------------------------------------

def test_settings_bulk_and_delete(db):
    assert db.set_multiple_settings({'a': '1', 'b': '2'}) == {'a': '1', 'b': '2'}
    assert db.set_multiple_settings({'a': '3'})['a'] == '3'
    assert db.get_all_settings() == {'a': '3', 'b': '2'}
    assert db.delete_setting('a') is True and db.delete_setting('a') is False
    assert db.get_setting('a') is None
    assert db.set_setting('b', None)['value'] is None


# --- users ---------------------------------------------------------------------------------------------

def test_authentication_upgrades_a_legacy_hash(db):
    from backend.database import User as U
    session = db.get_session()
    try:
        user = session.query(U).filter_by(username='admin').one()
        user.password_hash = U.legacy_sha256('admin')
        session.commit()
    finally:
        db.close_session()
    assert db.authenticate_user('admin', 'wrong') is None
    assert db.authenticate_user('nobody', 'admin') is None
    result = db.authenticate_user('admin', 'admin')
    assert result['username'] == 'admin' and result['token_version'] == 0
    stored = db.get_user_by_username('admin').password_hash
    assert stored.startswith('$2') and not U.is_legacy_hash(stored)


def test_hash_helpers():
    assert User.is_legacy_hash('z' * 64) is False
    assert User.is_legacy_hash('ab' * 32) is True
    u = User(username='x', password_hash='not-a-bcrypt-hash')
    assert u.check_password('x') is False and u.needs_rehash() is True
    u.password_hash = None
    assert u.check_password('x') is False and u.needs_rehash() is False
    u.password_hash = User.hash_password('pw')
    assert u.check_password('pw') is True and u.needs_rehash() is False
    low = u.password_hash.replace(f'${User.BCRYPT_ROUNDS:02d}$', '$03$', 1)
    assert User(username='y', password_hash=low).needs_rehash() is True


def test_users_create_roles_and_state(db):
    assert db.create_user('admin', 'x') is None                     # taken
    made = db.create_user('second', 'pw')
    assert made['is_web'] is True and made['role'] == 'user'
    assert db.update_user_role(made['id'], 'admin')['role'] == 'admin'
    assert db.update_user_role(99999, 'admin') is None
    assert db.get_auth_state(99999) is None
    assert db.get_auth_state(made['id'])['must_change_password'] is False
    assert db.user_must_change_password(99999) is False
    assert db.update_user_password(99999, 'a', 'b') == {'error': 'User not found'}
    assert db.update_user_password(made['id'], 'wrong', 'b') == {'error': 'Current password is incorrect'}
    assert db.bump_token_version(99999) is None
    assert db.bump_token_version(made['id']) == 1


def test_telegram_users_are_registered_and_refreshed(db):
    bare = db.upsert_telegram_user(1)
    assert bare['username'] == 'tg_1' and bare['is_web'] is False and bare['role'] == 'user'
    # A Telegram username that collides with a web login gets a suffix
    clash = db.upsert_telegram_user(2, username='admin', display_name='Impostor')
    assert clash['username'] == 'admin_2'
    # Seen again: display name and username refresh, unless the name is taken
    again = db.upsert_telegram_user(1, username='bob', display_name='Bob')
    assert (again['id'], again['username'], again['display_name']) == (bare['id'], 'bob', 'Bob')
    stuck = db.upsert_telegram_user(1, username='admin_2')
    assert stuck['username'] == 'bob'
    assert db.get_telegram_user_role(1) == 'user' and db.get_telegram_user_role(999) is None
    assert {u['username'] for u in db.get_users()} == {'admin', 'tg_1', 'admin_2'} - {'tg_1'} | {'bob'}


# --- refresh sessions ---------------------------------------------------------------------------------

def test_session_rotation_detects_reuse(db):
    uid = db.get_user_by_username('admin').id
    later = datetime.utcnow() + timedelta(days=1)
    sid = db.create_user_session(uid, 'jti-1', later, user_agent='ua' * 200, ip='1.2.3.4')
    assert db.get_user_sessions(uid)[0]['id'] == sid
    assert db.rotate_user_session(sid, uid, 'jti-1', 'jti-2', later, ip='5.6.7.8') == {'ok': True}
    # Presenting the superseded token: theft - the session is revoked
    assert db.rotate_user_session(sid, uid, 'jti-1', 'jti-3', later) == {'error': 'reuse_detected'}
    assert db.rotate_user_session(sid, uid, 'jti-2', 'jti-3', later) == {'error': 'revoked'}
    assert db.get_user_sessions(uid) == []
    assert db.rotate_user_session(99999, uid, 'x', 'y', later) == {'error': 'revoked'}


def test_expired_sessions_are_refused_and_purged(db):
    uid = db.get_user_by_username('admin').id
    past = datetime.utcnow() - timedelta(days=30)
    sid = db.create_user_session(uid, 'old', past)
    assert db.rotate_user_session(sid, uid, 'old', 'new', past) == {'error': 'expired'}
    assert db.revoke_user_session(sid) is True and db.revoke_user_session(sid, user_id=uid) is True
    assert db.revoke_user_session(99999) is False
    assert db.purge_expired_sessions(keep_days=7) == 1
    assert db.purge_expired_sessions() == 0


# --- rename rules & speed tests -------------------------------------------------------------------

def test_rename_rule_edges(db):
    first = db.add_rename_rule('a', 'b', name='one', enabled=False)
    second = db.add_rename_rule('c', 'd', name='two', position=0)
    assert [r['name'] for r in db.get_rename_rules()] == ['two', 'one']
    assert [r['name'] for r in db.get_rename_rules(enabled_only=True)] == ['two']
    assert db.update_rename_rule(99999, name='x') is None
    assert db.update_rename_rule(first['id'], enabled=True, source='vps')['source'] == 'vps'
    assert db.reorder_rename_rules([first['id'], 99999, second['id']]) is True
    assert [r['name'] for r in db.get_rename_rules()] == ['one', 'two']
    assert db.delete_rename_rule(99999) is False


def test_speed_tests_are_recorded_and_listed_newest_first(db):
    a = db.add_speed_test('browser', ping={'min': 1, 'avg': 2}, download_mbps='10.5',
                          client='x' * 400, ip='::1', meta={'city': 'Oslo'})
    b = db.add_speed_test('internet', download_bytes=10)
    assert a['ping'] == {'min': 1, 'avg': 2, 'max': None, 'jitter': None}
    assert a['download_mbps'] == 10.5 and len(a['client']) == 300 and a['meta'] == {'city': 'Oslo'}
    assert [t['id'] for t in db.get_speed_tests()] == [b['id'], a['id']]
    assert [t['kind'] for t in db.get_speed_tests(kind='browser')] == ['browser']
    assert db.delete_speed_test(a['id']) is True and db.delete_speed_test(a['id']) is False

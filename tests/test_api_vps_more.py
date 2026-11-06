"""The VPS settings and browse routes: connection config, watched folders,
the live listing, usage and the download/delete hand-offs.

Nothing here opens a socket. paramiko is replaced at the module boundary the
routes use (`open_vps_sftp`, `paramiko.SSHClient`, `vps_usage_snapshot`), and
the VPS downloader stays unwired unless a test wires in a recording fake.
"""
import json
import time as time_module

import pytest

from backend.web_app.routes import vps_browse as browse_route
from backend.web_app.routes import vps_settings as settings_route


CREDS = {'host': 'box.example', 'port': 2222, 'username': 'tester'}


def save_connection(client, auth, password='hunter2', **over):
    body = {**CREDS, 'password': password, **over}
    res = client.post('/api/settings/vps', headers=auth, json=body)
    assert res.status_code == 200, res.get_data(as_text=True)
    return res.get_json()


class _Ssh:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeVpsDownloader:
    """Records every call the routes make into the SFTP handler."""

    def __init__(self):
        self.started = []
        self.deleted = []
        self.snapshots = []
        self.forgotten = []
        self.delete_error = None
        self.start_result = None

    def start_download(self, path, size=0, dest=None):
        self.started.append((path, size, dest))
        return self.start_result or {'id': 1, 'message_id': 'm-1'}

    def delete_remote(self, path):
        if self.delete_error:
            raise self.delete_error
        self.deleted.append(path)

    def snapshot_folder(self, path):
        self.snapshots.append(path)

    def forget_folder(self, path):
        self.forgotten.append(path)


# ---------------------------------------------------------------------------
# Connection config
# ---------------------------------------------------------------------------

def test_config_starts_unconfigured(client, db, auth):
    body = client.get('/api/settings/vps', headers=auth).get_json()
    assert body['configured'] is False
    assert body['has_password'] is False
    assert body['port'] == 22


def test_saving_encrypts_the_password_and_never_echoes_it(client, db, auth):
    from backend.utils import decrypt_secret
    body = save_connection(client, auth, remote_path='/home6/tester/downloads')
    assert body == {'status': 'saved', 'configured': True, 'has_password': True}

    raw = db.get_setting('vps_config')
    assert 'hunter2' not in raw                      # encrypted at rest
    stored = json.loads(raw)
    assert decrypt_secret(stored['password_enc']) == 'hunter2'
    assert stored['remote_path'] == '/home6/tester/downloads'

    shown = client.get('/api/settings/vps', headers=auth).get_json()
    assert shown['configured'] is True
    assert shown['host'] == 'box.example' and shown['port'] == 2222
    assert shown['has_password'] is True
    assert 'hunter2' not in str(shown) and 'password_enc' not in shown


def test_a_blank_password_keeps_the_saved_one(client, db, auth):
    from backend.utils import decrypt_secret
    save_connection(client, auth)
    body = save_connection(client, auth, password='')
    assert body['has_password'] is True
    assert decrypt_secret(json.loads(db.get_setting('vps_config'))['password_enc']) == 'hunter2'


def test_a_blank_password_over_a_broken_setting_saves_without_one(client, db, auth):
    db.set_setting('vps_config', 'not json')
    body = save_connection(client, auth, password='')
    assert body['has_password'] is False
    shown = client.get('/api/settings/vps', headers=auth).get_json()
    assert shown['configured'] is True and shown['has_password'] is False


def test_a_broken_setting_reads_as_unconfigured(client, db, auth):
    db.set_setting('vps_config', '{not json')
    shown = client.get('/api/settings/vps', headers=auth).get_json()
    assert shown['configured'] is False


@pytest.mark.parametrize('body', [
    {'host': '', 'username': 'u', 'password': 'p'},
    {'host': 'h', 'username': '', 'password': 'p'},
    {'host': 'h', 'username': 'u', 'port': 'eleventy'},
])
def test_saving_validates_host_username_and_port(client, db, auth, body):
    res = client.post('/api/settings/vps', headers=auth, json=body)
    assert res.status_code == 400


def test_saving_drops_the_pooled_session(client, db, auth, monkeypatch):
    closed = []
    monkeypatch.setattr(settings_route, 'close_pooled_session', lambda: closed.append(1))
    save_connection(client, auth)
    assert closed == [1]


def test_deleting_the_connection_keeps_watched_folders(client, db, auth, monkeypatch):
    save_connection(client, auth)
    client.post('/api/settings/vps/folders', headers=auth, json={'path': '/home6/tester/dl'})
    closed = []
    monkeypatch.setattr(settings_route, 'close_pooled_session', lambda: closed.append(1))
    res = client.delete('/api/settings/vps', headers=auth)
    assert res.get_json() == {'status': 'deleted', 'configured': False}
    assert closed == [1]
    assert client.get('/api/settings/vps', headers=auth).get_json()['configured'] is False
    folders = client.get('/api/settings/vps/folders', headers=auth).get_json()['folders']
    assert [f['path'] for f in folders] == ['/home6/tester/dl']
    assert folders[0]['active'] is False       # no connection to belong to


# ---------------------------------------------------------------------------
# Test connection
# ---------------------------------------------------------------------------

class FakeSSHClient:
    """paramiko.SSHClient stand-in: `script` says what connect() does."""
    script = {}
    instances = []

    def __init__(self):
        self.connect_kwargs = None
        self.closed = False
        FakeSSHClient.instances.append(self)

    def set_missing_host_key_policy(self, policy):
        pass

    def connect(self, **kwargs):
        self.connect_kwargs = kwargs
        err = FakeSSHClient.script.get('connect_error')
        if err:
            raise err

    def open_sftp(self):
        listing = FakeSSHClient.script.get('listing')

        class Sftp:
            def __init__(self):
                self.closed = False

            def listdir(self, path):
                if isinstance(listing, Exception):
                    raise listing
                return listing

            def close(self):
                self.closed = True
        return Sftp()

    def close(self):
        self.closed = True


@pytest.fixture
def fake_paramiko(monkeypatch):
    import paramiko
    FakeSSHClient.script = {}
    FakeSSHClient.instances = []
    monkeypatch.setattr(paramiko, 'SSHClient', FakeSSHClient)
    return FakeSSHClient


def test_test_connection_reports_success_and_closes(client, db, auth, fake_paramiko):
    res = client.post('/api/settings/vps/test', headers=auth,
                      json={**CREDS, 'password': 'p'})
    assert res.status_code == 200
    body = res.get_json()
    assert body['success'] is True
    assert 'box.example:2222' in body['message'] and 'tester' in body['message']
    ssh = fake_paramiko.instances[0]
    assert ssh.closed is True
    assert ssh.connect_kwargs['password'] == 'p'
    assert ssh.connect_kwargs['allow_agent'] is False and ssh.connect_kwargs['look_for_keys'] is False


def test_test_connection_counts_the_watch_folder(client, db, auth, fake_paramiko):
    fake_paramiko.script['listing'] = ['a', 'b', 'c']
    body = client.post('/api/settings/vps/test', headers=auth,
                       json={**CREDS, 'password': 'p', 'remote_path': '/dl'}).get_json()
    assert body['success'] is True
    assert '3 item(s) in /dl' in body['message']


def test_test_connection_reports_an_unreachable_watch_folder(client, db, auth, fake_paramiko):
    fake_paramiko.script['listing'] = IOError('No such file')
    body = client.post('/api/settings/vps/test', headers=auth,
                       json={**CREDS, 'password': 'p', 'remote_path': '/nope'}).get_json()
    assert body['success'] is False
    assert "cannot access '/nope'" in body['error']
    assert fake_paramiko.instances[0].closed is True


def test_test_connection_falls_back_to_the_saved_password(client, db, auth, fake_paramiko):
    save_connection(client, auth, password='saved-secret')
    body = client.post('/api/settings/vps/test', headers=auth, json={**CREDS}).get_json()
    assert body['success'] is True
    assert fake_paramiko.instances[-1].connect_kwargs['password'] == 'saved-secret'


def test_test_connection_without_any_password_is_refused(client, db, auth, fake_paramiko):
    res = client.post('/api/settings/vps/test', headers=auth, json={**CREDS})
    assert res.status_code == 400
    assert 'password' in res.get_json()['error'].lower()
    assert fake_paramiko.instances == []     # never got as far as connecting


def test_test_connection_over_a_broken_saved_config_is_refused(client, db, auth, fake_paramiko):
    db.set_setting('vps_config', 'not json')
    res = client.post('/api/settings/vps/test', headers=auth, json={**CREDS})
    assert res.status_code == 400


@pytest.mark.parametrize('body', [
    {**CREDS, 'port': 'x', 'password': 'p'},
    {'host': '', 'username': 'u', 'password': 'p'},
])
def test_test_connection_validates_input(client, db, auth, fake_paramiko, body):
    res = client.post('/api/settings/vps/test', headers=auth, json=body)
    assert res.status_code == 400 and res.get_json()['success'] is False


def test_test_connection_names_an_auth_failure(client, db, auth, fake_paramiko):
    import paramiko
    fake_paramiko.script['connect_error'] = paramiko.AuthenticationException('bad')
    body = client.post('/api/settings/vps/test', headers=auth,
                       json={**CREDS, 'password': 'wrong'}).get_json()
    assert body['success'] is False and 'Authentication failed' in body['error']


def test_test_connection_reports_any_other_failure(client, db, auth, fake_paramiko):
    fake_paramiko.script['connect_error'] = OSError('Connection refused')
    body = client.post('/api/settings/vps/test', headers=auth,
                       json={**CREDS, 'password': 'p'}).get_json()
    assert body['success'] is False and 'Connection refused' in body['error']
    assert fake_paramiko.instances[0].closed is True


# ---------------------------------------------------------------------------
# Remote / local folder browsing
# ---------------------------------------------------------------------------

@pytest.fixture
def sftp(monkeypatch, fake_sftp):
    """The browse and live-listing routes open their own SFTP session."""
    opened = []

    def open_sftp(timeout=10):
        ssh = _Ssh()
        opened.append(ssh)
        return ssh, fake_sftp

    monkeypatch.setattr(browse_route, 'open_vps_sftp', open_sftp)
    fake_sftp.opened = opened
    return fake_sftp


def test_browsing_defaults_to_the_login_home(client, db, auth, sftp):
    res = client.post('/api/settings/vps/browse', headers=auth, json={})
    assert res.status_code == 200
    body = res.get_json()
    assert body['path'] == '/home6/tester'
    assert body['parent'] == '/home6'
    # Directories first, then files, each sorted case-insensitively
    assert [(e['name'], e['is_dir']) for e in body['entries']] == [
        ('.cache', True), ('downloads', True), ('notes.txt', False)]
    assert body['entries'][1]['path'] == '/home6/tester/downloads'
    assert sftp.opened[0].closed is True


def test_browsing_a_given_folder(client, db, auth, sftp):
    body = client.post('/api/settings/vps/browse', headers=auth,
                       json={'path': '/home6/tester/downloads/'}).get_json()
    assert body['path'] == '/home6/tester/downloads'
    assert [e['name'] for e in body['entries']] == ['Show.S01', 'movie.mkv']


def test_browsing_a_missing_folder_is_500_and_still_closes(client, db, auth, sftp):
    res = client.post('/api/settings/vps/browse', headers=auth, json={'path': '/nope'})
    assert res.status_code == 500
    assert sftp.opened[0].closed is True


def test_browsing_without_a_connection_is_400(client, db, auth, monkeypatch):
    def refuse(timeout=10):
        raise ValueError('VPS connection is not configured')
    monkeypatch.setattr(browse_route, 'open_vps_sftp', refuse)
    res = client.post('/api/settings/vps/browse', headers=auth, json={})
    assert res.status_code == 400
    assert 'not configured' in res.get_json()['error']


def test_local_browse_lists_directories_first(client, db, auth, tmp_tree):
    body = client.post('/api/settings/local/browse', headers=auth,
                       json={'path': str(tmp_tree)}).get_json()
    assert body['path'] == str(tmp_tree)
    assert body['parent'] == str(tmp_tree.parent)
    names = [(e['name'], e['is_dir']) for e in body['entries']]
    assert names[0] == ('Movies', True)
    assert ('notes.txt', False) in names and ('.hidden', False) in names


def test_local_browse_defaults_to_the_download_dir(client, db, auth):
    from backend.config import DOWNLOAD_DIR
    body = client.post('/api/settings/local/browse', headers=auth, json={}).get_json()
    assert body['path'] == str(DOWNLOAD_DIR.resolve())


def test_local_browse_of_the_root_has_no_parent(client, db, auth):
    body = client.post('/api/settings/local/browse', headers=auth, json={'path': '/'}).get_json()
    assert body['parent'] is None


@pytest.mark.parametrize('path', ['/definitely/not/here', 'notes.txt'])
def test_local_browse_of_a_non_directory_is_400(client, db, auth, tmp_tree, path):
    target = path if path.startswith('/') else str(tmp_tree / path)
    res = client.post('/api/settings/local/browse', headers=auth, json={'path': target})
    assert res.status_code == 400


def test_local_browse_reports_permission_denied(client, db, auth, tmp_path, monkeypatch):
    import os
    monkeypatch.setattr(os, 'scandir', lambda p: (_ for _ in ()).throw(PermissionError()))
    res = client.post('/api/settings/local/browse', headers=auth, json={'path': str(tmp_path)})
    assert res.status_code == 403


def test_local_browse_reports_a_vanished_folder(client, db, auth, tmp_path, monkeypatch):
    import os
    monkeypatch.setattr(os, 'scandir', lambda p: (_ for _ in ()).throw(FileNotFoundError()))
    res = client.post('/api/settings/local/browse', headers=auth, json={'path': str(tmp_path)})
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Watched folders
# ---------------------------------------------------------------------------

@pytest.fixture
def connected(client, db, auth):
    save_connection(client, auth)
    return auth


def test_adding_folders_needs_a_connection(client, db, auth):
    res = client.post('/api/settings/vps/folders', headers=auth, json={'path': '/x'})
    assert res.status_code == 400


@pytest.mark.parametrize('body', [{}, {'paths': 'not-a-list'}, {'paths': []}, {'path': ''}])
def test_adding_folders_validates_the_body(client, db, connected, body):
    res = client.post('/api/settings/vps/folders', headers=connected, json=body)
    assert res.status_code == 400


def test_folders_are_bound_to_the_connection_they_were_added_on(client, db, connected):
    res = client.post('/api/settings/vps/folders', headers=connected,
                      json={'paths': ['/home6/tester/a', ' ', '/home6/tester/b']})
    assert res.status_code == 200
    body = res.get_json()
    assert [f['path'] for f in body['added']] == ['/home6/tester/a', '/home6/tester/b']
    assert all(f['host'] == 'box.example' and f['port'] == 2222 and f['username'] == 'tester'
               for f in body['folders'])
    assert all(f['active'] for f in body['folders'])

    # Re-adding the same path returns the same row rather than a twin
    again = client.post('/api/settings/vps/folders', headers=connected,
                        json={'path': '/home6/tester/a'}).get_json()
    assert again['added'][0]['id'] == body['added'][0]['id']
    assert len(again['folders']) == 2


def test_folders_of_another_connection_are_listed_inactive(client, db, connected):
    client.post('/api/settings/vps/folders', headers=connected, json={'path': '/mine'})
    db.add_vps_watch_folder('/theirs', host='other.example', port=22, username='someone')
    folders = client.get('/api/settings/vps/folders', headers=connected).get_json()['folders']
    by_path = {f['path']: f['active'] for f in folders}
    assert by_path == {'/mine': True, '/theirs': False}


def test_a_legacy_host_less_folder_is_adopted_by_the_current_connection(client, db, connected):
    legacy = db.add_vps_watch_folder('/legacy')          # no host recorded
    folders = client.get('/api/settings/vps/folders', headers=connected).get_json()['folders']
    adopted = next(f for f in folders if f['id'] == legacy['id'])
    assert adopted['host'] == 'box.example' and adopted['active'] is True
    # ...and it is written back, not just tagged for this one response
    assert db.get_vps_watch_folders()[0]['host'] == 'box.example'


def test_patch_updates_specs_and_rejects_an_empty_body(client, db, connected):
    added = client.post('/api/settings/vps/folders', headers=connected,
                        json={'path': '/dl'}).get_json()['added'][0]
    fid = added['id']
    assert client.patch(f'/api/settings/vps/folders/{fid}', headers=connected,
                        json={'colour': 'blue'}).status_code == 400
    res = client.patch(f'/api/settings/vps/folders/{fid}', headers=connected,
                       json={'folder': '/mnt/tv', 'is_secured': True})
    assert res.status_code == 200
    body = res.get_json()
    assert body['folder']['folder'] == '/mnt/tv' and body['folder']['is_secured'] is True
    assert body['folders'][0]['active'] is True


def test_patch_of_an_unknown_folder_is_404(client, db, connected):
    res = client.patch('/api/settings/vps/folders/999', headers=connected, json={'auto_sync': True})
    assert res.status_code == 404


def test_toggling_auto_sync_snapshots_then_forgets(client, app, db, connected):
    vps = app.vps_downloader = FakeVpsDownloader()
    fid = client.post('/api/settings/vps/folders', headers=connected,
                      json={'path': '/dl'}).get_json()['added'][0]['id']
    client.patch(f'/api/settings/vps/folders/{fid}', headers=connected, json={'auto_sync': True})
    assert vps.snapshots == ['/dl'] and vps.forgotten == []
    client.patch(f'/api/settings/vps/folders/{fid}', headers=connected, json={'auto_sync': False})
    assert vps.forgotten == ['/dl']
    # A spec-only change leaves the baseline alone
    client.patch(f'/api/settings/vps/folders/{fid}', headers=connected, json={'folder': '/x'})
    assert vps.snapshots == ['/dl'] and vps.forgotten == ['/dl']


# --- delete + the unhide guard ---------------------------------------------

@pytest.fixture
def secured_folder(client, db, connected):
    """A secured watched folder with one download hidden only by it."""
    fid = client.post('/api/settings/vps/folders', headers=connected,
                      json={'path': '/home6/tester/private'}).get_json()['added'][0]['id']
    client.patch(f'/api/settings/vps/folders/{fid}', headers=connected, json={'is_secured': True})
    db.add_download(file='secret.mkv', status='done', downloaded_from='vps',
                    message_id='m-s', url='/home6/tester/private/secret.mkv', progress=100)
    db.add_download(file='public.mkv', status='done', downloaded_from='vps',
                    message_id='m-p', url='/home6/tester/public/public.mkv', progress=100)
    return fid


def test_delete_impact_counts_only_what_this_folder_hides(client, db, connected, secured_folder):
    body = client.get(f'/api/settings/vps/folders/{secured_folder}/delete-impact',
                      headers=connected).get_json()
    assert body == {'count': 1, 'sample': ['secret.mkv']}


def test_delete_impact_of_an_unknown_folder_is_404(client, db, connected):
    assert client.get('/api/settings/vps/folders/999/delete-impact',
                      headers=connected).status_code == 404


def test_delete_impact_is_zero_when_nothing_would_change(client, db, connected):
    fid = client.post('/api/settings/vps/folders', headers=connected,
                      json={'path': '/plain'}).get_json()['added'][0]['id']
    body = client.get(f'/api/settings/vps/folders/{fid}/delete-impact', headers=connected).get_json()
    assert body == {'count': 0, 'sample': []}


def test_deleting_a_folder_that_would_unhide_downloads_is_refused_until_confirmed(
        client, app, db, connected, secured_folder):
    vps = app.vps_downloader = FakeVpsDownloader()
    res = client.delete(f'/api/settings/vps/folders/{secured_folder}', headers=connected)
    assert res.status_code == 409
    body = res.get_json()
    assert body['unhide'] == {'count': 1, 'sample': ['secret.mkv']}
    assert vps.forgotten == []
    assert len(db.get_vps_watch_folders()) == 1          # still there

    res = client.delete(f'/api/settings/vps/folders/{secured_folder}?confirm_unhide=1',
                        headers=connected)
    assert res.status_code == 200
    assert res.get_json()['status'] == 'deleted' and res.get_json()['folders'] == []
    assert vps.forgotten == ['/home6/tester/private']
    assert db.get_vps_watch_folders() == []


def test_confirm_unhide_accepts_true(client, db, connected, secured_folder):
    res = client.delete(f'/api/settings/vps/folders/{secured_folder}?confirm_unhide=true',
                        headers=connected)
    assert res.status_code == 200


def test_deleting_a_harmless_folder_needs_no_confirmation(client, db, connected):
    fid = client.post('/api/settings/vps/folders', headers=connected,
                      json={'path': '/plain'}).get_json()['added'][0]['id']
    assert client.delete(f'/api/settings/vps/folders/{fid}', headers=connected).status_code == 200
    # Soft-deleted: gone from every listing, and a second delete is a 404
    assert client.delete(f'/api/settings/vps/folders/{fid}', headers=connected).status_code == 404
    assert client.get('/api/settings/vps/folders', headers=connected).get_json()['folders'] == []


def test_a_deleted_path_can_be_added_again(client, db, connected):
    fid = client.post('/api/settings/vps/folders', headers=connected,
                      json={'path': '/again'}).get_json()['added'][0]['id']
    client.delete(f'/api/settings/vps/folders/{fid}', headers=connected)
    fresh = client.post('/api/settings/vps/folders', headers=connected,
                        json={'path': '/again'}).get_json()['added'][0]
    assert fresh['id'] != fid


# ---------------------------------------------------------------------------
# Live listing of the watched folders
# ---------------------------------------------------------------------------

def test_listing_with_no_watched_folders_is_empty(client, db, auth):
    assert client.get('/api/vps/files', headers=auth).get_json() == {'folders': []}


def test_listing_fetches_active_folders_and_marks_downloads(client, db, connected, sftp):
    client.post('/api/settings/vps/folders', headers=connected,
                json={'path': '/home6/tester/downloads'})
    db.add_download(file='movie.mkv', status='downloading', downloaded_from='vps',
                    message_id='m-1', url='/home6/tester/downloads/movie.mkv', progress=40)
    body = client.get('/api/vps/files', headers=connected).get_json()
    assert len(body['folders']) == 1
    group = body['folders'][0]
    assert group['path'] == '/home6/tester/downloads' and group['active'] is True
    assert 'error' not in group
    entries = {e['name']: e for e in group['entries']}
    assert [e['name'] for e in group['entries']] == ['Show.S01', 'movie.mkv']   # dirs first
    assert entries['Show.S01']['is_dir'] is True and entries['Show.S01']['downloaded'] is False
    movie = entries['movie.mkv']
    assert movie['downloaded'] is True and movie['message_id'] == 'm-1' and movie['status'] == 'downloading'
    assert movie['size'] == 4096 and movie['folder'] == '/home6/tester/downloads'
    assert movie['modified'].endswith('Z')
    assert sftp.opened[0].closed is True


def test_listing_leaves_other_connections_folders_unfetched(client, db, connected, sftp):
    db.add_vps_watch_folder('/elsewhere', host='other.example', port=22, username='x')
    body = client.get('/api/vps/files', headers=connected).get_json()
    assert body['folders'][0]['error'] == 'Belongs to a different VPS connection'
    assert body['folders'][0]['entries'] == []
    assert sftp.opened == []            # no login for nothing to fetch


def test_listing_reports_a_folder_that_fails_without_dropping_the_rest(client, db, connected, sftp):
    client.post('/api/settings/vps/folders', headers=connected,
                json={'paths': ['/home6/tester/downloads', '/home6/tester/missing']})
    db.add_vps_watch_folder('/elsewhere', host='other.example', port=22, username='x')
    body = client.get('/api/vps/files', headers=connected).get_json()
    by_path = {g['path']: g for g in body['folders']}
    assert 'error' not in by_path['/home6/tester/downloads']
    assert 'No such file' in by_path['/home6/tester/missing']['error']
    # active groups first, then the inactive ones
    assert [g['path'] for g in body['folders']][-1] == '/elsewhere'


def test_listing_hides_secured_folders_unless_asked(client, db, connected, sftp):
    fid = client.post('/api/settings/vps/folders', headers=connected,
                      json={'path': '/home6/tester/downloads'}).get_json()['added'][0]['id']
    client.patch(f'/api/settings/vps/folders/{fid}', headers=connected, json={'is_secured': True})
    assert client.get('/api/vps/files', headers=connected).get_json() == {'folders': []}
    shown = client.get('/api/vps/files?include_hidden=true', headers=connected).get_json()
    assert [g['path'] for g in shown['folders']] == ['/home6/tester/downloads']


def test_listing_without_a_password_is_a_400(client, db, connected, monkeypatch):
    client.post('/api/settings/vps/folders', headers=connected, json={'path': '/dl'})

    def refuse(timeout=10):
        raise ValueError('No saved password for the VPS connection')
    monkeypatch.setattr(browse_route, 'open_vps_sftp', refuse)
    res = client.get('/api/vps/files', headers=connected)
    assert res.status_code == 400 and 'password' in res.get_json()['error']


def test_listing_with_the_box_down_is_a_500(client, db, connected, monkeypatch):
    client.post('/api/settings/vps/folders', headers=connected, json={'path': '/dl'})

    def refuse(timeout=10):
        raise OSError('Connection timed out')
    monkeypatch.setattr(browse_route, 'open_vps_sftp', refuse)
    res = client.get('/api/vps/files', headers=connected)
    assert res.status_code == 500 and 'timed out' in res.get_json()['error']


# ---------------------------------------------------------------------------
# Download / delete hand-offs
# ---------------------------------------------------------------------------

def test_download_and_delete_say_so_when_the_downloader_is_unwired(client, db, auth):
    res = client.post('/api/vps/download', headers=auth, json={'path': '/dl/x'})
    assert res.status_code == 503 and 'not available' in res.get_json()['error']
    res = client.post('/api/vps/delete-remote', headers=auth, json={'path': '/dl/x'})
    assert res.status_code == 503 and 'not available' in res.get_json()['error']


def test_download_requires_a_path(client, app, db, auth):
    app.vps_downloader = FakeVpsDownloader()
    res = client.post('/api/vps/download', headers=auth, json={'path': '  '})
    assert res.status_code == 400


def test_download_hands_off_with_the_size(client, app, db, auth):
    vps = app.vps_downloader = FakeVpsDownloader()
    res = client.post('/api/vps/download', headers=auth, json={'path': '/dl/movie.mkv', 'size': '4096'})
    assert res.status_code == 200 and res.get_json()['message_id'] == 'm-1'
    assert vps.started == [('/dl/movie.mkv', 4096, None)]


def test_download_for_a_torrent_client_lands_in_its_local_dir(client, app, db, auth, monkeypatch):
    from backend.web_app.torrent import read_torrent_settings, write_torrent_settings
    monkeypatch.setattr('backend.web_app.routes.torrent.apply_torrent_session', lambda cfg: None)
    client.post('/api/settings/torrent', headers=auth,
                json={'client': 'qbittorrent', 'url': 'http://box:8080'})
    settings = read_torrent_settings()
    settings['qbittorrent']['local_dir'] = '/mnt/tv'
    write_torrent_settings(settings)
    vps = app.vps_downloader = FakeVpsDownloader()
    client.post('/api/vps/download', headers=auth, json={'path': '/dl/x', 'client': 'qbittorrent'})
    client.post('/api/vps/download', headers=auth, json={'path': '/dl/y', 'client': 'transmission'})
    client.post('/api/vps/download', headers=auth, json={'path': '/dl/z', 'client': 'deluge'})
    assert [c[2] for c in vps.started] == ['/mnt/tv', None, None]


def test_a_refused_download_is_a_400(client, app, db, auth):
    vps = app.vps_downloader = FakeVpsDownloader()
    vps.start_result = {'error': 'Already downloaded'}
    res = client.post('/api/vps/download', headers=auth, json={'path': '/dl/x'})
    assert res.status_code == 400 and res.get_json()['error'] == 'Already downloaded'


def test_delete_remote_round_trips_and_maps_errors(client, app, db, auth):
    vps = app.vps_downloader = FakeVpsDownloader()
    assert client.post('/api/vps/delete-remote', headers=auth, json={}).status_code == 400
    res = client.post('/api/vps/delete-remote', headers=auth, json={'path': '/dl/x '})
    assert res.status_code == 200 and vps.deleted == ['/dl/x']

    vps.delete_error = ValueError('remote path is required')
    assert client.post('/api/vps/delete-remote', headers=auth,
                       json={'path': '/dl/x'}).status_code == 400
    vps.delete_error = IOError('Permission denied')
    res = client.post('/api/vps/delete-remote', headers=auth, json={'path': '/dl/x'})
    assert res.status_code == 500 and 'Permission denied' in res.get_json()['error']


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

def _snapshot(rx=1000, tx=2000, iface='eth0', disk=True):
    return {
        'disk': {'used': 10, 'limit': 100, 'filesystem': '/dev/sdu1',
                 'percent': 10.0, 'source': 'quota'} if disk else None,
        'volume': {'filesystem': '/dev/sdu1', 'mount': '/home6', 'total': 1000,
                   'used': 500, 'avail': 500, 'percent': 50.0},
        'load': {'load1': 1.0, 'load5': 1.0, 'load15': 1.0, 'cores': 4, 'percent': 25.0},
        'net': {'iface': iface, 'rx_bytes': rx, 'tx_bytes': tx} if iface else None,
    }


@pytest.fixture
def clock(monkeypatch):
    """A controllable `time.time()`: the usage route reads it for both the
    cache TTL and the throughput window."""
    state = {'now': time_module.time()}

    class Clock:
        def advance(self, seconds):
            state['now'] += seconds

        @property
        def now(self):
            return state['now']

    monkeypatch.setattr(time_module, 'time', lambda: state['now'])
    return Clock()


@pytest.fixture
def usage(monkeypatch, clock):
    """Credentials present, the snapshot scripted, no torrent clients."""
    calls = []
    script = {'snapshot': _snapshot()}

    def snapshot(timeout=15):
        calls.append(1)
        snap = script['snapshot']
        if isinstance(snap, Exception):
            raise snap
        return json.loads(json.dumps(snap))      # a fresh copy; the route mutates `net`

    monkeypatch.setattr(browse_route, 'load_vps_credentials', lambda: {**CREDS, 'password': 'p'})
    monkeypatch.setattr(browse_route, 'vps_usage_snapshot', snapshot)
    monkeypatch.setattr(browse_route, 'load_torrent_config', lambda c: None)
    script['calls'] = calls
    return script


def test_usage_without_a_connection_says_so(client, db, auth, monkeypatch):
    monkeypatch.setattr(browse_route, 'load_vps_credentials', lambda: None)
    monkeypatch.setattr(browse_route, 'load_torrent_config', lambda c: None)
    body = client.get('/api/vps/usage', headers=auth).get_json()
    assert body['host'] is None and body['disk'] is None and body['server'] is None
    assert body['disk_error'] == 'VPS connection is not configured'
    assert body['clients'] == [] and body['traffic'] == {'downloaded': 0, 'uploaded': 0}


def test_usage_reports_the_snapshot_without_rates_on_the_first_call(client, db, auth, usage):
    body = client.get('/api/vps/usage', headers=auth).get_json()
    assert body['host'] == 'box.example'
    assert body['disk']['source'] == 'quota'
    assert body['server']['volume']['mount'] == '/home6'
    assert body['server']['load']['cores'] == 4
    net = body['server']['net']
    assert net['iface'] == 'eth0' and net['rx_bytes'] == 1000
    assert 'rx_rate' not in net and 'tx_rate' not in net and 'window' not in net


def test_usage_is_cached_for_a_minute_and_refresh_bypasses_it(client, db, auth, usage, clock):
    first = client.get('/api/vps/usage', headers=auth).get_json()
    clock.advance(30)
    usage['snapshot'] = _snapshot(rx=5000)
    again = client.get('/api/vps/usage', headers=auth).get_json()
    assert again == first and len(usage['calls']) == 1          # served from cache

    fresh = client.get('/api/vps/usage?refresh=1', headers=auth).get_json()
    assert len(usage['calls']) == 2
    assert fresh['server']['net']['rx_bytes'] == 5000

    clock.advance(61)
    expired = client.get('/api/vps/usage', headers=auth).get_json()
    assert len(usage['calls']) == 3
    assert expired['cached_at'] > fresh['cached_at']


def test_usage_derives_throughput_from_the_delta_between_polls(client, db, auth, usage, clock):
    client.get('/api/vps/usage', headers=auth)
    clock.advance(10)
    usage['snapshot'] = _snapshot(rx=1000 + 10 * 125000, tx=2000 + 10 * 50000)
    net = client.get('/api/vps/usage?refresh=1', headers=auth).get_json()['server']['net']
    assert net['rx_rate'] == 125000 and net['tx_rate'] == 50000 and net['window'] == 10


def test_usage_skips_a_rate_over_too_short_a_window(client, db, auth, usage, clock):
    client.get('/api/vps/usage', headers=auth)
    clock.advance(2)
    usage['snapshot'] = _snapshot(rx=999999)
    net = client.get('/api/vps/usage?refresh=1', headers=auth).get_json()['server']['net']
    assert 'rx_rate' not in net
    # ...but that poll still becomes the baseline for the next one
    clock.advance(10)
    usage['snapshot'] = _snapshot(rx=999999 + 1000, tx=2000)
    net = client.get('/api/vps/usage?refresh=1', headers=auth).get_json()['server']['net']
    assert net['rx_rate'] == 100 and net['tx_rate'] == 0


def test_usage_skips_a_rate_when_the_counters_went_backwards(client, db, auth, usage, clock):
    """A reboot resets /proc/net/dev; a negative delta would read as a huge rate."""
    client.get('/api/vps/usage', headers=auth)
    clock.advance(10)
    usage['snapshot'] = _snapshot(rx=10, tx=20)
    net = client.get('/api/vps/usage?refresh=1', headers=auth).get_json()['server']['net']
    assert 'rx_rate' not in net and 'tx_rate' not in net


def test_usage_skips_a_rate_when_the_interface_changed(client, db, auth, usage, clock):
    client.get('/api/vps/usage', headers=auth)
    clock.advance(10)
    usage['snapshot'] = _snapshot(rx=90000, tx=90000, iface='eth1')
    net = client.get('/api/vps/usage?refresh=1', headers=auth).get_json()['server']['net']
    assert 'rx_rate' not in net


def test_usage_tolerates_a_box_with_no_net_counters(client, db, auth, usage):
    usage['snapshot'] = _snapshot(iface=None, disk=False)
    body = client.get('/api/vps/usage', headers=auth).get_json()
    assert body['disk'] is None
    assert body['server']['net'] is None


def test_usage_reports_a_failed_snapshot_without_failing(client, db, auth, usage):
    usage['snapshot'] = OSError('Connection timed out')
    body = client.get('/api/vps/usage', headers=auth).get_json()
    assert body['disk'] is None and body['server'] is None
    assert 'timed out' in body['disk_error']


def test_usage_sums_the_torrent_clients_and_isolates_a_failing_one(
        client, db, auth, usage, monkeypatch):
    from backend.web_app import torrent as tor
    monkeypatch.setattr(browse_route, 'load_torrent_config', lambda c: {'url': 'x'})

    def stats(client_name):
        if client_name == 'qbittorrent':
            raise ValueError('Cannot reach qBittorrent')
        return {'downloaded': 300, 'uploaded': 100, 'ratio': 0.33,
                'session_downloaded': 3, 'session_uploaded': 1, 'free_space': None}

    monkeypatch.setattr(tor, 'torrent_stats', stats)
    body = client.get('/api/vps/usage', headers=auth).get_json()
    assert body['traffic'] == {'downloaded': 300, 'uploaded': 100}
    by_client = {c['client']: c for c in body['clients']}
    assert by_client['transmission']['downloaded'] == 300
    assert by_client['qbittorrent']['error'] == 'Cannot reach qBittorrent'


def test_dot_entries_are_dropped_from_both_listings(client, db, connected, sftp):
    sftp.tree['/home6/tester/downloads']['.'] = None
    sftp.tree['/home6/tester/downloads']['..'] = None
    body = client.post('/api/settings/vps/browse', headers=connected,
                       json={'path': '/home6/tester/downloads'}).get_json()
    assert [e['name'] for e in body['entries']] == ['Show.S01', 'movie.mkv']
    client.post('/api/settings/vps/folders', headers=connected, json={'path': '/home6/tester/downloads'})
    group = client.get('/api/vps/files', headers=connected).get_json()['folders'][0]
    assert [e['name'] for e in group['entries']] == ['Show.S01', 'movie.mkv']


def test_local_browse_reports_an_unexpected_failure_as_500(client, db, auth, tmp_path, monkeypatch):
    import os
    monkeypatch.setattr(os, 'scandir', lambda p: (_ for _ in ()).throw(RuntimeError('boom')))
    res = client.post('/api/settings/local/browse', headers=auth, json={'path': str(tmp_path)})
    assert res.status_code == 500 and 'boom' in res.get_json()['error']

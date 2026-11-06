"""The torrent routes' remaining surface: the connection test, the Telegram
default, the per-call error mapping (a client that answers with an error is a
502, bad input a 400) and the on-disk match without a configured local_dir.
The dispatchers are stubbed at the route module's boundary."""
import io

import pytest

from backend.web_app.routes import torrent as troute


@pytest.fixture(autouse=True)
def no_live_clients(monkeypatch):
    monkeypatch.setattr(troute, 'apply_torrent_session', lambda cfg: None)


@pytest.fixture
def configured(client, db, auth):
    for cl, url in (('transmission', 'http://box:9091'), ('qbittorrent', 'http://box:8080')):
        res = client.post('/api/settings/torrent', headers=auth,
                          json={'client': cl, 'url': url, 'username': 'u',
                                'password': 'secret', 'download_dir': '/dl'})
        assert res.status_code == 200, res.get_data(as_text=True)
    return auth


def raiser(exc):
    def _raise(*a, **k):
        raise exc
    return _raise


# --- config save -------------------------------------------------------------

def test_a_save_warns_when_the_temp_dir_cannot_be_applied(client, db, auth, monkeypatch):
    monkeypatch.setattr(troute, 'apply_torrent_session', raiser(ValueError('Cannot reach Transmission')))
    res = client.post('/api/settings/torrent', headers=auth,
                      json={'client': 'transmission', 'url': 'http://box:9091', 'incomplete_dir': '/inc'})
    assert res.status_code == 200
    body = res.get_json()
    assert body['status'] == 'saved' and 'could not apply the temp folder' in body['warning']
    assert body['configured'] is True and body['incomplete_dir'] == '/inc'


def test_a_save_can_set_the_flags_and_local_dir_in_one_go(client, db, auth):
    res = client.post('/api/settings/torrent', headers=auth,
                      json={'client': 'qbittorrent', 'url': 'http://box:8080/', 'local_dir': '/mnt/tv',
                            'stop_on_complete': False, 'hidden': True})
    body = res.get_json()
    assert body['local_dir'] == '/mnt/tv' and body['stop_on_complete'] is False and body['hidden'] is True
    assert body['url'] == 'http://box:8080'


def test_the_telegram_default_is_not_overridden_by_a_second_client(client, db, configured):
    body = client.get('/api/settings/torrent', headers=configured).get_json()
    assert body['telegram_default'] == 'transmission'       # the first one saved


def test_deleting_the_default_client_clears_the_telegram_default(client, db, configured):
    client.delete('/api/settings/torrent?client=transmission', headers=configured)
    body = client.get('/api/settings/torrent', headers=configured).get_json()
    assert body['telegram_default'] is None
    assert client.delete('/api/settings/torrent?client=deluge', headers=configured).status_code == 400


@pytest.mark.parametrize('path,body', [
    ('/api/settings/torrent/stop-on-complete', {'client': 'deluge', 'enabled': True}),
    ('/api/settings/torrent/hidden', {'client': 'deluge', 'hidden': True}),
    ('/api/settings/torrent/telegram-default', {'client': 'deluge'}),
    ('/api/settings/torrent/test', {'client': 'deluge', 'url': 'http://x'}),
    ('/api/torrent/add', {'client': 'deluge', 'magnet': 'magnet:?xt=urn:btih:a'}),
    ('/api/torrent/rename', {'client': 'deluge', 'hash': 'a', 'name': 'x'}),
    ('/api/torrent/files/priority', {'client': 'deluge', 'hash': 'a', 'indices': [0], 'priority': 'high'}),
    ('/api/torrent/action', {'client': 'deluge', 'action': 'stop', 'hashes': ['a']}),
])
def test_an_unknown_client_is_refused_everywhere(client, db, configured, path, body):
    res = client.post(path, headers=configured, json=body)
    assert res.status_code == 400
    assert 'Unknown torrent client' in res.get_json()['error']


def test_unknown_client_on_the_get_routes(client, db, configured):
    assert client.get('/api/torrent/list?client=deluge', headers=configured).status_code == 400


# --- telegram default ---------------------------------------------------------

def test_telegram_default_can_be_switched_and_cleared(client, db, configured):
    res = client.post('/api/settings/torrent/telegram-default', headers=configured,
                      json={'client': 'qbittorrent'})
    assert res.get_json() == {'status': 'ok', 'telegram_default': 'qbittorrent'}
    assert client.get('/api/settings/torrent', headers=configured).get_json()['telegram_default'] == 'qbittorrent'
    for cleared in (None, '', 'none'):
        res = client.post('/api/settings/torrent/telegram-default', headers=configured, json={'client': cleared})
        assert res.get_json()['telegram_default'] is None


def test_telegram_default_must_point_at_a_configured_client(client, db, auth):
    res = client.post('/api/settings/torrent/telegram-default', headers=auth, json={'client': 'qbittorrent'})
    assert res.status_code == 400 and 'not configured' in res.get_json()['error']


# --- test connection ------------------------------------------------------------

def test_test_connection_uses_the_posted_values(client, db, auth, monkeypatch):
    seen = {}

    def fake_test(cl, config=None):
        seen.update(config)
        return 'Connected to Transmission 4.0'
    monkeypatch.setattr(troute, 'torrent_test', fake_test)
    res = client.post('/api/settings/torrent/test', headers=auth,
                      json={'client': 'transmission', 'url': 'http://box:9091', 'username': 'u', 'password': 'p'})
    assert res.get_json() == {'success': True, 'message': 'Connected to Transmission 4.0'}
    assert seen['url'] == 'http://box:9091/transmission/rpc' and seen['password'] == 'p'


def test_test_connection_falls_back_to_the_saved_password(client, db, configured, monkeypatch):
    seen = {}
    monkeypatch.setattr(troute, 'torrent_test', lambda cl, config=None: seen.update(config) or 'ok')
    client.post('/api/settings/torrent/test', headers=configured,
                json={'client': 'qbittorrent', 'url': 'http://box:8080/', 'username': 'u'})
    assert seen['password'] == 'secret' and seen['url'] == 'http://box:8080'


def test_test_connection_without_a_saved_password_sends_an_empty_one(client, db, auth, monkeypatch):
    seen = {}
    monkeypatch.setattr(troute, 'torrent_test', lambda cl, config=None: seen.update(config) or 'ok')
    client.post('/api/settings/torrent/test', headers=auth,
                json={'client': 'qbittorrent', 'url': 'http://box:8080'})
    assert seen['password'] == ''


def test_test_connection_reports_a_failure_as_a_200_with_success_false(client, db, auth, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_test', raiser(ValueError('Cannot reach qBittorrent: refused')))
    res = client.post('/api/settings/torrent/test', headers=auth,
                      json={'client': 'qbittorrent', 'url': 'http://box:8080'})
    assert res.status_code == 200
    assert res.get_json() == {'success': False, 'error': 'Cannot reach qBittorrent: refused'}


def test_test_connection_refuses_a_bad_url(client, db, auth):
    res = client.post('/api/settings/torrent/test', headers=auth, json={'client': 'qbittorrent', 'url': 'box'})
    assert res.status_code == 400 and res.get_json()['success'] is False


# --- add --------------------------------------------------------------------------

def test_adding_a_magnet_the_client_rejects_is_a_502(client, db, configured, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_add_magnet', raiser(ValueError('Transmission error: invalid')))
    res = client.post('/api/torrent/add', headers=configured,
                      json={'client': 'transmission', 'magnet': 'magnet:?xt=urn:btih:abc', 'download_dir': '/w'})
    assert res.status_code == 502 and 'invalid' in res.get_json()['error']


def test_adding_a_magnet_passes_the_download_dir_through(client, db, configured, monkeypatch):
    seen = {}
    monkeypatch.setattr(troute, 'torrent_add_magnet',
                        lambda c, m, download_dir=None: seen.update(c=c, dir=download_dir) or {'name': None, 'hash': 'h'})
    res = client.post('/api/torrent/add', headers=configured,
                      json={'client': 'transmission', 'magnet': 'MAGNET:?xt=urn:btih:abc', 'download_dir': ' /w '})
    assert res.get_json() == {'status': 'added', 'name': None, 'hash': 'h', 'download_dir': '/w'}
    assert seen == {'c': 'transmission', 'dir': '/w'}


def test_add_file_validates_the_upload(client, db, configured, monkeypatch):
    res = client.post('/api/torrent/add-file', headers=configured, data={'client': 'deluge'},
                      content_type='multipart/form-data')
    assert res.status_code == 400 and 'Unknown' in res.get_json()['error']
    res = client.post('/api/torrent/add-file', headers=configured, data={'client': 'qbittorrent'},
                      content_type='multipart/form-data')
    assert res.status_code == 400 and 'required' in res.get_json()['error']
    monkeypatch.setattr(troute, 'torrent_add_file', raiser(ValueError('qBittorrent error: HTTP 415')))
    res = client.post('/api/torrent/add-file', headers=configured,
                      data={'client': 'qbittorrent', 'file': (io.BytesIO(b'd4:infod4:name1:aee'), 'x.torrent')},
                      content_type='multipart/form-data')
    assert res.status_code == 502 and 'HTTP 415' in res.get_json()['error']


def test_add_file_reports_a_duplicate(client, db, configured, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_add_file',
                        lambda c, d, download_dir=None: {'name': 'a', 'hash': 'h', 'duplicate': True})
    res = client.post('/api/torrent/add-file', headers=configured,
                      data={'client': 'qbittorrent', 'file': (io.BytesIO(b'd4:infod4:name1:aee'), 'x.torrent')},
                      content_type='multipart/form-data')
    assert res.get_json()['status'] == 'duplicate' and res.get_json()['download_dir'] is None


# --- list / details error mapping -------------------------------------------------

def test_a_client_that_fails_to_list_is_a_502(client, db, configured, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_list', raiser(ValueError('Cannot reach Transmission')))
    res = client.get('/api/torrent/list?client=transmission', headers=configured)
    assert res.status_code == 502
    assert res.get_json() == {'configured': True, 'error': 'Cannot reach Transmission'}


def test_a_client_that_fails_details_is_a_502(client, db, configured, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_details', raiser(ValueError('Cannot reach qBittorrent')))
    res = client.get('/api/torrent/details?client=qbittorrent&hash=abc', headers=configured)
    assert res.status_code == 502


def test_listing_ignores_non_vps_downloads_and_the_unmatched(client, db, configured, monkeypatch):
    db.add_download(file='Show', status='done', downloaded_from='youtube.com', message_id='m-y',
                    url='https://youtube.com/x', progress=100)
    db.add_download(file='Show', status='done', downloaded_from='vps', message_id='m-nourl',
                    url=None, progress=100)
    monkeypatch.setattr(troute, 'torrent_list', lambda c: [
        {'hash': 'h1', 'name': 'Show', 'download_dir': '/dl', 'percent_done': 100,
         'status': 'completed', 'total_size': 10}])
    body = client.get('/api/torrent/list?client=transmission', headers=configured).get_json()
    assert body['torrents'][0]['downlee'] is None


def test_listing_matches_bytes_on_disk_under_the_vps_spec_folder(client, db, configured, monkeypatch):
    """Without a local_dir the pull lands under the 'vps' spec (default
    DOWNLOAD_DIR/VPS); a folder there holding the torrent's bytes counts."""
    from backend.config import DOWNLOAD_DIR
    folder = DOWNLOAD_DIR / 'VPS' / 'Whole'
    (folder / 'sub').mkdir(parents=True, exist_ok=True)
    (folder / 'a.mkv').write_bytes(b'x' * 6)
    (folder / 'sub' / 'b.mkv').write_bytes(b'y' * 4)
    monkeypatch.setattr(troute, 'torrent_list', lambda c: [
        {'hash': 'h1', 'name': 'Whole', 'download_dir': '/dl', 'percent_done': 100,
         'status': 'completed', 'total_size': 10},
        {'hash': 'h2', 'name': 'Whole', 'download_dir': '/dl', 'percent_done': 100,
         'status': 'completed', 'total_size': 11},
        {'hash': 'h3', 'name': 'Whole', 'download_dir': '/dl', 'percent_done': 100,
         'status': 'completed', 'total_size': 0},
        {'hash': 'h4', 'name': '', 'download_dir': '/dl', 'percent_done': 100,
         'status': 'completed', 'total_size': 10},
    ])
    body = client.get('/api/torrent/list?client=transmission', headers=configured).get_json()
    by_hash = {t['hash']: t['downlee'] for t in body['torrents']}
    assert by_hash['h1'] == {'id': None, 'message_id': None, 'status': 'done', 'progress': 100, 'on_disk': True}
    assert by_hash['h2'] is None     # one byte short
    assert by_hash['h3'] is None     # no size to compare against
    assert by_hash['h4'] is None     # nothing to look for


# --- per-file pulls -------------------------------------------------------------

def _details(**over):
    d = {
        'torrent': {'hash': 'h1', 'name': 'Show', 'download_dir': '/dl', 'percent_done': 100, 'status': 'completed'},
        'files': [{'index': 0, 'path': 'Show/e01.mkv', 'size': 10, 'percent_done': 100, 'wanted': True}],
        'priorities': [], 'rename_renames_folder': False, 'info': {},
    }
    d.update(over)
    return d


class _Sftp:
    def __init__(self, present):
        self.present = present

    def stat(self, path):
        if path not in self.present:
            raise IOError(2, 'No such file')


class _Ssh:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


@pytest.fixture
def pull(app, monkeypatch):
    class Vps:
        def __init__(self):
            self.calls = []
            self.error = None

        def start_download(self, remote, size=0, dest=None):
            self.calls.append((remote, size, dest))
            return {'error': self.error} if self.error else {'id': 1, 'message_id': 'm-1'}

    app.vps_downloader = Vps()
    ssh = _Ssh()
    monkeypatch.setattr(troute, 'open_vps_sftp', lambda: (ssh, _Sftp({'/dl/Show/e01.mkv'})))
    monkeypatch.setattr('backend.web_app.torrent.torrent_telegram_dirs',
                        lambda c, cfg=None: ('/dl/telegram/downloads', '/dl/telegram/progress'))
    monkeypatch.setattr(troute, 'torrent_details', lambda c, h: _details())
    app.vps_downloader.ssh = ssh
    return app.vps_downloader


def test_a_file_pull_needs_the_downloader(client, db, configured):
    res = client.post('/api/torrent/files/download', headers=configured,
                      json={'client': 'qbittorrent', 'hash': 'h1', 'indices': [0]})
    assert res.status_code == 503


@pytest.mark.parametrize('body', [
    {'client': 'deluge', 'hash': 'h1', 'indices': [0]},
    {'client': 'qbittorrent', 'indices': [0]},                       # no hash
    {'client': 'qbittorrent', 'hash': 'h1', 'indices': []},
    {'client': 'qbittorrent', 'hash': 'h1', 'indices': 'all'},
    {'client': 'qbittorrent', 'hash': 'h1', 'indices': [True]},
    {'client': 'qbittorrent', 'hash': 'h1', 'indices': [-1]},
])
def test_a_file_pull_validates_its_input(client, db, configured, pull, body):
    res = client.post('/api/torrent/files/download', headers=configured, json=body)
    assert res.status_code == 400
    assert pull.calls == []


def test_a_file_pull_maps_client_failures(client, db, configured, pull, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_details', raiser(ValueError('Cannot reach qBittorrent')))
    res = client.post('/api/torrent/files/download', headers=configured,
                      json={'client': 'qbittorrent', 'hash': 'h1', 'indices': [0]})
    assert res.status_code == 502
    monkeypatch.setattr(troute, 'torrent_details', lambda c, h: None)
    res = client.post('/api/torrent/files/download', headers=configured,
                      json={'client': 'qbittorrent', 'hash': 'h1', 'indices': [0]})
    assert res.status_code == 404


def test_a_file_pull_with_the_vps_unreachable_is_a_502(client, db, configured, pull, monkeypatch):
    monkeypatch.setattr(troute, 'open_vps_sftp', raiser(OSError('Connection timed out')))
    res = client.post('/api/torrent/files/download', headers=configured,
                      json={'client': 'qbittorrent', 'hash': 'h1', 'indices': [0]})
    assert res.status_code == 502 and "Couldn't reach the VPS" in res.get_json()['error']
    assert pull.calls == []


def test_a_file_pull_the_handler_refuses_is_reported_per_file(client, db, configured, pull):
    pull.error = 'Already downloading'
    res = client.post('/api/torrent/files/download', headers=configured,
                      json={'client': 'qbittorrent', 'hash': 'h1', 'indices': [0, 0]})
    assert res.status_code == 400
    assert res.get_json() == {'started': [], 'skipped': [],
                              'errors': [{'index': 0, 'error': 'Already downloading'}]}
    assert len(pull.calls) == 1            # duplicates in `indices` collapse
    assert pull.ssh.closed is True


def test_a_file_pull_lands_under_the_vps_spec_folder_without_a_local_dir(client, db, configured, pull):
    from backend.config import DOWNLOAD_DIR
    res = client.post('/api/torrent/files/download', headers=configured,
                      json={'client': 'transmission', 'hash': 'H1', 'indices': [0]})
    assert res.status_code == 200
    assert pull.calls == [('/dl/Show/e01.mkv', 10, str(DOWNLOAD_DIR / 'VPS' / 'Show'))]


# --- rename / priority / action error mapping -------------------------------------

def test_rename_maps_a_client_failure_to_502(client, db, configured, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_rename', raiser(ValueError('That torrent is no longer in the client')))
    res = client.post('/api/torrent/rename', headers=configured,
                      json={'client': 'transmission', 'hash': 'A', 'name': 'x'})
    assert res.status_code == 502


def test_rename_succeeds_and_lowercases_the_hash(client, db, configured, monkeypatch):
    seen = []
    monkeypatch.setattr(troute, 'torrent_rename', lambda *a, **k: seen.append((a, k)))
    res = client.post('/api/torrent/rename', headers=configured,
                      json={'client': 'qbittorrent', 'hash': 'ABC', 'name': 'new.mkv', 'path': 'Show/old.mkv'})
    assert res.get_json() == {'status': 'ok'}
    assert seen == [(('qbittorrent', 'abc', 'new.mkv'), {'path': 'Show/old.mkv'})]


def test_priority_distinguishes_a_missing_level_from_a_client_failure(client, db, configured, monkeypatch):
    """A level the client lacks is the caller's mistake (400); the client
    refusing is upstream trouble (502). The real dispatcher raises the first."""
    res = client.post('/api/torrent/files/priority', headers=configured,
                      json={'client': 'transmission', 'hash': 'a', 'indices': [0], 'priority': 'max'})
    assert res.status_code == 400 and "no file priority 'max'" in res.get_json()['error']
    res = client.post('/api/torrent/files/priority', headers=configured,
                      json={'client': 'qbittorrent', 'hash': 'a', 'indices': [0], 'priority': 'low'})
    assert res.status_code == 400
    monkeypatch.setattr(troute, 'torrent_set_file_priority', raiser(ValueError('Cannot reach qBittorrent')))
    res = client.post('/api/torrent/files/priority', headers=configured,
                      json={'client': 'qbittorrent', 'hash': 'a', 'indices': [0], 'priority': 'max'})
    assert res.status_code == 502


def test_action_maps_a_client_failure_to_502(client, db, configured, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_control', raiser(ValueError('Transmission returned HTTP 500')))
    res = client.post('/api/torrent/action', headers=configured,
                      json={'client': 'transmission', 'action': 'start', 'hashes': ['a']})
    assert res.status_code == 502 and 'HTTP 500' in res.get_json()['error']


def test_action_coerces_hashes_to_strings(client, db, configured, monkeypatch):
    seen = []
    monkeypatch.setattr(troute, 'torrent_control', lambda c, a, h, d=False: seen.append(h))
    res = client.post('/api/torrent/action', headers=configured,
                      json={'client': 'transmission', 'action': 'start', 'ids': [12, 'abc']})
    assert res.get_json() == {'status': 'ok', 'action': 'start', 'hashes': ['12', 'abc']}
    assert seen == [['12', 'abc']]


def test_listing_matches_a_single_file_torrent_and_skips_a_dangling_link(
        client, db, configured, monkeypatch):
    from backend.config import DOWNLOAD_DIR
    base = DOWNLOAD_DIR / 'VPS'
    base.mkdir(parents=True, exist_ok=True)
    (base / 'Single.mkv').write_bytes(b'x' * 10)
    folder = base / 'Linked'
    folder.mkdir(exist_ok=True)
    (folder / 'a.mkv').write_bytes(b'x' * 10)
    (folder / 'gone').symlink_to(base / 'does-not-exist')      # os.walk lists it, getsize fails
    monkeypatch.setattr(troute, 'torrent_list', lambda c: [
        {'hash': 'h1', 'name': 'Single.mkv', 'download_dir': '/dl', 'percent_done': 100,
         'status': 'completed', 'total_size': 10},
        {'hash': 'h2', 'name': 'Linked', 'download_dir': '/dl', 'percent_done': 100,
         'status': 'completed', 'total_size': 10},
    ])
    body = client.get('/api/torrent/list?client=transmission', headers=configured).get_json()
    assert all(t['downlee']['on_disk'] for t in body['torrents'])

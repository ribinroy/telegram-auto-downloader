"""Torrent client settings and control. Nothing here reaches a real client:
the dispatchers are stubbed at the module boundary."""
import pytest

from backend.web_app.routes import torrent as troute


@pytest.fixture
def configured(client, db, auth):
    """Save both clients through the real route, so encryption at rest and the
    nested config layout are exercised rather than hand-written."""
    for cl, url in (('transmission', 'http://box:9091'),
                    ('qbittorrent', 'http://box:8080')):
        res = client.post('/api/settings/torrent', headers=auth,
                          json={'client': cl, 'url': url, 'username': 'u',
                                'password': 'secret', 'download_dir': '/dl'})
        assert res.status_code == 200, res.get_data(as_text=True)
    return auth


@pytest.fixture(autouse=True)
def no_live_clients(monkeypatch):
    """apply_torrent_session is best-effort on save; keep it off the network."""
    monkeypatch.setattr(troute, 'apply_torrent_session', lambda cfg: None)


# --- config ---------------------------------------------------------------

def test_config_starts_empty(client, db, auth):
    body = client.get('/api/settings/torrent', headers=auth).get_json()
    assert body['transmission']['configured'] is False
    assert body['qbittorrent']['configured'] is False
    assert body['telegram_default'] is None


def test_saving_a_client_never_echoes_the_password(client, db, configured):
    body = client.get('/api/settings/torrent', headers=configured).get_json()
    assert body['transmission']['has_password'] is True
    assert 'password' not in body['transmission']
    assert 'secret' not in str(body)


def test_a_transmission_url_is_normalized_to_the_rpc_endpoint(client, db, configured):
    body = client.get('/api/settings/torrent', headers=configured).get_json()
    assert body['transmission']['url'].endswith('/transmission/rpc')
    # qBittorrent keeps its base WebUI URL.
    assert body['qbittorrent']['url'] == 'http://box:8080'


def test_a_non_http_url_is_refused(client, db, auth):
    res = client.post('/api/settings/torrent', headers=auth,
                      json={'client': 'transmission', 'url': 'ftp://box'})
    assert res.status_code == 400


def test_an_unknown_client_is_refused(client, db, auth):
    res = client.post('/api/settings/torrent', headers=auth,
                      json={'client': 'deluge', 'url': 'http://box'})
    assert res.status_code == 400


def test_the_first_client_becomes_the_telegram_default(client, db, auth):
    client.post('/api/settings/torrent', headers=auth,
                json={'client': 'qbittorrent', 'url': 'http://box:8080'})
    body = client.get('/api/settings/torrent', headers=auth).get_json()
    assert body['telegram_default'] == 'qbittorrent'


def test_deleting_a_client_clears_it(client, db, configured):
    assert client.delete('/api/settings/torrent?client=transmission',
                         headers=configured).status_code == 200
    body = client.get('/api/settings/torrent', headers=configured).get_json()
    assert body['transmission']['configured'] is False
    assert body['qbittorrent']['configured'] is True


# --- stop on complete -----------------------------------------------------

def test_stop_on_complete_defaults_to_on(client, db, configured):
    body = client.get('/api/settings/torrent', headers=configured).get_json()
    assert body['transmission']['stop_on_complete'] is True


def test_the_toggle_persists(client, db, configured):
    res = client.post('/api/settings/torrent/stop-on-complete', headers=configured,
                      json={'client': 'transmission', 'enabled': False})
    assert res.status_code == 200
    body = client.get('/api/settings/torrent', headers=configured).get_json()
    assert body['transmission']['stop_on_complete'] is False
    assert body['qbittorrent']['stop_on_complete'] is True     # untouched


def test_a_full_save_carries_the_toggle_over(client, db, configured):
    """A save rewrites the sub-config; the flag must not silently reset."""
    client.post('/api/settings/torrent/stop-on-complete', headers=configured,
                json={'client': 'transmission', 'enabled': False})
    client.post('/api/settings/torrent', headers=configured,
                json={'client': 'transmission', 'url': 'http://box:9091'})
    body = client.get('/api/settings/torrent', headers=configured).get_json()
    assert body['transmission']['stop_on_complete'] is False


def test_the_toggle_refuses_an_unconfigured_client(client, db, auth):
    res = client.post('/api/settings/torrent/stop-on-complete', headers=auth,
                      json={'client': 'transmission', 'enabled': True})
    assert res.status_code == 400


# --- actions --------------------------------------------------------------

@pytest.fixture
def captured(monkeypatch):
    calls = []
    monkeypatch.setattr(troute, 'torrent_control',
                        lambda c, a, h, d=False: calls.append((c, a, tuple(h), d)))
    return calls


@pytest.mark.parametrize('action', ['start', 'force-start', 'stop', 'remove', 'verify'])
def test_every_supported_action_is_dispatched(client, db, configured, captured, action):
    res = client.post('/api/torrent/action', headers=configured,
                      json={'client': 'qbittorrent', 'action': action, 'hashes': ['abc']})
    assert res.status_code == 200
    assert captured == [('qbittorrent', action, ('abc',), False)]


def test_an_unknown_action_is_refused(client, db, configured, captured):
    res = client.post('/api/torrent/action', headers=configured,
                      json={'client': 'qbittorrent', 'action': 'destroy', 'hashes': ['a']})
    assert res.status_code == 400
    assert captured == []


def test_hashes_must_be_a_non_empty_list(client, db, configured, captured):
    for hashes in ([], 'abc', None):
        res = client.post('/api/torrent/action', headers=configured,
                          json={'client': 'qbittorrent', 'action': 'stop', 'hashes': hashes})
        assert res.status_code == 400
    assert captured == []


def test_legacy_ids_are_still_accepted_as_hashes(client, db, configured, captured):
    res = client.post('/api/torrent/action', headers=configured,
                      json={'client': 'qbittorrent', 'action': 'stop', 'ids': ['abc']})
    assert res.status_code == 200
    assert captured[0][2] == ('abc',)


def test_delete_data_is_passed_through(client, db, configured, captured):
    client.post('/api/torrent/action', headers=configured,
                json={'client': 'qbittorrent', 'action': 'remove',
                      'hashes': ['abc'], 'delete_data': True})
    assert captured[0][3] is True


# --- add ------------------------------------------------------------------

def test_a_non_magnet_is_refused(client, db, configured):
    res = client.post('/api/torrent/add', headers=configured,
                      json={'client': 'qbittorrent', 'magnet': 'https://example.com/x'})
    assert res.status_code == 400


def test_a_magnet_is_dispatched_and_duplicates_are_reported(
        client, db, configured, monkeypatch):
    monkeypatch.setattr(troute, 'torrent_add_magnet',
                        lambda c, m, download_dir=None: {'name': 'X', 'hash': 'h', 'duplicate': True})
    res = client.post('/api/torrent/add', headers=configured,
                      json={'client': 'qbittorrent', 'magnet': 'magnet:?xt=urn:btih:abc'})
    assert res.get_json()['status'] == 'duplicate'


def test_an_empty_torrent_file_is_refused(client, db, configured):
    import io
    res = client.post('/api/torrent/add-file', headers=configured,
                      data={'client': 'qbittorrent', 'file': (io.BytesIO(b''), 'x.torrent')},
                      content_type='multipart/form-data')
    assert res.status_code == 400


def test_a_torrent_file_upload_is_dispatched(client, db, configured, monkeypatch):
    import io
    seen = {}

    def fake_add(cl, data, download_dir=None):
        seen['client'], seen['bytes'], seen['dir'] = cl, data, download_dir
        return {'name': 'Ubuntu', 'hash': 'h', 'duplicate': False}

    monkeypatch.setattr(troute, 'torrent_add_file', fake_add)
    res = client.post('/api/torrent/add-file', headers=configured,
                      data={'client': 'qbittorrent', 'download_dir': '/watch',
                            'file': (io.BytesIO(b'd4:infod4:name1:ae'), 'x.torrent')},
                      content_type='multipart/form-data')
    assert res.status_code == 200
    assert res.get_json() == {'status': 'added', 'name': 'Ubuntu',
                              'hash': 'h', 'download_dir': '/watch'}
    assert seen['bytes'] == b'd4:infod4:name1:ae'


# --- list -----------------------------------------------------------------

def test_listing_an_unconfigured_client_is_not_an_error(client, db, auth):
    body = client.get('/api/torrent/list?client=transmission', headers=auth).get_json()
    assert body == {'configured': False, 'torrents': []}


def test_listing_annotates_each_torrent_with_its_downlee_transfer(
        client, db, configured, monkeypatch):
    db.add_download(file='Show.S01', status='done', downloaded_from='vps',
                    message_id='m-1', url='/dl/Show.S01', progress=100)
    monkeypatch.setattr(troute, 'torrent_list', lambda c: [
        {'hash': 'h1', 'name': 'Show.S01', 'download_dir': '/dl',
         'percent_done': 100, 'status': 'completed'},
        {'hash': 'h2', 'name': 'Other', 'download_dir': '/dl',
         'percent_done': 50, 'status': 'downloading'},
    ])
    body = client.get('/api/torrent/list?client=qbittorrent', headers=configured).get_json()
    assert body['configured'] is True
    by_hash = {t['hash']: t for t in body['torrents']}
    assert by_hash['h1']['downlee']['message_id'] == 'm-1'
    assert by_hash['h2']['downlee'] is None

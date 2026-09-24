"""The file explorer's HTTP surface, both disks: local paths go to files.py,
`vps:` paths to remote_files.py, and the write routes refuse the remote side."""
import contextlib
import pytest


@pytest.fixture
def remote(monkeypatch, fake_sftp):
    """Make the VPS look configured, with every SFTP call hitting the fake."""
    from backend import remote_files as rfs
    creds = {'host': 'box.example', 'port': 22, 'username': 'tester', 'password': 'p'}
    monkeypatch.setattr(rfs, 'load_vps_credentials', lambda: creds)

    class FakeClient:
        def exec_command(self, cmd, timeout=None):
            blank = type('S', (), {'read': lambda self: b''})()
            return None, blank, blank

    @contextlib.contextmanager
    def session(timeout=15):
        yield FakeClient(), fake_sftp

    monkeypatch.setattr(rfs, 'vps_session', session)
    rfs._quota_cache.update(at=0.0, usage=None)
    return fake_sftp


# --- roots ----------------------------------------------------------------

def test_roots_are_grouped(client, db, auth):
    body = client.get('/api/files/roots', headers=auth).get_json()
    assert body['home'] and body['default']
    assert {r['group'] for r in body['roots']} <= {'drive', 'folder', 'configured'}


def test_the_vps_appears_as_a_drive_when_configured(client, db, auth, remote):
    roots = client.get('/api/files/roots', headers=auth).get_json()['roots']
    vps = [r for r in roots if r['kind'] == 'vps']
    assert len(vps) == 1
    assert vps[0]['path'] == 'vps:~' and vps[0]['group'] == 'drive'


def test_no_vps_root_when_it_is_not_configured(client, db, auth, monkeypatch):
    from backend import remote_files as rfs
    monkeypatch.setattr(rfs, 'load_vps_credentials', lambda: None)
    roots = client.get('/api/files/roots', headers=auth).get_json()['roots']
    assert not [r for r in roots if r['kind'] == 'vps']


# --- listing --------------------------------------------------------------

def test_listing_a_local_directory(client, db, auth, tmp_tree):
    res = client.post('/api/files/list', headers=auth, json={'path': str(tmp_tree)})
    assert res.status_code == 200
    names = {e['name'] for e in res.get_json()['entries']}
    assert 'Movies' in names and '.hidden' not in names


def test_listing_a_missing_path_is_404(client, db, auth, tmp_tree):
    res = client.post('/api/files/list', headers=auth, json={'path': str(tmp_tree / 'nope')})
    assert res.status_code == 404


def test_a_vps_path_is_routed_to_sftp(client, db, auth, remote):
    res = client.post('/api/files/list', headers=auth, json={'path': 'vps:~'})
    assert res.status_code == 200
    body = res.get_json()
    assert body['path'] == 'vps:/home6/tester'
    assert body['remote'] is True and body['writable'] is False
    assert all(e['path'].startswith('vps:') for e in body['entries'])


def test_an_unreadable_remote_directory_is_403(client, db, auth, remote):
    res = client.post('/api/files/list', headers=auth, json={'path': 'vps:/home6'})
    assert res.status_code == 403


def test_listing_the_vps_when_it_is_not_configured_is_a_clean_400(
        client, db, auth, monkeypatch):
    from backend import remote_files as rfs
    monkeypatch.setattr(rfs, 'load_vps_credentials', lambda: None)
    res = client.post('/api/files/list', headers=auth, json={'path': 'vps:~'})
    assert res.status_code == 400
    assert 'configured' in res.get_json()['error']


# --- write routes ---------------------------------------------------------

def test_mkdir_and_rename_and_delete_round_trip(client, db, auth, tmp_tree):
    made = client.post('/api/files/mkdir', headers=auth,
                       json={'path': str(tmp_tree), 'name': 'New'})
    assert made.status_code == 200

    renamed = client.post('/api/files/rename', headers=auth,
                          json={'path': str(tmp_tree / 'New'), 'name': 'Renamed'})
    assert renamed.status_code == 200
    assert (tmp_tree / 'Renamed').is_dir()

    gone = client.post('/api/files/delete', headers=auth,
                       json={'paths': [str(tmp_tree / 'Renamed')], 'permanent': True})
    assert gone.status_code == 200
    assert not (tmp_tree / 'Renamed').exists()


def test_writing_to_an_os_directory_is_refused(client, db, auth):
    res = client.post('/api/files/mkdir', headers=auth, json={'path': '/etc', 'name': 'x'})
    assert res.status_code == 403


@pytest.mark.parametrize('path,name', [
    ('/api/files/mkdir', 'Creating folders'),
    ('/api/files/rename', 'Renaming'),
])
def test_remote_write_routes_refuse_with_a_reason(client, db, auth, remote, path, name):
    res = client.post(path, headers=auth,
                      json={'path': 'vps:/home6/tester', 'name': 'x'})
    assert res.status_code == 400
    assert 'VPS' in res.get_json()['error']


def test_a_remote_delete_is_reported_as_permanent(client, db, auth, remote):
    res = client.post('/api/files/delete', headers=auth,
                      json={'paths': ['vps:/home6/tester/notes.txt']})
    assert res.status_code == 200
    assert res.get_json()['permanent'] is True


def test_a_mixed_local_and_remote_selection_is_refused(client, db, auth, remote, tmp_tree):
    res = client.post('/api/files/delete', headers=auth,
                      json={'paths': ['vps:/home6/tester/notes.txt', str(tmp_tree / 'notes.txt')]})
    assert res.status_code == 400
    assert (tmp_tree / 'notes.txt').exists()


def test_delete_requires_paths(client, db, auth):
    assert client.post('/api/files/delete', headers=auth, json={}).status_code == 400


# --- transfer -------------------------------------------------------------

def test_a_local_copy_works(client, db, auth, tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    res = client.post('/api/files/transfer', headers=auth,
                      json={'paths': [str(tmp_tree / 'notes.txt')], 'dest': str(dest)})
    assert res.status_code == 200
    assert (dest / 'notes.txt').exists()


def test_pulling_from_the_vps_needs_the_downloader(client, db, auth, remote, tmp_tree):
    """The app fixture leaves vps_downloader unwired, so the route must say so
    rather than pretending the transfer started."""
    res = client.post('/api/files/transfer', headers=auth,
                      json={'paths': ['vps:/home6/tester/notes.txt'], 'dest': str(tmp_tree)})
    assert res.status_code == 503


def test_pulling_from_the_vps_hands_off_to_the_sftp_downloader(
        client, app, db, auth, remote, tmp_tree):
    started = []

    class FakeDownloader:
        def start_download(self, path, dest=None):
            started.append((path, dest))
            return {'message_id': 'mid-1'}

    app.vps_downloader = FakeDownloader()
    res = client.post('/api/files/transfer', headers=auth,
                      json={'paths': ['vps:/home6/tester/notes.txt'], 'dest': str(tmp_tree)})
    assert res.status_code == 200
    body = res.get_json()
    assert body['download'] is True
    assert body['results'][0]['message_id'] == 'mid-1'
    # The prefix is stripped before it reaches the SFTP layer.
    assert started == [('/home6/tester/notes.txt', str(tmp_tree))]


def test_moving_off_the_vps_is_refused(client, db, auth, remote, tmp_tree):
    res = client.post('/api/files/transfer', headers=auth,
                      json={'paths': ['vps:/home6/tester/notes.txt'],
                            'dest': str(tmp_tree), 'move': True})
    assert res.status_code == 400


def test_copying_onto_the_vps_is_refused(client, db, auth, remote, tmp_tree):
    res = client.post('/api/files/transfer', headers=auth,
                      json={'paths': [str(tmp_tree / 'notes.txt')], 'dest': 'vps:/home6/tester'})
    assert res.status_code == 400


# --- search / size / text -------------------------------------------------

def test_search_local_and_remote(client, db, auth, remote, tmp_tree):
    local = client.post('/api/files/search', headers=auth,
                        json={'path': str(tmp_tree), 'query': 'mkv'})
    assert local.status_code == 200 and local.get_json()['entries']

    far = client.post('/api/files/search', headers=auth,
                      json={'path': 'vps:~', 'query': 'ep01'})
    assert far.status_code == 200
    assert far.get_json()['entries'][0]['path'].startswith('vps:')


def test_search_needs_two_characters(client, db, auth, tmp_tree):
    res = client.post('/api/files/search', headers=auth,
                      json={'path': str(tmp_tree), 'query': 'a'})
    assert res.status_code == 400


def test_size_and_text_preview(client, db, auth, tmp_tree):
    size = client.post('/api/files/size', headers=auth,
                       json={'path': str(tmp_tree / 'Movies')})
    assert size.get_json()['size'] == 30

    text = client.post('/api/files/text', headers=auth,
                       json={'path': str(tmp_tree / 'notes.txt')})
    assert text.get_json()['text'].startswith('hello')


def test_warming_previews_queues_local_files_and_skips_the_vps(
        client, db, auth, tmp_tree, monkeypatch):
    """The grid hands over a whole page at once; remote entries are dropped.

    A vps: preview would mean pulling the file across the internet to make a
    JPEG, so it is skipped here rather than refused - the caller is sending
    whatever it just rendered, which can legitimately mix the two.
    """
    from backend import files as fs
    warmed = []
    monkeypatch.setattr(fs, 'warm_thumbs', lambda paths: warmed.extend(paths) or {'queued': len(paths)})

    res = client.post('/api/files/thumb/warm', headers=auth, json={'paths': [
        str(tmp_tree / 'Movies' / 'a.mkv'), 'vps:/home6/user/b.mkv',
    ]})
    assert res.status_code == 200
    assert warmed == [str(tmp_tree / 'Movies' / 'a.mkv')]


def test_warming_previews_rejects_a_non_list(client, db, auth):
    res = client.post('/api/files/thumb/warm', headers=auth, json={'paths': 'everything'})
    assert res.status_code == 400


def test_thumb_status_skips_remote_paths(client, auth, monkeypatch):
    from backend import files as fs
    seen = []
    monkeypatch.setattr(fs, 'thumb_status', lambda paths: seen.extend(paths) or {})
    res = client.post('/api/files/thumb/status', headers=auth,
                      json={'paths': ['/a.mp4', 'vps:/b.mp4']})
    assert res.status_code == 200 and seen == ['/a.mp4']
    assert client.post('/api/files/thumb/status', headers=auth,
                       json={'paths': 'x'}).status_code == 400

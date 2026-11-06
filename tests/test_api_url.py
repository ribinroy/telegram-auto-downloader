"""URL (yt-dlp) downloads at the HTTP boundary, with the downloader unwired
and with a stub, plus the per-source spec routes' refusals."""
import pytest


class StubYtdlp:
    def __init__(self):
        self.started = []
        self.answer = {'message_id': 'u-1', 'status': 'downloading'}

    def check_url(self, url):
        return {'supported': True, 'title': 'Clip', 'formats': [{'format_id': '22'}], 'url': url}

    def start_download(self, url, loop, **kw):
        self.started.append((url, loop, kw))
        return self.answer


@pytest.fixture
def ytdlp(app):
    stub = StubYtdlp()
    app.ytdlp_downloader = stub
    app.event_loop = object()
    return stub


# --- check ----------------------------------------------------------------------

def test_check_requires_a_url(client, db, auth):
    res = client.post('/api/url/check', headers=auth, json={})
    assert res.status_code == 400 and res.get_json()['error'] == 'URL is required'


def test_check_without_the_downloader_is_a_clear_500(client, db, auth):
    res = client.post('/api/url/check', headers=auth, json={'url': 'https://v/1'})
    assert res.status_code == 500 and 'not available' in res.get_json()['error']


def test_check_returns_the_downloaders_answer(client, db, auth, ytdlp):
    body = client.post('/api/url/check', headers=auth, json={'url': 'https://v/1'}).get_json()
    assert body['supported'] is True and body['formats'] == [{'format_id': '22'}]


# --- download ---------------------------------------------------------------------

def test_download_requires_a_url(client, db, auth, ytdlp):
    assert client.post('/api/url/download', headers=auth, json={}).status_code == 400


def test_download_needs_the_downloader_and_the_loop(app, client, db, auth):
    res = client.post('/api/url/download', headers=auth, json={'url': 'https://v/1'})
    assert res.status_code == 500 and 'not available' in res.get_json()['error']
    app.ytdlp_downloader = StubYtdlp()
    app.event_loop = None
    res = client.post('/api/url/download', headers=auth, json={'url': 'https://v/1'})
    assert res.status_code == 500 and 'Event loop' in res.get_json()['error']


def test_download_passes_the_selection_and_signs_it_with_the_user(app, client, db, auth, ytdlp):
    res = client.post('/api/url/download', headers=auth, json={
        'url': 'https://v/1', 'format_id': '22', 'title': 'Clip', 'ext': 'mp4',
        'filesize': 123, 'resolution': '720p'})
    assert res.status_code == 200 and res.get_json() == ytdlp.answer
    url, loop, kw = ytdlp.started[0]
    assert url == 'https://v/1' and loop is app.event_loop
    assert kw == {'format_id': '22', 'title': 'Clip', 'ext': 'mp4', 'filesize': 123,
                  'resolution': '720p', 'author': 'admin'}


def test_a_refused_download_is_a_400(client, db, auth, ytdlp):
    ytdlp.answer = {'error': 'Unsupported URL'}
    res = client.post('/api/url/download', headers=auth, json={'url': 'https://v/1'})
    assert res.status_code == 400 and res.get_json()['error'] == 'Unsupported URL'


# --- mappings -----------------------------------------------------------------------

def test_mapping_refusals(client, db, auth):
    assert client.post('/api/mappings', headers=auth, json={}).status_code == 400
    assert client.post('/api/mappings', headers=auth, json={'downloaded_from': '  '}).status_code == 400
    first = client.post('/api/mappings', headers=auth, json={'downloaded_from': ' Vimeo.COM '}).get_json()
    assert first['downloaded_from'] == 'vimeo.com'
    dup = client.post('/api/mappings', headers=auth, json={'downloaded_from': 'vimeo.com'})
    assert dup.status_code == 400 and 'already exists' in dup.get_json()['error']
    assert client.put('/api/mappings/99999', headers=auth, json={'folder': '/x'}).status_code == 400
    assert client.delete('/api/mappings/99999', headers=auth).status_code == 404


def test_mapping_update_can_move_the_source_and_blank_fields(client, db, auth):
    row = client.post('/api/mappings', headers=auth,
                      json={'downloaded_from': 'a.com', 'folder': '/a', 'quality': '720p'}).get_json()
    res = client.put(f"/api/mappings/{row['id']}", headers=auth,
                     json={'downloaded_from': 'b.com', 'folder': None, 'ignored': 'x'})
    assert res.status_code == 200
    body = res.get_json()
    assert (body['downloaded_from'], body['folder'], body['quality']) == ('b.com', None, '720p')
    assert db.get_download_type_map('a.com') is None

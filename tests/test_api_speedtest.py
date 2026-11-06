"""The browser <-> server speed test routes: dumb on purpose, and behind auth
(an open bandwidth sink is a gift to anyone who finds the port)."""


def test_routes_need_a_token(client, db):
    assert client.get('/api/speedtest/ping').status_code == 401
    assert client.get('/api/speedtest/download').status_code == 401
    assert client.post('/api/speedtest/upload', data=b'x').status_code == 401


def test_ping_is_uncacheable(client, db, auth):
    res = client.get('/api/speedtest/ping', headers=auth)
    assert res.status_code == 200 and 't' in res.get_json()
    assert 'no-store' in res.headers['Cache-Control']


def test_download_streams_exactly_the_requested_size(client, db, auth):
    size = 3 * 1024 * 1024 + 123
    res = client.get(f'/api/speedtest/download?size={size}', headers=auth)
    assert res.status_code == 200
    assert res.headers['Content-Length'] == str(size)
    assert res.mimetype == 'application/octet-stream'
    assert len(res.get_data()) == size


def test_download_size_is_clamped_and_validated(client, db, auth):
    from backend.web_app.routes.speedtest import CHUNK, MAX_DOWNLOAD
    res = client.get('/api/speedtest/download?size=5', headers=auth)
    assert res.headers['Content-Length'] == str(CHUNK)
    res = client.get(f'/api/speedtest/download?size={MAX_DOWNLOAD * 10}', headers=auth)
    assert res.headers['Content-Length'] == str(MAX_DOWNLOAD)
    assert client.get('/api/speedtest/download?size=lots', headers=auth).status_code == 400


def test_upload_counts_what_arrived(client, db, auth):
    payload = b'\xab' * (2 * 1024 * 1024 + 7)
    res = client.post('/api/speedtest/upload', data=payload, headers=auth,
                      content_type='application/octet-stream')
    assert res.status_code == 200
    body = res.get_json()
    assert body['bytes'] == len(payload) and body['seconds'] >= 0

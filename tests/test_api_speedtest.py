"""The speed tests: browser <-> server routes (dumb on purpose, behind auth -
an open bandwidth sink is a gift to anyone who finds the port), the results
table, and the box's own uplink run with every network call faked."""
import pytest


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


# --- the results table -------------------------------------------------------

def test_browser_results_are_recorded_with_the_device_from_the_request(client, db, auth):
    body = {'ping': {'min': 1.0, 'avg': 2.0, 'max': 3.0, 'jitter': 0.5},
            'download_mbps': 612.4, 'upload_mbps': 310.0,
            'download_bytes': 600_000_000, 'upload_bytes': 300_000_000}
    res = client.post('/api/speedtest/results', json=body, headers={**auth, 'User-Agent': 'TestBrowser/1'})
    assert res.status_code == 201
    row = res.get_json()
    assert row['kind'] == 'browser' and row['client'] == 'TestBrowser/1' and row['ip']
    assert row['ping']['avg'] == 2.0 and row['download_mbps'] == 612.4

    listed = client.get('/api/speedtest/results?kind=browser', headers=auth).get_json()['results']
    assert [r['id'] for r in listed] == [row['id']]
    assert client.get('/api/speedtest/results?kind=internet', headers=auth).get_json()['results'] == []
    assert client.get('/api/speedtest/results?kind=bogus', headers=auth).status_code == 400

    assert client.delete(f"/api/speedtest/results/{row['id']}", headers=auth).status_code == 200
    assert client.delete(f"/api/speedtest/results/{row['id']}", headers=auth).status_code == 404
    assert client.get('/api/speedtest/results', headers=auth).get_json()['results'] == []


def test_a_malformed_browser_result_is_a_400(client, db, auth):
    res = client.post('/api/speedtest/results', json={'download_mbps': 'fast'}, headers=auth)
    assert res.status_code == 400


def test_results_are_newest_first_and_limited(client, db, auth):
    for i in range(5):
        db.add_speed_test('internet', download_mbps=i, upload_mbps=i)
    listed = client.get('/api/speedtest/results?limit=3', headers=auth).get_json()['results']
    assert [r['download_mbps'] for r in listed] == [4, 3, 2]


# --- the box's own uplink ----------------------------------------------------

def test_internet_test_runs_to_a_recorded_result(client, db, auth, monkeypatch):
    import time
    from backend import speedtest as inet

    def fake_download(server, seconds=8, on_progress=None, cancelled=lambda: False):
        samples = [(0.0, 0), (0.2, 2_000_000), (0.5, 10_000_000), (1.5, 60_000_000)]
        if on_progress:
            on_progress(samples)
        return samples

    def fake_upload(server, seconds=8, on_progress=None, cancelled=lambda: False):
        return [(0.0, 0), (0.5, 5_000_000), (1.5, 20_000_000)]

    server = {'name': 'Frankfurt (Test)', 'server': 'https://fra.example/backend'}
    monkeypatch.setattr(inet, 'fetch_servers', lambda: [server])
    monkeypatch.setattr(inet, 'pick_server', lambda servers, cancelled=None: dict(servers[0], probe_ms=9.0))
    monkeypatch.setattr(inet, 'fetch_meta', lambda s: {'ip': '203.0.113.9', 'isp': 'Example ISP',
                                                      'location': 'Berlin, DE', 'server': s['name'],
                                                      'server_url': s['server']})
    monkeypatch.setattr(inet, 'measure_ping', lambda s, count=8, cancelled=None: [10.0, 12.0, 11.0])
    monkeypatch.setattr(inet, 'measure_download', fake_download)
    monkeypatch.setattr(inet, 'measure_upload', fake_upload)
    monkeypatch.setattr(inet, '_test', inet.InternetSpeedTest())

    res = client.post('/api/speedtest/internet', headers=auth)
    assert res.status_code == 200
    for _ in range(100):
        status = client.get('/api/speedtest/internet', headers=auth).get_json()
        if status['phase'] in ('done', 'error'):
            break
        time.sleep(0.02)
    assert status['phase'] == 'done', status
    result = status['result']
    # 50 MB over the second between t=0.5 and t=1.5 - the warm-up skipped.
    assert abs(result['download_mbps'] - 400) < 1
    assert abs(result['upload_mbps'] - 120) < 1
    assert result['ping']['avg'] == 11.0
    assert result['meta']['isp'] == 'Example ISP'

    rows = client.get('/api/speedtest/results?kind=internet', headers=auth).get_json()['results']
    assert len(rows) == 1
    assert rows[0]['client'] == 'Example ISP' and rows[0]['ip'] == '203.0.113.9'
    assert rows[0]['meta'] == {'server': 'Frankfurt (Test)', 'server_url': 'https://fra.example/backend',
                               'location': 'Berlin, DE'}


def test_internet_test_refuses_a_second_run_and_can_be_cancelled(client, db, auth, monkeypatch):
    import threading
    import time
    from backend import speedtest as inet

    gate = threading.Event()

    def slow_ping(server, count=8, cancelled=lambda: False):
        while not gate.wait(0.01):
            if cancelled():
                raise inet.Cancelled()
        return [1.0]

    monkeypatch.setattr(inet, 'fetch_servers', lambda: [{'name': 't', 'server': 'https://t.example'}])
    monkeypatch.setattr(inet, 'pick_server', lambda servers, cancelled=None: servers[0])
    monkeypatch.setattr(inet, 'fetch_meta', lambda s: {'server': s['name'], 'server_url': s['server'], 'ip': None, 'isp': None, 'location': None})
    monkeypatch.setattr(inet, 'measure_ping', slow_ping)
    monkeypatch.setattr(inet, '_test', inet.InternetSpeedTest())

    assert client.post('/api/speedtest/internet', headers=auth).status_code == 200
    assert client.post('/api/speedtest/internet', headers=auth).status_code == 409
    # Still picking a server or already pinging - the thread's timing, not ours.
    assert client.get('/api/speedtest/internet', headers=auth).get_json()['phase'] in ('servers', 'ping')

    assert client.delete('/api/speedtest/internet', headers=auth).status_code == 200
    for _ in range(100):
        status = client.get('/api/speedtest/internet', headers=auth).get_json()
        if status['phase'] == 'idle':
            break
        time.sleep(0.02)
    assert status['phase'] == 'idle' and status['result'] is None
    assert client.get('/api/speedtest/results', headers=auth).get_json()['results'] == []


def test_a_failing_run_reports_the_error(client, db, auth, monkeypatch):
    import time
    from backend import speedtest as inet

    def boom(server, count=8, cancelled=lambda: False):
        raise OSError('Network is unreachable')

    monkeypatch.setattr(inet, 'fetch_servers', lambda: [{'name': 't', 'server': 'https://t.example'}])
    monkeypatch.setattr(inet, 'pick_server', lambda servers, cancelled=None: servers[0])
    monkeypatch.setattr(inet, 'fetch_meta', lambda s: {'server': 't', 'server_url': s['server'], 'ip': None, 'isp': None, 'location': None})
    monkeypatch.setattr(inet, 'measure_ping', boom)
    monkeypatch.setattr(inet, '_test', inet.InternetSpeedTest())
    client.post('/api/speedtest/internet', headers=auth)
    for _ in range(100):
        status = client.get('/api/speedtest/internet', headers=auth).get_json()
        if status['phase'] in ('error', 'done'):
            break
        time.sleep(0.02)
    assert status['phase'] == 'error' and 'unreachable' in status['error']


def test_throughput_helpers():
    from backend.speedtest import throughput_mbps, recent_mbps, ping_stats
    steady = [(t / 10, t * 1_000_000) for t in range(0, 41)]  # 10 MB/s
    assert abs(throughput_mbps(steady) - 80) < 1e-6
    assert throughput_mbps([]) == 0 and throughput_mbps([(0, 0)]) == 0
    assert abs(throughput_mbps([(0.0, 0), (0.5, 5_000_000)]) - 80) < 1e-6  # too short: whole run
    burst = steady + [(4.5, steady[-1][1] + 50_000_000)]
    assert abs(recent_mbps(burst) - 800) < 1
    assert ping_stats([2, 4, 3]) == {'min': 2, 'avg': 3, 'max': 4, 'jitter': 1.5}
    assert ping_stats([]) == {'min': 0.0, 'avg': 0.0, 'max': 0.0, 'jitter': 0.0}


def test_server_picking_and_url_building(monkeypatch):
    from backend import speedtest as inet
    servers = [
        {'name': 'far', 'server': 'https://far.example/', 'pingURL': 'backend/empty.php', 'dlURL': 'backend/garbage.php'},
        {'name': 'dead', 'server': 'https://dead.example', 'pingURL': 'empty.php', 'dlURL': 'garbage.php'},
        {'name': 'near', 'server': 'https://near.example/backend', 'pingURL': 'empty.php', 'dlURL': 'garbage.php'},
    ]
    rtt = {'far': 120.0, 'dead': None, 'near': 9.5}
    monkeypatch.setattr(inet, '_probe', lambda s, timeout=4.0: rtt[s['name']])
    picked = inet.pick_server(servers)
    assert picked['name'] == 'near' and picked['probe_ms'] == 9.5
    assert inet._url(picked, 'dlURL') == 'https://near.example/backend/garbage.php'
    assert inet._url(servers[0], 'pingURL') == 'https://far.example/backend/empty.php'

    monkeypatch.setattr(inet, '_probe', lambda s, timeout=4.0: None)
    with pytest.raises(RuntimeError):
        inet.pick_server(servers)


def test_server_list_falls_back_when_the_directory_is_down(monkeypatch):
    from backend import speedtest as inet

    class Dead:
        def __init__(self, url, timeout=15):
            raise OSError('no route')

    monkeypatch.setattr(inet, '_Conn', Dead)
    monkeypatch.setattr(inet, '_servers_cache', {'at': 0.0, 'servers': None})
    servers = inet.fetch_servers()
    assert servers and servers[0]['server'].startswith('https://')

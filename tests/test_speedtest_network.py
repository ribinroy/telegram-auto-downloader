"""The box's own uplink test, with the wire faked out.

Every network function in backend/speedtest.py goes through `_Conn`, so a
scripted stand-in for it drives download, upload, ping, probe, meta and the
server directory without a socket. `_Conn` itself is exercised against a fake
http.client connection, so the request line and headers it builds are pinned
down too.
"""
import json

import pytest

from backend import speedtest as inet


# --- the scripted connection ----------------------------------------------

class FakeResponse:
    """`.read(n)` streams `nbytes` of filler then b''; `.read()` with no size
    hands back `body` at once (what the JSON callers do)."""

    def __init__(self, status=200, body=b'', nbytes=0):
        self.status = status
        self._body = body
        self._left = nbytes
        self.closed = False

    def read(self, n=None):
        if n is None:
            body, self._body = self._body, b''
            return body
        take = min(n, self._left)
        self._left -= take
        return b'x' * take

    def close(self):
        self.closed = True


class FakeConn:
    """Records every request; `script(call)` picks the response, where
    `call` is {url, method, body, headers}."""
    instances = []
    script = staticmethod(lambda call: FakeResponse())

    def __init__(self, url, timeout=15):
        self.url, self.timeout = url, timeout
        self.calls = []
        self.responses = []
        self.closed = False
        FakeConn.instances.append(self)

    def request(self, url, method='GET', body=None, headers=None):
        call = {'url': url, 'method': method, 'body': body, 'headers': headers or {}}
        self.calls.append(call)
        res = FakeConn.script(call)
        self.responses.append(res)
        return res

    def close(self):
        self.closed = True


@pytest.fixture
def conn(monkeypatch):
    FakeConn.instances = []
    FakeConn.script = staticmethod(lambda call: FakeResponse())
    monkeypatch.setattr(inet, '_Conn', FakeConn)
    monkeypatch.setattr(inet, '_servers_cache', {'at': 0.0, 'servers': None})
    return FakeConn


@pytest.fixture
def clock(monkeypatch):
    """A perf_counter that advances a fixed step per call, so the deadline
    loops end on their own and nothing depends on the machine's speed."""
    state = {'t': 0.0, 'step': 0.05}

    def tick():
        state['t'] += state['step']
        return state['t']

    monkeypatch.setattr(inet.time, 'perf_counter', tick)
    return state


SERVER = {'name': 'Near (Test)', 'server': 'https://near.example/backend',
          'dlURL': 'garbage.php', 'ulURL': 'empty.php', 'pingURL': 'empty.php',
          'getIpURL': 'getIP.php'}


# --- _Conn ----------------------------------------------------------------

def test_conn_picks_the_scheme_and_port_from_the_url(monkeypatch):
    import http.client
    made = []

    class Spy:
        def __init__(self, host, port, timeout=None):
            made.append((self.__class__.__name__, host, port, timeout))

    monkeypatch.setattr(http.client, 'HTTPSConnection', type('HTTPSConnection', (Spy,), {}))
    monkeypatch.setattr(http.client, 'HTTPConnection', type('HTTPConnection', (Spy,), {}))
    inet._Conn('https://near.example:8443/backend', timeout=7)
    inet._Conn('http://plain.example/x')
    assert made == [('HTTPSConnection', 'near.example', 8443, 7),
                    ('HTTPConnection', 'plain.example', None, 15)]


def test_conn_sends_the_path_with_query_and_identity_encoding():
    c = inet._Conn('https://near.example/backend')
    sent = {}

    class Inner:
        def request(self, method, path, body=None, headers=None):
            sent.update(method=method, path=path, body=body, headers=headers)

        def getresponse(self):
            return 'the response'

        def close(self):
            sent['closed'] = True

    c.conn = Inner()
    assert c.request('https://near.example/backend/garbage.php?ckSize=100&r=1',
                     method='POST', body=b'noise', headers={'X-A': '1'}) == 'the response'
    assert sent['method'] == 'POST' and sent['body'] == b'noise'
    assert sent['path'] == '/backend/garbage.php?ckSize=100&r=1'
    assert sent['headers']['Accept-Encoding'] == 'identity'
    assert sent['headers']['User-Agent'] == inet.USER_AGENT and sent['headers']['X-A'] == '1'
    # No path at all becomes '/'
    c.request('https://near.example')
    assert sent['path'] == '/'
    c.close()
    assert sent['closed'] is True


# --- the server directory -------------------------------------------------

def test_the_directory_is_filtered_and_cached_for_an_hour(conn, monkeypatch):
    listing = [
        {'name': 'ok', 'server': 'https://a.example', 'dlURL': 'garbage.php'},
        {'name': 'no dl url', 'server': 'https://b.example'},
        'junk',
        {'name': 'no server', 'dlURL': 'garbage.php'},
    ]
    conn.script = staticmethod(lambda call: FakeResponse(body=json.dumps(listing).encode()))
    servers = inet.fetch_servers()
    assert [s['name'] for s in servers] == ['ok']
    assert conn.instances[0].url == inet.SERVER_LIST_URL and conn.instances[0].closed

    # Within the hour: answered from the cache, no second connection
    assert inet.fetch_servers() == servers
    assert len(conn.instances) == 1

    # An hour on, it is fetched again
    monkeypatch.setattr(inet.time, 'time', lambda: inet._servers_cache['at'] + 3601)
    inet.fetch_servers()
    assert len(conn.instances) == 2


def test_an_empty_or_broken_directory_falls_back_to_the_built_in_list(conn):
    conn.script = staticmethod(lambda call: FakeResponse(body=b'[]'))
    assert inet.fetch_servers() == inet.FALLBACK_SERVERS
    assert inet._servers_cache['servers'] is None       # nothing cached

    conn.script = staticmethod(lambda call: FakeResponse(body=b'<html>down</html>'))
    assert inet.fetch_servers() == inet.FALLBACK_SERVERS

    def refuse(call):
        raise OSError('connection refused')
    conn.script = staticmethod(refuse)
    assert inet.fetch_servers() == inet.FALLBACK_SERVERS
    assert all(c.closed for c in conn.instances)


# --- probing / picking ----------------------------------------------------

def test_probe_takes_the_best_of_two_round_trips(conn, clock):
    assert inet._probe(SERVER) == pytest.approx(50.0)       # one 0.05s step each
    c = conn.instances[0]
    assert c.timeout == 4.0 and c.closed
    assert len(c.calls) == 2
    assert all(call['url'].startswith('https://near.example/backend/empty.php?r=') for call in c.calls)


def test_probe_ignores_error_answers_and_dead_servers(conn, clock):
    conn.script = staticmethod(lambda call: FakeResponse(status=503))
    assert inet._probe(SERVER) is None

    def dead(call):
        raise OSError('timed out')
    conn.script = staticmethod(dead)
    assert inet._probe(SERVER) is None
    assert conn.instances[-1].closed


def test_picking_is_abandoned_when_cancelled_meanwhile(monkeypatch):
    monkeypatch.setattr(inet, '_probe', lambda s, timeout=4.0: 1.0)
    with pytest.raises(inet.Cancelled):
        inet.pick_server([SERVER], cancelled=lambda: True)


# --- meta -----------------------------------------------------------------

def test_meta_reads_ip_isp_and_location(conn):
    body = {'processedString': '203.0.113.9 - Example Telecom',
            'rawIspInfo': {'org': 'AS1 Example', 'city': 'Berlin', 'country': 'DE'}}
    conn.script = staticmethod(lambda call: FakeResponse(body=json.dumps(body).encode()))
    meta = inet.fetch_meta(SERVER)
    assert meta == {'ip': '203.0.113.9', 'isp': 'AS1 Example', 'location': 'Berlin, DE',
                    'server': 'Near (Test)', 'server_url': 'https://near.example/backend'}
    url = conn.instances[0].calls[0]['url']
    assert url.startswith('https://near.example/backend/getIP.php?isp=true&r=')
    assert conn.instances[0].closed


def test_meta_without_isp_details_reports_what_it_can(conn):
    body = {'processedString': '203.0.113.9 - Unknown ISP', 'rawIspInfo': 'n/a'}
    conn.script = staticmethod(lambda call: FakeResponse(body=json.dumps(body).encode()))
    meta = inet.fetch_meta(SERVER)
    assert meta['ip'] == '203.0.113.9' and meta['isp'] is None and meta['location'] is None

    conn.script = staticmethod(lambda call: FakeResponse(body=b''))
    meta = inet.fetch_meta(SERVER)
    assert meta['ip'] is None and meta['isp'] is None


# --- ping -----------------------------------------------------------------

def test_ping_skips_the_connection_setup_round_trip(conn, clock):
    rtts = inet.measure_ping(SERVER, count=3)
    assert len(rtts) == 3 and all(r == pytest.approx(50.0) for r in rtts)
    c = conn.instances[0]
    assert len(c.calls) == 4 and c.closed       # count + 1 requests, one connection


def test_ping_stops_when_cancelled(conn):
    seen = []

    def cancelled():
        seen.append(1)
        return len(seen) > 2
    with pytest.raises(inet.Cancelled):
        inet.measure_ping(SERVER, count=8, cancelled=cancelled)
    assert len(conn.instances[0].calls) == 2 and conn.instances[0].closed


# --- download -------------------------------------------------------------

def test_download_streams_until_the_deadline_and_re_requests_a_capped_body(conn, clock):
    # Each answer is 3 MB; the phase outlives one, so a second is requested
    conn.script = staticmethod(lambda call: FakeResponse(nbytes=3 * inet.CHUNK))
    reports = []
    samples = inet.measure_download(SERVER, seconds=0.9, on_progress=lambda s: reports.append(len(s)))
    c = conn.instances[0]
    assert c.timeout == 20 and c.closed
    assert len(c.calls) >= 2
    assert all(f'ckSize={inet.DOWNLOAD_CKSIZE}' in call['url'] and '&r=' in call['url']
               for call in c.calls)
    assert samples[0] == (0.0, 0)
    # Every byte read counts, including those of a body dropped at the deadline
    assert samples[-1][1] == sum(3 * inet.CHUNK - r._left for r in c.responses)
    assert [s[1] for s in samples] == sorted(s[1] for s in samples)
    assert reports and reports == sorted(reports)


def test_download_drops_a_body_that_outlives_the_deadline(conn, clock):
    conn.script = staticmethod(lambda call: FakeResponse(nbytes=10 ** 12))   # endless
    samples = inet.measure_download(SERVER, seconds=0.5)
    [res] = conn.instances[0].responses
    assert res.closed is True                   # the rest is dropped, not read
    assert 0 < samples[-1][1] < 10 ** 12
    assert conn.instances[0].closed


def test_download_refuses_a_non_200_answer(conn, clock):
    conn.script = staticmethod(lambda call: FakeResponse(status=403))
    with pytest.raises(RuntimeError, match='download refused \\(403\\)'):
        inet.measure_download(SERVER, seconds=1.0)
    assert conn.instances[0].closed


def test_download_can_be_cancelled_mid_transfer(conn, clock):
    conn.script = staticmethod(lambda call: FakeResponse(nbytes=10 ** 9))
    chunks = []

    def cancelled():
        chunks.append(1)
        return len(chunks) > 3
    with pytest.raises(inet.Cancelled):
        inet.measure_download(SERVER, seconds=10.0, cancelled=cancelled)
    assert conn.instances[0].closed


# --- upload ---------------------------------------------------------------

def test_upload_posts_whole_bodies_back_to_back(conn, clock):
    reports = []
    samples = inet.measure_upload(SERVER, seconds=0.4, on_progress=lambda s: reports.append(s[-1]))
    c = conn.instances[0]
    assert c.timeout == 30 and c.closed
    assert len(c.calls) >= 2
    for call in c.calls:
        assert call['method'] == 'POST' and call['body'] is inet._NOISE
        assert call['headers'] == {'Content-Type': 'application/octet-stream'}
        assert call['url'].startswith('https://near.example/backend/empty.php?r=')
    assert samples[-1][1] == len(c.calls) * inet.UPLOAD_CHUNK
    assert reports[-1] == samples[-1]


def test_upload_refused_by_the_server_is_an_error(conn, clock):
    conn.script = staticmethod(lambda call: FakeResponse(status=413))
    with pytest.raises(RuntimeError, match='upload refused \\(413\\)'):
        inet.measure_upload(SERVER, seconds=1.0)
    assert conn.instances[0].closed


def test_upload_stops_when_cancelled(conn, clock):
    with pytest.raises(inet.Cancelled):
        inet.measure_upload(SERVER, seconds=1.0, cancelled=lambda: True)
    assert conn.instances[0].calls == [] and conn.instances[0].closed


# --- the whole run over the fakes ------------------------------------------

def test_a_run_over_the_scripted_wire_records_a_result(conn, clock, monkeypatch):
    """Everything wired together: directory -> probe -> meta -> ping ->
    download -> upload, with only `_Conn` replaced."""
    directory = [dict(SERVER), dict(SERVER, name='Far', server='https://far.example')]
    meta = {'processedString': '198.51.100.7 - Some ISP', 'rawIspInfo': {}}

    def script(call):
        url = call['url']
        if url == inet.SERVER_LIST_URL:
            return FakeResponse(body=json.dumps(directory).encode())
        if 'getIP.php' in url:
            return FakeResponse(body=json.dumps(meta).encode())
        if 'garbage.php' in url:
            return FakeResponse(nbytes=2 * inet.CHUNK)
        return FakeResponse()
    conn.script = staticmethod(script)
    monkeypatch.setattr(inet, 'PHASE_SECONDS', 0.5)
    done = []
    test = inet.InternetSpeedTest()
    assert test.start(on_done=done.append) is True
    test._thread.join(10)
    status = test.status()
    assert status['phase'] == 'done', status
    assert status['meta']['ip'] == '198.51.100.7' and status['meta']['isp'] == 'Some ISP'
    assert status['result']['download_bytes'] > 0 and status['result']['upload_bytes'] > 0
    assert status['result']['ping']['avg'] == pytest.approx(50.0)
    assert done == [status['result']]


def test_a_run_survives_the_meta_lookup_failing(conn, clock, monkeypatch):
    """Who the box is to the internet is a nicety: the server name is kept
    and the measurements go ahead without the IP/ISP."""
    def script(call):
        url = call['url']
        if url == inet.SERVER_LIST_URL:
            return FakeResponse(body=json.dumps([SERVER]).encode())
        if 'getIP.php' in url:
            raise OSError('meta endpoint down')
        if 'garbage.php' in url:
            return FakeResponse(nbytes=inet.CHUNK)
        return FakeResponse()
    conn.script = staticmethod(script)
    monkeypatch.setattr(inet, 'PHASE_SECONDS', 0.3)
    test = inet.InternetSpeedTest()
    test.start()
    test._thread.join(10)
    status = test.status()
    assert status['phase'] == 'done', status
    assert status['meta'] == {'server': 'Near (Test)', 'server_url': 'https://near.example/backend',
                              'ip': None, 'isp': None, 'location': None}


def test_record_history_tolerates_a_result_without_meta(db):
    row = inet.record_history(db, {'ping': {'min': 1, 'avg': 1, 'max': 1, 'jitter': 0},
                                   'download_mbps': 1.0, 'upload_mbps': 2.0,
                                   'download_bytes': 10, 'upload_bytes': 20, 'meta': None})
    assert row['client'] is None and row['meta'] is None
    assert [r['id'] for r in inet.read_history(db)] == [row['id']]

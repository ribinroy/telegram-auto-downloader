"""The two torrent backends against scripted HTTP: Transmission's JSON-RPC
(with its 409 session-id handshake) through `urllib.request.urlopen`, and
qBittorrent's WebUI (cookie login, form posts, multipart upload) through the
opener `build_opener` hands back. Plus the client-agnostic dispatchers and the
temp-dir lookups built on them. No socket is ever opened."""
import base64
import json
import urllib.error
import urllib.parse
import urllib.request

import pytest

from backend.web_app import torrent as tor
from backend.web_app import qbittorrent as qbit


# ---------------------------------------------------------------------------
# HTTP fakes
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, body=b''):
        self.body = body if isinstance(body, bytes) else body.encode()

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code, headers=None):
    return urllib.error.HTTPError('http://box', code, f'HTTP {code}', headers or {}, None)


def header(req, name):
    """urllib capitalises header names on the way in; look one up regardless."""
    for k, v in req.header_items():
        if k.lower() == name.lower():
            return v
    return None


class FakeTransmission:
    """`urlopen` for a Transmission RPC endpoint. `results[method]` is the
    `arguments` to answer with (or an exception to raise); the first call
    without the session id gets a 409 carrying one, like the real daemon."""

    def __init__(self, require_session=True):
        self.calls = []            # (method, arguments, request)
        self.results = {}
        self.require_session = require_session
        self.session_id = 'sid-42'
        self.fail = None           # raised on every call
        self.result_word = 'success'

    def urlopen(self, req, timeout=None):
        if self.fail:
            raise self.fail
        payload = json.loads(req.data)
        self.calls.append((payload['method'], payload['arguments'], req))
        if self.require_session and header(req, 'X-Transmission-Session-Id') != self.session_id:
            raise http_error(409, {'X-Transmission-Session-Id': self.session_id})
        res = self.results.get(payload['method'], {})
        if isinstance(res, Exception):
            raise res
        return FakeResponse(json.dumps({'result': self.result_word, 'arguments': res}))

    def methods(self):
        return [m for m, _a, _r in self.calls]


@pytest.fixture
def transmission(monkeypatch):
    fake = FakeTransmission()
    monkeypatch.setattr(urllib.request, 'urlopen', fake.urlopen)
    return fake


TCFG = {'client': 'transmission', 'url': 'http://box:9091/transmission/rpc',
        'username': 'u', 'password': 'p', 'download_dir': '/dl', 'incomplete_dir': ''}


class FakeQbit:
    """The opener `build_opener` returns, scripted per WebUI path.
    `routes[path]` is a body (str/bytes), a callable(data, query) -> body, or
    an exception. The login endpoint always answers unless `login_error`."""

    def __init__(self):
        self.calls = []            # (method, path, data|None, query, request)
        self.routes = {}
        self.login_error = None
        self.logins = 0

    def build_opener(self, *handlers):
        return self

    def open(self, req, timeout=None):
        parsed = urllib.parse.urlsplit(req.full_url)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        data = None
        if req.data is not None and 'multipart' not in (header(req, 'Content-Type') or ''):
            data = {k: v[0] for k, v in urllib.parse.parse_qs(req.data.decode()).items()}
        self.calls.append((req.get_method(), parsed.path, data, query, req))
        if parsed.path.endswith('/auth/login'):
            self.logins += 1
            if self.login_error:
                raise self.login_error
            return FakeResponse('Ok.')
        if parsed.path not in self.routes:
            raise http_error(404)
        res = self.routes[parsed.path]
        if isinstance(res, Exception):
            raise res
        if callable(res):
            res = res(data, query)
            if isinstance(res, Exception):
                raise res
        return FakeResponse(res if isinstance(res, (str, bytes)) else json.dumps(res))

    def posted(self):
        return [(p, d) for m, p, d, _q, _r in self.calls if m == 'POST' and not p.endswith('/auth/login')]


@pytest.fixture
def qb(monkeypatch):
    fake = FakeQbit()
    monkeypatch.setattr(urllib.request, 'build_opener', fake.build_opener)
    return fake


QCFG = {'client': 'qbittorrent', 'url': 'http://box:8080/', 'username': 'u', 'password': 'p',
        'download_dir': '/dl', 'incomplete_dir': ''}


# ---------------------------------------------------------------------------
# Transmission RPC
# ---------------------------------------------------------------------------

def test_rpc_negotiates_the_session_id_once(transmission):
    transmission.results['session-get'] = {'version': '4.0.5'}
    out = tor.transmission_rpc('session-get', config=TCFG)
    assert out == {'version': '4.0.5'}
    assert transmission.methods() == ['session-get', 'session-get']
    first, second = transmission.calls[0][2], transmission.calls[1][2]
    assert header(first, 'X-Transmission-Session-Id') is None
    assert header(second, 'X-Transmission-Session-Id') == 'sid-42'
    assert header(second, 'Content-Type') == 'application/json'


def test_rpc_sends_basic_auth_only_when_configured(transmission):
    transmission.require_session = False
    tor.transmission_rpc('session-get', config=TCFG)
    expected = 'Basic ' + base64.b64encode(b'u:p').decode()
    assert header(transmission.calls[-1][2], 'Authorization') == expected
    tor.transmission_rpc('session-get', config={**TCFG, 'username': '', 'password': ''})
    assert header(transmission.calls[-1][2], 'Authorization') is None


def test_rpc_gives_up_after_a_second_409(monkeypatch):
    seen = []

    def always_409(req, timeout=None):
        seen.append(header(req, 'X-Transmission-Session-Id'))
        raise http_error(409, {'X-Transmission-Session-Id': 'x'})
    monkeypatch.setattr(urllib.request, 'urlopen', always_409)
    # The retry is a single one: the second 409 is reported like any other
    # HTTP failure rather than looping on the handshake.
    with pytest.raises(ValueError, match='HTTP 409'):
        tor.transmission_rpc('session-get', config=TCFG)
    assert seen == [None, 'x']          # retried once with the id it was given, then gave up


@pytest.mark.parametrize('err,message', [
    (http_error(401), 'authentication failed'),
    (http_error(500), 'HTTP 500'),
    (urllib.error.URLError('connection refused'), 'Cannot reach Transmission: connection refused'),
])
def test_rpc_maps_transport_failures_to_readable_errors(transmission, err, message):
    transmission.fail = err
    with pytest.raises(ValueError, match=message):
        tor.transmission_rpc('session-get', config=TCFG)


def test_rpc_reports_a_failed_result_word(transmission):
    transmission.require_session = False
    transmission.result_word = 'duplicate torrent'
    with pytest.raises(ValueError, match='Transmission error: duplicate torrent'):
        tor.transmission_rpc('torrent-add', {'filename': 'x'}, config=TCFG)


def test_rpc_without_config_says_so(transmission, monkeypatch):
    monkeypatch.setattr(tor, 'load_torrent_config', lambda c: None)
    with pytest.raises(ValueError, match='not configured'):
        tor.transmission_rpc('session-get')
    assert transmission.calls == []


def test_rpc_falls_back_to_the_saved_config(transmission, monkeypatch):
    transmission.require_session = False
    monkeypatch.setattr(tor, 'load_torrent_config', lambda c: TCFG)
    tor.transmission_rpc('session-get')
    assert transmission.calls[0][2].full_url == TCFG['url']


# --- session / test / add -----------------------------------------------------

def test_apply_session_enables_or_disables_the_incomplete_dir(transmission):
    transmission.require_session = False
    tor.transmission_apply_session({**TCFG, 'incomplete_dir': ' /inc '})
    tor.transmission_apply_session({**TCFG, 'incomplete_dir': ''})
    assert [a for _m, a, _r in transmission.calls] == [
        {'incomplete-dir-enabled': True, 'incomplete-dir': '/inc'},
        {'incomplete-dir-enabled': False},
    ]


def test_test_reports_the_version(transmission):
    transmission.require_session = False
    transmission.results['session-get'] = {'version': '4.0.5'}
    assert tor.transmission_test(TCFG) == 'Connected to Transmission 4.0.5'
    transmission.results['session-get'] = {}
    assert 'unknown version' in tor.transmission_test(TCFG)


def test_add_magnet_applies_the_temp_dir_first_and_passes_options(transmission):
    transmission.require_session = False
    transmission.results['torrent-add'] = {'torrent-added': {'name': 'X', 'hashString': 'abc'}}
    res = tor.transmission_add_magnet('magnet:?xt=urn:btih:abc', download_dir='/watch',
                                      paused=True, config={**TCFG, 'incomplete_dir': '/inc'})
    assert res == {'torrent-added': {'name': 'X', 'hashString': 'abc'}}
    assert transmission.methods() == ['session-set', 'torrent-add']
    assert transmission.calls[0][1] == {'incomplete-dir-enabled': True, 'incomplete-dir': '/inc'}
    assert transmission.calls[1][1] == {'filename': 'magnet:?xt=urn:btih:abc',
                                        'download-dir': '/watch', 'paused': True}


def test_add_magnet_with_an_explicit_temp_dir_overrides_the_configured_one(transmission):
    transmission.require_session = False
    tor.transmission_add_magnet('magnet:?x', incomplete_dir='/other',
                                config={**TCFG, 'incomplete_dir': '/inc'})
    assert transmission.calls[0][1]['incomplete-dir'] == '/other'
    # No temp dir at all: straight to the add
    transmission.calls.clear()
    tor.transmission_add_magnet('magnet:?x', config=TCFG)
    assert transmission.methods() == ['torrent-add']
    assert transmission.calls[0][1] == {'filename': 'magnet:?x'}


def test_add_magnet_and_file_refuse_without_config(transmission, monkeypatch):
    monkeypatch.setattr(tor, 'load_torrent_config', lambda c: None)
    with pytest.raises(ValueError, match='not configured'):
        tor.transmission_add_magnet('magnet:?x')
    with pytest.raises(ValueError, match='not configured'):
        tor.transmission_add_file(b'd4:infod4:name1:aee')


def test_add_file_sends_base64_metainfo(transmission):
    transmission.require_session = False
    transmission.results['torrent-add'] = {'torrent-duplicate': {'name': 'X', 'hashString': 'abc'}}
    raw = b'd4:infod4:name1:aee'
    res = tor.transmission_add_file(raw, download_dir='/dl', paused=True,
                                    config={**TCFG, 'incomplete_dir': '/inc'})
    assert 'torrent-duplicate' in res
    assert transmission.methods() == ['session-set', 'torrent-add']
    assert transmission.calls[1][1] == {'metainfo': base64.b64encode(raw).decode(),
                                        'download-dir': '/dl', 'paused': True}


# --- list / get / control / stats ---------------------------------------------

def test_list_asks_for_the_status_fields_and_normalizes(transmission):
    transmission.require_session = False
    transmission.results['torrent-get'] = {'torrents': [
        {'id': 1, 'name': 'A', 'hashString': 'aaa', 'status': 6, 'percentDone': 1.0, 'downloadDir': '/dl'},
        {'id': 2, 'name': 'B', 'hashString': 'bbb', 'status': 0, 'percentDone': 0.5, 'downloadDir': '/dl'},
    ]}
    rows = tor.transmission_list(TCFG)
    assert [(r['hash'], r['status'], r['content_path']) for r in rows] == [
        ('aaa', 'seeding', '/dl/A'), ('bbb', 'stopped', '/dl/B')]
    fields = transmission.calls[0][1]['fields']
    assert 'hashString' in fields and 'trackerStats' in fields and 'ids' not in transmission.calls[0][1]


def test_get_by_hash_and_the_raw_back_compat_fetch(transmission):
    transmission.require_session = False
    transmission.results['torrent-get'] = {'torrents': [
        {'id': 1, 'name': 'A', 'hashString': 'aaa', 'status': 4, 'percentDone': 0.25}]}
    got = tor.transmission_get(TCFG, 'aaa')
    assert got['hash'] == 'aaa' and got['percent_done'] == 25.0
    assert transmission.calls[-1][1]['ids'] == ['aaa']
    raw = tor.transmission_get_torrent('aaa', config=TCFG)
    assert raw['hashString'] == 'aaa' and 'percentDone' in raw

    transmission.results['torrent-get'] = {'torrents': []}
    assert tor.transmission_get(TCFG, 'nope') is None
    assert tor.transmission_get_torrent('nope', config=TCFG) is None


@pytest.mark.parametrize('action,delete_data,expected', [
    ('start', False, [('torrent-start', {'ids': ['a', 'b']})]),
    ('force-start', False, [('torrent-start-now', {'ids': ['a', 'b']})]),
    ('stop', False, [('torrent-stop', {'ids': ['a', 'b']})]),
    ('remove', False, [('torrent-remove', {'ids': ['a', 'b']})]),
    ('remove', True, [('torrent-remove', {'ids': ['a', 'b'], 'delete-local-data': True})]),
    ('verify', False, [('torrent-verify', {'ids': ['a', 'b']}), ('torrent-start', {'ids': ['a', 'b']})]),
])
def test_control_maps_each_action_to_its_rpc(transmission, action, delete_data, expected):
    transmission.require_session = False
    tor.transmission_control(TCFG, action, ['a', 'b'], delete_data)
    assert [(m, a) for m, a, _r in transmission.calls] == expected


def test_stats_report_cumulative_and_session_counters(transmission):
    transmission.require_session = False
    transmission.results['session-stats'] = {
        'cumulative-stats': {'downloadedBytes': 400, 'uploadedBytes': 100},
        'current-stats': {'downloadedBytes': 40, 'uploadedBytes': 10}}
    assert tor.transmission_stats(TCFG) == {
        'downloaded': 400, 'uploaded': 100, 'session_downloaded': 40,
        'session_uploaded': 10, 'ratio': 0.25, 'free_space': None}
    transmission.results['session-stats'] = {}
    assert tor.transmission_stats(TCFG)['ratio'] is None


def test_set_location_moves_the_data(transmission):
    transmission.require_session = False
    tor.transmission_set_location(TCFG, ['a'], '/final')
    assert transmission.calls[0][:2] == ('torrent-set-location',
                                         {'ids': ['a'], 'location': '/final', 'move': True})


def test_renaming_a_torrent_the_client_no_longer_has_fails_cleanly(transmission):
    transmission.require_session = False
    transmission.results['torrent-get'] = {'torrents': []}
    with pytest.raises(ValueError, match='no longer in the client'):
        tor.transmission_rename(TCFG, 'gone', None, 'New')


def test_tracker_host_tolerates_an_unparsable_url():
    assert tor.tracker_host('http://[bad') == 'http://[bad'
    assert tor.tracker_host(None) is None
    assert tor.tracker_host('udp://t.example.org:1337/announce') == 't.example.org'


# ---------------------------------------------------------------------------
# qBittorrent WebUI
# ---------------------------------------------------------------------------

def test_login_posts_the_form_with_referer_and_basic_auth(qb):
    opener, base = qbit.qbit_login(QCFG)
    assert base == 'http://box:8080'               # trailing slash dropped
    method, path, data, _q, req = qb.calls[0]
    assert (method, path) == ('POST', '/api/v2/auth/login')
    assert data == {'username': 'u', 'password': 'p'}
    assert header(req, 'Referer') == 'http://box:8080'
    assert header(req, 'Authorization') == 'Basic ' + base64.b64encode(b'u:p').decode()


def test_login_without_credentials_sends_no_basic_auth(qb):
    qbit.qbit_login({**QCFG, 'username': '', 'password': ''})
    assert header(qb.calls[0][4], 'Authorization') is None


def test_login_needs_a_url():
    with pytest.raises(ValueError, match='URL is not set'):
        qbit.qbit_login({'url': '  '})


@pytest.mark.parametrize('err,message', [
    (http_error(401), 'authentication failed'),
    (http_error(403), 'authentication failed'),
    (http_error(502), 'HTTP 502'),
    (urllib.error.URLError('timed out'), 'Cannot reach qBittorrent: timed out'),
])
def test_login_failures_are_readable(qb, err, message):
    qb.login_error = err
    with pytest.raises(ValueError, match=message):
        qbit.qbit_login(QCFG)


def test_a_request_logs_in_when_handed_no_opener(qb):
    qb.routes['/api/v2/app/version'] = 'v4.6.0'
    assert qbit._qbit_request(QCFG, '/api/v2/app/version') == 'v4.6.0'
    assert qb.logins == 1
    assert qb.calls[-1][0] == 'GET'


def test_a_request_with_data_is_a_form_post(qb):
    qb.routes['/api/v2/torrents/stop'] = ''
    opener, base = qbit.qbit_login(QCFG)
    qbit._qbit_request(QCFG, '/api/v2/torrents/stop', data={'hashes': 'a|b'}, opener=opener, base=base)
    method, path, data, _q, req = qb.calls[-1]
    assert method == 'POST' and data == {'hashes': 'a|b'}
    assert header(req, 'Content-Type') == 'application/x-www-form-urlencoded'
    assert qb.logins == 1


def test_a_404_is_none_only_when_allowed(qb):
    assert qbit._qbit_request(QCFG, '/api/v2/torrents/start', allow_404=True) is None
    with pytest.raises(ValueError, match='HTTP 404'):
        qbit._qbit_request(QCFG, '/api/v2/torrents/start')


@pytest.mark.parametrize('err,message', [
    (http_error(403), 'authentication failed'),
    (urllib.error.URLError('reset'), 'Cannot reach qBittorrent'),
])
def test_request_failures_are_readable(qb, err, message):
    qb.routes['/api/v2/app/version'] = err
    with pytest.raises(ValueError, match=message):
        qbit._qbit_request(QCFG, '/api/v2/app/version')


def test_an_empty_json_body_reads_as_none(qb):
    qb.routes['/api/v2/app/preferences'] = '  '
    assert qbit._qbit_request(QCFG, '/api/v2/app/preferences', expect_json=True) is None


def test_test_reports_the_version(qb):
    qb.routes['/api/v2/app/version'] = 'v4.6.0\n'
    assert qbit.qbit_test(QCFG) == 'Connected to qBittorrent v4.6.0'
    qb.routes['/api/v2/app/version'] = ''
    assert 'unknown version' in qbit.qbit_test(QCFG)


def test_default_dir_and_apply_session(qb):
    qb.routes['/api/v2/app/preferences'] = {'save_path': '/home/u/downloads/'}
    qb.routes['/api/v2/app/setPreferences'] = ''
    assert qbit.qbit_default_dir(QCFG) == '/home/u/downloads'
    qbit.qbit_apply_session({**QCFG, 'incomplete_dir': '/inc'})
    qbit.qbit_apply_session({**QCFG, 'incomplete_dir': ''})
    prefs = [json.loads(d['json']) for p, d in qb.posted() if p.endswith('setPreferences')]
    assert prefs == [{'temp_path_enabled': True, 'temp_path': '/inc'}, {'temp_path_enabled': False}]


def test_list_and_get(qb):
    qb.routes['/api/v2/torrents/info'] = lambda d, q: [
        {'name': 'A', 'hash': 'aaa', 'state': 'uploading', 'progress': 1, 'save_path': '/dl'}
    ] if q.get('hashes') in (None, 'aaa') else []
    rows = qbit.qbit_list(QCFG)
    assert [(r['hash'], r['status']) for r in rows] == [('aaa', 'seeding')]
    assert qbit.qbit_get(QCFG, 'aaa')['name'] == 'A'
    assert qbit.qbit_get(QCFG, 'zzz') is None


def test_stats_prefer_the_all_time_counters(qb):
    qb.routes['/api/v2/transfer/info'] = {'dl_info_data': 40, 'up_info_data': 10}
    qb.routes['/api/v2/sync/maindata'] = {'server_state': {
        'alltime_dl': 4000, 'alltime_ul': 1000, 'global_ratio': '0.25', 'free_space_on_disk': 99}}
    assert qbit.qbit_stats(QCFG) == {
        'downloaded': 4000, 'uploaded': 1000, 'session_downloaded': 40,
        'session_uploaded': 10, 'ratio': 0.25, 'free_space': 99}
    # An older build without the all-time counters: this session is all there is
    qb.routes['/api/v2/sync/maindata'] = {'server_state': {'global_ratio': 'n/a'}}
    st = qbit.qbit_stats(QCFG)
    assert st['downloaded'] == 40 and st['ratio'] is None and st['free_space'] is None


def test_add_magnet_detects_a_duplicate_and_applies_the_temp_dir(qb):
    qb.routes['/api/v2/app/setPreferences'] = ''
    qb.routes['/api/v2/torrents/info'] = lambda d, q: [{'hash': q['hashes']}] if q.get('hashes') == 'a' * 40 else []
    qb.routes['/api/v2/torrents/add'] = 'Ok.'
    res = qbit.qbit_add_magnet({**QCFG, 'incomplete_dir': '/inc'}, f'magnet:?xt=urn:btih:{"A" * 40}',
                               download_dir='/watch', paused=True)
    assert res == {'name': None, 'hash': 'a' * 40, 'duplicate': True}
    paths = [p for p, _d in qb.posted()]
    assert paths == ['/api/v2/app/setPreferences', '/api/v2/torrents/add']
    assert dict(qb.posted())['/api/v2/torrents/add'] == {
        'urls': f'magnet:?xt=urn:btih:{"A" * 40}', 'paused': 'true', 'savepath': '/watch'}


def test_add_magnet_without_a_hash_skips_the_duplicate_check(qb):
    qb.routes['/api/v2/torrents/add'] = 'Ok.'
    res = qbit.qbit_add_magnet(QCFG, 'magnet:?dn=no-hash')
    assert res == {'name': None, 'hash': None, 'duplicate': False}
    assert [p for _m, p, _d, _q, _r in qb.calls if 'torrents/info' in p] == []
    assert dict(qb.posted())['/api/v2/torrents/add'] == {'urls': 'magnet:?dn=no-hash', 'paused': 'false'}


def test_control_remove_and_verify(qb):
    for p in ('/api/v2/torrents/delete', '/api/v2/torrents/recheck', '/api/v2/torrents/start'):
        qb.routes[p] = ''
    qbit.qbit_control(QCFG, 'remove', ['a', 'b'], delete_data=True)
    qbit.qbit_control(QCFG, 'remove', ['a'])
    qbit.qbit_control(QCFG, 'verify', ['a'])
    assert qb.posted() == [
        ('/api/v2/torrents/delete', {'hashes': 'a|b', 'deleteFiles': 'true'}),
        ('/api/v2/torrents/delete', {'hashes': 'a', 'deleteFiles': 'false'}),
        ('/api/v2/torrents/recheck', {'hashes': 'a'}),
        ('/api/v2/torrents/start', {'hashes': 'a'}),
    ]


def test_control_falls_back_to_the_v4_endpoints_on_404(qb):
    """qBittorrent 5 renamed resume/pause to start/stop; a 4.x box 404s the new
    names, and the legacy ones must then be tried."""
    qb.routes['/api/v2/torrents/resume'] = ''
    qb.routes['/api/v2/torrents/pause'] = ''
    qbit.qbit_control(QCFG, 'start', ['a'])
    qbit.qbit_control(QCFG, 'stop', ['a'])
    assert [p for p, _d in qb.posted()] == [
        '/api/v2/torrents/start', '/api/v2/torrents/resume',
        '/api/v2/torrents/stop', '/api/v2/torrents/pause']


def test_force_start_starts_first_then_forces(qb):
    """A plain start clears qBittorrent's force flag, so forcing before
    starting is a silent no-op - the order is the whole point."""
    qb.routes['/api/v2/torrents/start'] = ''
    qb.routes['/api/v2/torrents/setForceStart'] = ''
    qbit.qbit_control(QCFG, 'force-start', ['a', 'b'])
    assert qb.posted() == [
        ('/api/v2/torrents/start', {'hashes': 'a|b'}),
        ('/api/v2/torrents/setForceStart', {'hashes': 'a|b', 'value': 'true'}),
    ]
    assert qb.logins == 1       # one login for the pair


def test_set_location(qb):
    qb.routes['/api/v2/torrents/setLocation'] = ''
    qbit.qbit_set_location(QCFG, ['a', 'b'], '/final')
    assert qb.posted() == [('/api/v2/torrents/setLocation', {'hashes': 'a|b', 'location': '/final'})]


def test_add_file_uploads_multipart_and_reads_the_metadata(qb):
    info = b'd6:lengthi100e4:name5:a.mkve'
    raw = b'd4:info' + info + b'e'
    import hashlib
    info_hash = hashlib.sha1(info).hexdigest()
    qb.routes['/api/v2/app/setPreferences'] = ''
    qb.routes['/api/v2/torrents/info'] = lambda d, q: []
    qb.routes['/api/v2/torrents/add'] = ''
    res = qbit.qbit_add_file({**QCFG, 'incomplete_dir': '/inc'}, raw, download_dir='/watch', paused=True)
    assert res == {'name': 'a.mkv', 'hash': info_hash, 'duplicate': False}
    method, path, data, _q, req = qb.calls[-1]
    assert (method, path, data) == ('POST', '/api/v2/torrents/add', None)
    ctype = header(req, 'Content-Type')
    assert ctype.startswith('multipart/form-data; boundary=')
    boundary = ctype.split('boundary=')[1].encode()
    body = req.data
    assert body.count(b'--' + boundary) == 4               # two fields, one file, the closer
    assert b'name="savepath"\r\n\r\n/watch' in body and b'name="paused"\r\n\r\ntrue' in body
    assert b'filename="upload.torrent"' in body and raw in body
    assert body.endswith(b'--' + boundary + b'--\r\n')
    assert header(req, 'Referer') == 'http://box:8080'
    assert [p for p, _d in qb.posted()][0] == '/api/v2/app/setPreferences'


def test_add_file_reports_a_duplicate(qb):
    qb.routes['/api/v2/torrents/info'] = lambda d, q: [{'hash': q['hashes']}]
    qb.routes['/api/v2/torrents/add'] = ''
    res = qbit.qbit_add_file(QCFG, b'd4:infod4:name1:aee')
    assert res['duplicate'] is True and res['name'] == 'a'


@pytest.mark.parametrize('err,message', [
    (http_error(401), 'authentication failed'),
    (http_error(500), 'HTTP 500'),
    (urllib.error.URLError('reset'), 'Cannot reach qBittorrent'),
])
def test_multipart_upload_failures_are_readable(qb, err, message):
    qb.routes['/api/v2/torrents/info'] = []
    qb.routes['/api/v2/torrents/add'] = err
    with pytest.raises(ValueError, match=message):
        qbit.qbit_add_file(QCFG, b'd4:infod4:name1:aee')


def test_magnet_hash_edge_cases():
    assert qbit.magnet_btih('magnet:?xt=urn:btih:ABC/extra') == 'abc'       # short, lowercased
    assert qbit.magnet_btih('magnet:?xt=urn:btih:' + '!' * 32) is None    # invalid base32
    assert qbit.magnet_btih('magnet:?xt=urn:btih:&dn=x') is None          # empty


def test_normalize_handles_unknown_counts_and_no_save_path():
    t = qbit._normalize({'name': 'A', 'hash': 'a', 'state': 'downloading',
                         'num_complete': -1, 'num_incomplete': 'x', 'download_path': '/tmp-dl'})
    assert t['seeds_total'] is None and t['leeches_total'] is None
    assert t['content_path'] is None and t['temp_dir'] == '/tmp-dl'


def test_torrent_file_info_with_a_non_dict_info_has_no_name():
    info_hash, name = qbit.torrent_file_info(b'd4:infoli1eee')
    assert info_hash and name is None


# ---------------------------------------------------------------------------
# Dispatchers
# ---------------------------------------------------------------------------

@pytest.fixture
def both(monkeypatch, transmission, qb):
    """Both clients configured, from the dispatchers' point of view."""
    transmission.require_session = False
    monkeypatch.setattr(tor, 'load_torrent_config',
                        lambda c: {'transmission': TCFG, 'qbittorrent': QCFG}.get(c))
    return transmission, qb


def test_dispatchers_refuse_an_unconfigured_client(monkeypatch):
    monkeypatch.setattr(tor, 'load_torrent_config', lambda c: None)
    for fn in (lambda: tor.torrent_test('qbittorrent'),
               lambda: tor.torrent_list('transmission'),
               lambda: tor.torrent_get('qbittorrent', 'a'),
               lambda: tor.torrent_stats('transmission'),
               lambda: tor.torrent_control('qbittorrent', 'stop', ['a']),
               lambda: tor.torrent_set_location('transmission', ['a'], '/x'),
               lambda: tor.torrent_add_magnet('qbittorrent', 'magnet:?x'),
               lambda: tor.torrent_add_file('transmission', b'd'),
               lambda: tor.torrent_telegram_dirs('qbittorrent'),
               lambda: tor.torrent_temp_dirs('transmission'),
               lambda: tor.torrent_details('transmission', 'a'),
               lambda: tor.torrent_rename('transmission', 'a', 'b'),
               lambda: tor.torrent_set_file_priority('transmission', 'a', [0], 'high')):
        with pytest.raises(ValueError, match='not configured'):
            fn()
    with pytest.raises(ValueError, match='Torrent client is not configured'):
        tor._resolve(None, None)


def test_apply_session_routes_by_client(both):
    transmission, qb = both
    qb.routes['/api/v2/app/setPreferences'] = ''
    tor.apply_torrent_session({**QCFG, 'incomplete_dir': '/inc'})
    tor.apply_torrent_session({**TCFG, 'incomplete_dir': '/inc'})
    assert [p for p, _d in qb.posted()] == ['/api/v2/app/setPreferences']
    assert transmission.methods() == ['session-set']


def test_test_list_get_and_stats_route_by_client(both):
    transmission, qb = both
    transmission.results['session-get'] = {'version': '4.0'}
    transmission.results['torrent-get'] = {'torrents': [{'hashString': 'ttt', 'name': 'T', 'status': 4}]}
    transmission.results['session-stats'] = {'cumulative-stats': {'downloadedBytes': 1, 'uploadedBytes': 1}}
    qb.routes['/api/v2/app/version'] = 'v5'
    qb.routes['/api/v2/torrents/info'] = [{'hash': 'qqq', 'name': 'Q', 'state': 'downloading'}]
    qb.routes['/api/v2/transfer/info'] = {'dl_info_data': 2, 'up_info_data': 2}
    qb.routes['/api/v2/sync/maindata'] = {}

    assert tor.torrent_test('transmission').startswith('Connected to Transmission')
    assert tor.torrent_test('qbittorrent').startswith('Connected to qBittorrent')
    assert [r['hash'] for r in tor.torrent_list('transmission')] == ['ttt']
    assert [r['hash'] for r in tor.torrent_list('qbittorrent')] == ['qqq']
    assert tor.torrent_get('transmission', 'ttt')['name'] == 'T'
    assert tor.torrent_get('qbittorrent', 'qqq')['name'] == 'Q'
    assert tor.torrent_stats('transmission')['ratio'] == 1.0
    assert tor.torrent_stats('qbittorrent')['downloaded'] == 2


def test_control_and_set_location_route_by_client(both):
    transmission, qb = both
    qb.routes['/api/v2/torrents/stop'] = ''
    qb.routes['/api/v2/torrents/setLocation'] = ''
    tor.torrent_control('transmission', 'stop', ['t'])
    tor.torrent_control('qbittorrent', 'stop', ['q'])
    tor.torrent_set_location('transmission', ['t'], '/a')
    tor.torrent_set_location('qbittorrent', ['q'], '/b')
    assert transmission.methods() == ['torrent-stop', 'torrent-set-location']
    assert [p for p, _d in qb.posted()] == ['/api/v2/torrents/stop', '/api/v2/torrents/setLocation']


def test_add_magnet_falls_back_to_the_configured_download_dir(both):
    transmission, qb = both
    transmission.results['torrent-add'] = {'torrent-duplicate': {'name': 'T', 'hashString': 'ttt'}}
    res = tor.torrent_add_magnet('transmission', 'magnet:?x')
    assert res == {'name': 'T', 'hash': 'ttt', 'duplicate': True}
    assert transmission.calls[-1][1]['download-dir'] == '/dl'
    transmission.results['torrent-add'] = {'torrent-added': {'name': 'T', 'hashString': 'ttt'}}
    assert tor.torrent_add_magnet('transmission', 'magnet:?x', download_dir='/watch')['duplicate'] is False
    assert transmission.calls[-1][1]['download-dir'] == '/watch'

    qb.routes['/api/v2/torrents/add'] = ''
    res = tor.torrent_add_magnet('qbittorrent', 'magnet:?dn=x')
    assert res == {'name': None, 'hash': None, 'duplicate': False}
    assert dict(qb.posted())['/api/v2/torrents/add']['savepath'] == '/dl'


def test_add_file_routes_by_client(both):
    transmission, qb = both
    raw = b'd4:infod4:name1:aee'
    transmission.results['torrent-add'] = {'torrent-added': {'name': 'a', 'hashString': 'h'}}
    assert tor.torrent_add_file('transmission', raw) == {'name': 'a', 'hash': 'h', 'duplicate': False}
    assert transmission.calls[-1][1]['download-dir'] == '/dl'
    transmission.results['torrent-add'] = {}
    assert tor.torrent_add_file('transmission', raw)['hash'] is None

    qb.routes['/api/v2/torrents/info'] = []
    qb.routes['/api/v2/torrents/add'] = ''
    res = tor.torrent_add_file('qbittorrent', raw, download_dir='/watch')
    assert res['name'] == 'a' and res['duplicate'] is False
    assert b'name="savepath"\r\n\r\n/watch' in qb.calls[-1][4].data


# --- Telegram dirs / temp dirs / locating files ---------------------------------

def test_telegram_dirs_under_the_configured_download_dir():
    cfg = {**TCFG, 'download_dir': '/dl/', 'incomplete_dir': ''}
    assert tor.torrent_telegram_dirs('transmission', cfg) == ('/dl/telegram/downloads', '/dl/telegram/progress')
    cfg = {**TCFG, 'download_dir': '/dl', 'incomplete_dir': '/inc/'}
    assert tor.torrent_telegram_dirs('transmission', cfg) == ('/dl/telegram/downloads', '/inc/telegram/progress')


def test_telegram_dirs_derive_from_the_clients_own_default(both):
    transmission, qb = both
    transmission.results['session-get'] = {'download-dir': '/home/u/downloads/'}
    cfg = {**TCFG, 'download_dir': ''}
    assert tor.torrent_telegram_dirs('transmission', cfg) == (
        '/home/u/telegram/downloads', '/home/u/telegram/progress')
    qb.routes['/api/v2/app/preferences'] = {'save_path': '/home/q/done'}
    assert tor.torrent_telegram_dirs('qbittorrent', {**QCFG, 'download_dir': ''}) == (
        '/home/q/telegram/downloads', '/home/q/telegram/progress')
    assert tor.transmission_telegram_dirs(config=cfg)[0] == '/home/u/telegram/downloads'


def test_telegram_dirs_fall_back_to_relative_names_at_the_root(both):
    transmission, _ = both
    for default in ('/downloads', '', None):
        transmission.results['session-get'] = {'download-dir': default}
        assert tor.torrent_telegram_dirs('transmission', {**TCFG, 'download_dir': ''}) == (
            'telegram/downloads', 'telegram/progress')


def test_temp_dirs_collect_every_candidate_once(both):
    transmission, qb = both
    transmission.results['session-get'] = {'incomplete-dir-enabled': True, 'incomplete-dir': '/sess-inc/'}
    cfg = {**TCFG, 'download_dir': '/dl', 'incomplete_dir': '/inc/'}
    dirs = tor.torrent_temp_dirs('transmission', {'temp_dir': '/inc'}, cfg)
    assert dirs == ['/inc', '/inc/telegram/progress', '/sess-inc']

    transmission.results['session-get'] = {'incomplete-dir-enabled': False, 'incomplete-dir': '/sess-inc'}
    assert tor.torrent_temp_dirs('transmission', None, cfg) == ['/inc', '/inc/telegram/progress']

    # qBittorrent: its per-torrent temp dir plus the configured one; no session lookup
    assert tor.torrent_temp_dirs('qbittorrent', {'temp_dir': '/qtemp'}, {**QCFG, 'incomplete_dir': '/inc'}) == [
        '/qtemp', '/inc', '/inc/telegram/progress']


def test_temp_dirs_survive_an_unreachable_client(both):
    transmission, _ = both
    transmission.fail = urllib.error.URLError('down')
    cfg = {**TCFG, 'download_dir': '', 'incomplete_dir': '/inc'}
    # The Telegram-dir and session lookups both need the daemon; both fail quietly
    assert tor.torrent_temp_dirs('transmission', None, cfg) == ['/inc']


def test_file_candidates_skip_a_temp_dir_that_is_the_download_dir():
    assert tor.torrent_file_candidates('/dl/', 'Show/e1.mkv', ['/dl', '/inc']) == [
        '/dl/Show/e1.mkv', '/inc/Show/e1.mkv']


def test_locate_skips_unconfigured_and_unreachable_clients(monkeypatch):
    monkeypatch.setattr(tor, 'load_torrent_config',
                        lambda c: None if c == 'transmission' else {'client': c, 'incomplete_dir': '/inc'})
    monkeypatch.setattr(tor, 'torrent_list', lambda c: (_ for _ in ()).throw(ValueError('down')))

    class Sftp:
        def stat(self, path):
            raise AssertionError('nothing should be stat-ed')
    assert tor.locate_torrent_file('/dl/Show/e1.mkv', Sftp()) is None


def test_locate_returns_none_when_no_copy_exists(monkeypatch):
    monkeypatch.setattr(tor, 'load_torrent_config', lambda c: {'client': c, 'incomplete_dir': '/inc'})
    monkeypatch.setattr(tor, 'torrent_list', lambda c: [{'download_dir': '/dl', 'temp_dir': '/qtemp'}])
    monkeypatch.setattr(tor, 'torrent_telegram_dirs', lambda c, cfg=None: ('/x', '/prog'))
    looked = []

    class Sftp:
        def stat(self, path):
            looked.append(path)
            raise IOError(2, 'No such file')
    assert tor.locate_torrent_file('/dl/Show/e1.mkv', Sftp()) is None
    assert '/qtemp/Show/e1.mkv' in looked and '/inc/Show/e1.mkv' in looked and '/prog/Show/e1.mkv' in looked
    assert '/dl/Show/e1.mkv' not in looked         # the final path is the caller's "no such file"


def test_telegram_default_requires_a_configured_client(monkeypatch):
    monkeypatch.setattr(tor, 'read_torrent_settings', lambda: {
        'transmission': {'url': ''}, 'qbittorrent': {'url': 'http://q'}, 'telegram_default': 'transmission'})
    assert tor.get_telegram_default() is None
    monkeypatch.setattr(tor, 'read_torrent_settings', lambda: {
        'transmission': {}, 'qbittorrent': {'url': 'http://q'}, 'telegram_default': 'qbittorrent'})
    assert tor.get_telegram_default() == 'qbittorrent'


def test_load_torrent_config_decrypts_and_rejects_unknown_clients(monkeypatch):
    from backend.utils import encrypt_secret
    monkeypatch.setattr(tor, 'read_torrent_settings', lambda: {
        'transmission': {'url': 'http://t', 'username': 'u', 'password_enc': encrypt_secret('pw'),
                         'local_dir': '/mnt', 'stop_on_complete': False},
        'qbittorrent': {}, 'telegram_default': None})
    cfg = tor.load_torrent_config('transmission')
    assert cfg['password'] == 'pw' and cfg['local_dir'] == '/mnt' and cfg['stop_on_complete'] is False
    assert cfg['client'] == 'transmission'
    assert tor.load_torrent_config('qbittorrent') is None
    assert tor.load_torrent_config('deluge') is None


def test_details_of_a_torrent_qbittorrent_no_longer_has_is_none(qb):
    qb.routes['/api/v2/torrents/info'] = []
    assert qbit.qbit_details(QCFG, 'gone') is None

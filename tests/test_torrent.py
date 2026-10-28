"""Both torrent clients are normalized into one shape, and one legacy config
layout has to keep working. That mapping is where the bugs live."""
import json
import pytest

from backend.web_app import torrent as tor
from backend.web_app import qbittorrent as qbit


# --- Transmission normalizer ---------------------------------------------

def tnorm(**over):
    base = {'id': 1, 'name': 'x', 'hashString': 'abc', 'status': 4,
            'percentDone': 0.5, 'rateDownload': 100, 'rateUpload': 5,
            'totalSize': 1000, 'eta': 60, 'downloadDir': '/d',
            'errorString': '', 'addedDate': 1, 'peersConnected': 2,
            'peersSendingToUs': 1, 'peersGettingFromUs': 1, 'trackerStats': []}
    base.update(over)
    return tor._transmission_normalize(base)


@pytest.mark.parametrize('code,label', [
    (0, 'stopped'), (2, 'checking'), (3, 'download-wait'),
    (4, 'downloading'), (5, 'seed-wait'), (6, 'seeding'), (99, 'unknown'),
])
def test_transmission_status_codes_map_to_shared_labels(code, label):
    assert tnorm(status=code, percentDone=0.5)['status'] == label


def test_a_finished_stopped_torrent_is_completed_not_paused():
    """Transmission reports one "stopped" for both; with the watcher pausing
    seeds on completion, calling that "Paused" reads like a failure."""
    assert tnorm(status=0, percentDone=1.0)['status'] == 'completed'
    assert tnorm(status=0, percentDone=0.42)['status'] == 'stopped'


def test_transmission_cannot_report_forced_so_it_says_unknown():
    """None is "can't tell", which is not the same as False - the UI must not
    light the force button up on a guess."""
    assert tnorm()['force_start'] is None


def test_transmission_negative_eta_becomes_none():
    assert tnorm(eta=-1)['eta'] is None
    assert tnorm(eta=60)['eta'] == 60


def test_transmission_percent_is_a_percentage():
    assert tnorm(percentDone=0.333)['percent_done'] == 33.3


def test_tracker_counts_ignore_negative_placeholders():
    got = tnorm(trackerStats=[{'seederCount': -1, 'leecherCount': 4},
                              {'seederCount': 9, 'leecherCount': -1}])
    assert got['seeds_total'] == 9 and got['leeches_total'] == 4
    assert tnorm(trackerStats=[])['seeds_total'] is None


# --- qBittorrent normalizer ----------------------------------------------

def qnorm(**over):
    base = {'name': 'x', 'hash': 'abc', 'state': 'downloading', 'progress': 0.5,
            'dlspeed': 1, 'upspeed': 1, 'size': 10, 'eta': 60, 'save_path': '/d',
            'added_on': 1, 'num_seeds': 1, 'num_leechs': 2,
            'num_complete': 3, 'num_incomplete': 4}
    base.update(over)
    return qbit._normalize(base)


@pytest.mark.parametrize('state,label', [
    ('downloading', 'downloading'), ('stalledDL', 'downloading'),
    ('forcedDL', 'downloading'), ('uploading', 'seeding'),
    ('stalledUP', 'seeding'), ('queuedDL', 'download-wait'),
    ('moving', 'checking'), ('nonsense', 'unknown'),
])
def test_qbit_states_map_to_shared_labels(state, label):
    assert qnorm(state=state)['status'] == label


@pytest.mark.parametrize('state', ['pausedUP', 'stoppedUP'])
def test_qbit_paused_after_completing_is_completed(state):
    assert qnorm(state=state)['status'] == 'completed'


@pytest.mark.parametrize('state', ['pausedDL', 'stoppedDL'])
def test_qbit_paused_mid_download_is_still_stopped(state):
    assert qnorm(state=state)['status'] == 'stopped'


def test_qbit_reports_force_start_from_the_flag_or_the_state():
    assert qnorm(force_start=True)['force_start'] is True
    assert qnorm(state='forcedDL')['force_start'] is True
    assert qnorm(state='forcedUP')['force_start'] is True
    assert qnorm()['force_start'] is False


def test_qbit_infinite_eta_becomes_none():
    assert qnorm(eta=qbit._QBIT_INFINITY_ETA)['eta'] is None
    assert qnorm(eta=-1)['eta'] is None


# --- magnet hash ----------------------------------------------------------

def test_magnet_hex_hash_is_lowercased():
    h = 'A' * 40
    assert qbit.magnet_btih(f'magnet:?xt=urn:btih:{h}&dn=x') == h.lower()


def test_magnet_base32_hash_is_converted_to_hex():
    import base64
    raw = bytes(range(20))
    b32 = base64.b32encode(raw).decode()
    assert qbit.magnet_btih(f'magnet:?xt=urn:btih:{b32}') == raw.hex()


def test_magnet_without_a_hash_returns_none():
    assert qbit.magnet_btih('magnet:?dn=no-hash') is None
    assert qbit.magnet_btih('') is None


# --- .torrent bencode parsing --------------------------------------------

def test_torrent_file_info_reads_name_and_hash():
    """The info-hash is the SHA-1 of the raw info dict's bytes, so it must be
    taken from the original span, never from a re-encode."""
    import hashlib
    info = b'd6:lengthi100e4:name5:a.mkve'
    data = b'd4:info' + info + b'e'
    info_hash, name = qbit.torrent_file_info(data)
    assert name == 'a.mkv'
    assert info_hash == hashlib.sha1(info).hexdigest()
    assert len(info_hash) == 40


@pytest.mark.parametrize('bad', [b'not a torrent', b'', b'x'])
def test_torrent_file_info_rejects_a_non_bencoded_file(bad):
    assert qbit.torrent_file_info(bad) == (None, None)


def test_torrent_file_info_without_an_info_dict_has_no_hash():
    info_hash, name = qbit.torrent_file_info(b'd8:announce3:abce')
    assert info_hash is None and name is None


# --- config storage -------------------------------------------------------

class FakeDB:
    def __init__(self, raw=None):
        self.raw = raw
        self.written = None

    def get_setting(self, key):
        return self.raw

    def set_setting(self, key, value):
        self.written = value


def test_legacy_flat_transmission_config_is_migrated(monkeypatch):
    legacy = json.dumps({'url': 'http://box:9091/transmission/rpc',
                         'username': 'u', 'password_enc': 'enc',
                         'download_dir': '/dl', 'incomplete_dir': '/tmp'})
    monkeypatch.setattr(tor, 'get_db', lambda: FakeDB(legacy))
    cfg = tor.read_torrent_settings()
    assert cfg['transmission']['url'].endswith('/transmission/rpc')
    assert cfg['transmission']['password_enc'] == 'enc'
    assert cfg['qbittorrent'] == {}
    assert cfg['telegram_default'] == 'transmission'


def test_missing_or_broken_config_yields_an_empty_shape(monkeypatch):
    for raw in (None, '', 'not json'):
        monkeypatch.setattr(tor, 'get_db', lambda raw=raw: FakeDB(raw))
        cfg = tor.read_torrent_settings()
        assert cfg == {'transmission': {}, 'qbittorrent': {}, 'telegram_default': None}


def test_stop_on_complete_defaults_to_on():
    assert tor.stop_on_complete_enabled({}) is True
    assert tor.stop_on_complete_enabled({'stop_on_complete': False}) is False
    assert tor.stop_on_complete_enabled(None) is True


@pytest.mark.parametrize('given,expected', [
    ('http://b:9091', 'http://b:9091/transmission/rpc'),
    ('http://b:9091/', 'http://b:9091/transmission/rpc'),
    ('http://b:9091/transmission/web', 'http://b:9091/transmission/rpc'),
    ('http://b:9091/transmission/web/', 'http://b:9091/transmission/rpc'),
    ('http://b:9091/transmission/rpc', 'http://b:9091/transmission/rpc'),
])
def test_transmission_urls_normalize_to_the_rpc_endpoint(given, expected):
    assert tor.normalize_transmission_url(given) == expected


# --- torrent details (files, totals, trackers) -------------------------------

def test_transmission_details_reports_files_priorities_and_trackers(monkeypatch):
    def fake_rpc(method, arguments=None, config=None, timeout=20):
        assert method == 'torrent-get' and arguments['ids'] == ['abc']
        return {'torrents': [{
            'hashString': 'abc', 'name': 'Show S01', 'status': 4, 'percentDone': 0.5,
            'totalSize': 300, 'uploadRatio': -1, 'uploadedEver': 10, 'downloadedEver': 150,
            'addedDate': 1700000000, 'doneDate': 0, 'isPrivate': True,
            'pieceSize': 16384, 'pieceCount': 20,
            'files': [{'name': 'Show S01/e01.mkv', 'length': 200, 'bytesCompleted': 150},
                      {'name': 'Show S01/sample.mkv', 'length': 100, 'bytesCompleted': 0},
                      {'name': 'Show S01/empty.nfo', 'length': 0, 'bytesCompleted': 0}],
            'fileStats': [{'wanted': True, 'priority': 1},
                          {'wanted': False, 'priority': 0},
                          {'wanted': True, 'priority': -1}],
            'trackerStats': [{'announce': 'udp://tracker.example.org:1337/announce',
                              'seederCount': 12, 'leecherCount': -1, 'lastAnnounceResult': 'Success'}],
        }]}
    monkeypatch.setattr(tor, 'transmission_rpc', fake_rpc)
    d = tor.torrent_details('transmission', 'abc', config={'url': 'x'})
    assert d['torrent']['name'] == 'Show S01'
    assert [(f['path'], f['percent_done'], f['priority']) for f in d['files']] == [
        ('Show S01/e01.mkv', 75.0, 'high'),
        ('Show S01/sample.mkv', 0.0, 'skip'),     # unwanted reads as skip
        ('Show S01/empty.nfo', 100.0, 'low'),     # a zero-byte file is complete
    ]
    info = d['info']
    assert info['ratio'] is None and info['done_date'] is None   # -1 / 0 mean "unknown"
    assert info['private'] is True
    assert info['trackers'] == [{'host': 'tracker.example.org', 'seeds': 12, 'leeches': None, 'message': 'Success'}]


def test_transmission_details_of_an_unknown_hash_is_none(monkeypatch):
    monkeypatch.setattr(tor, 'transmission_rpc', lambda *a, **k: {'torrents': []})
    assert tor.torrent_details('transmission', 'nope', config={'url': 'x'}) is None


def test_qbit_details_skips_peer_sources_and_maps_priorities(monkeypatch):
    from backend.web_app import qbittorrent as qb
    monkeypatch.setattr(qb, 'qbit_login', lambda cfg, timeout=20: (None, 'http://q'))
    replies = {
        'info': [{'hash': 'abc', 'name': 'Movie', 'state': 'downloading', 'progress': 0.25, 'size': 400}],
        'properties': {'share_ratio': 0.5, 'total_uploaded': 50, 'total_downloaded': 100,
                       'addition_date': 1700000000, 'completion_date': -1, 'pieces_num': 8,
                       'piece_size': 65536, 'comment': 'hi'},
        'files': [{'index': 0, 'name': 'Movie/movie.mkv', 'size': 400, 'progress': 0.25, 'priority': 7},
                  {'index': 1, 'name': 'Movie/extras.mkv', 'size': 100, 'progress': 0, 'priority': 0}],
        'trackers': [{'url': '** [DHT] **', 'num_seeds': 0},
                     {'url': 'https://t.example.net/announce', 'num_seeds': 3, 'num_leeches': 4, 'msg': ''}],
    }
    monkeypatch.setattr(qb, '_qbit_request', lambda cfg, path, **k: replies[path.split('/')[-1].split('?')[0]])
    d = tor.torrent_details('qbittorrent', 'abc', config={'url': 'x'})
    assert [(f['priority'], f['wanted'], f['downloaded']) for f in d['files']] == [('max', True, 100), ('skip', False, 0)]
    assert d['info']['done_date'] is None and d['info']['ratio'] == 0.5
    assert d['info']['trackers'] == [{'host': 't.example.net', 'seeds': 3, 'leeches': 4, 'message': None}]


def test_details_route_validates_and_404s(client, auth, monkeypatch):
    from backend.web_app.routes import torrent as route
    assert client.get('/api/torrent/details?client=nope&hash=a', headers=auth).status_code == 400
    assert client.get('/api/torrent/details?client=transmission', headers=auth).status_code == 400
    monkeypatch.setattr(route, 'torrent_details', lambda client, h: None)
    assert client.get('/api/torrent/details?client=transmission&hash=ABC', headers=auth).status_code == 404


# --- per-file priority ---------------------------------------------------------

def test_transmission_skip_and_priorities_map_to_torrent_set(monkeypatch):
    calls = []
    monkeypatch.setattr(tor, 'transmission_rpc', lambda method, args=None, config=None, timeout=20: calls.append((method, args)) or {})
    tor.torrent_set_file_priority('transmission', 'abc', [1, 2], 'skip', config={'url': 'x'})
    tor.torrent_set_file_priority('transmission', 'abc', [0], 'high', config={'url': 'x'})
    assert calls == [
        ('torrent-set', {'ids': ['abc'], 'files-unwanted': [1, 2]}),
        # a priority also makes a skipped file wanted again
        ('torrent-set', {'ids': ['abc'], 'files-wanted': [0], 'priority-high': [0]}),
    ]


def test_qbit_priorities_map_to_its_codes(monkeypatch):
    from backend.web_app import qbittorrent as qb
    sent = []
    monkeypatch.setattr(qb, '_qbit_request', lambda cfg, path, data=None, **k: sent.append((path, data)))
    tor.torrent_set_file_priority('qbittorrent', 'abc', [0, 3], 'max', config={'url': 'x'})
    tor.torrent_set_file_priority('qbittorrent', 'abc', [5], 'skip', config={'url': 'x'})
    assert sent == [('/api/v2/torrents/filePrio', {'hash': 'abc', 'id': '0|3', 'priority': 7}),
                    ('/api/v2/torrents/filePrio', {'hash': 'abc', 'id': '5', 'priority': 0})]


def test_a_level_the_client_lacks_is_refused():
    with pytest.raises(ValueError):
        tor.torrent_set_file_priority('transmission', 'abc', [0], 'max', config={'url': 'x'})
    with pytest.raises(ValueError):
        tor.torrent_set_file_priority('qbittorrent', 'abc', [0], 'low', config={'url': 'x'})


def test_file_priority_route_validates(client, auth, monkeypatch):
    from backend.web_app.routes import torrent as route
    post = lambda body: client.post('/api/torrent/files/priority', headers=auth, json=body)
    assert post({'client': 'transmission', 'indices': [0], 'priority': 'high'}).status_code == 400      # no hash
    assert post({'client': 'transmission', 'hash': 'a', 'indices': [], 'priority': 'high'}).status_code == 400
    assert post({'client': 'transmission', 'hash': 'a', 'indices': ['x'], 'priority': 'high'}).status_code == 400
    assert post({'client': 'transmission', 'hash': 'a', 'indices': [True], 'priority': 'high'}).status_code == 400
    seen = []
    monkeypatch.setattr(route, 'torrent_set_file_priority', lambda *a: seen.append(a))
    assert post({'client': 'qbittorrent', 'hash': 'ABC', 'indices': [1], 'priority': 'skip'}).status_code == 200
    assert seen == [('qbittorrent', 'abc', [1], 'skip')]

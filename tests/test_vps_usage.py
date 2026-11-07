"""backend/web_app/vps.py: credentials, the SSH session (one-shot and pooled)
and the usage snapshot's marker-split parsing. paramiko is replaced at the
module boundary; nothing here opens a socket."""
import json
import time

import pytest

from backend.web_app import vps


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

class FakeDB:
    def __init__(self, raw=None):
        self.raw = raw
        self.connections = []

    def get_setting(self, key):
        return self.raw

    def set_vps_watch_folder_connection(self, fid, host, port, username):
        self.connections.append((fid, host, port, username))


def test_credentials_are_decrypted_and_port_defaults(monkeypatch):
    from backend.utils import encrypt_secret
    raw = json.dumps({'host': 'box', 'username': 'u', 'password_enc': encrypt_secret('pw')})
    monkeypatch.setattr(vps, 'get_db', lambda: FakeDB(raw))
    assert vps.load_vps_credentials() == {'host': 'box', 'port': 22, 'username': 'u', 'password': 'pw'}


@pytest.mark.parametrize('raw', [None, '', 'not json', json.dumps({'username': 'u'}),
                                 json.dumps({'host': ''})])
def test_missing_or_broken_credentials_read_as_unconfigured(monkeypatch, raw):
    monkeypatch.setattr(vps, 'get_db', lambda: FakeDB(raw))
    assert vps.load_vps_credentials() is None


def test_annotating_folders_without_a_connection_marks_none_active(monkeypatch):
    db = FakeDB(None)
    monkeypatch.setattr(vps, 'get_db', lambda: db)
    folders = vps.annotate_vps_folders([{'id': 1, 'path': '/a'}, {'id': 2, 'path': '/b', 'host': 'box'}])
    assert [f['active'] for f in folders] == [False, False]
    assert db.connections == []            # nothing to adopt them into


def test_annotating_folders_adopts_legacy_rows_and_matches_on_host_user_port(monkeypatch):
    raw = json.dumps({'host': 'box', 'username': 'u', 'port': 2222, 'password_enc': ''})
    db = FakeDB(raw)
    monkeypatch.setattr(vps, 'get_db', lambda: db)
    folders = vps.annotate_vps_folders([
        {'id': 1, 'path': '/legacy'},                                              # no host: adopted
        {'id': 2, 'path': '/mine', 'host': 'box', 'username': 'u', 'port': 2222},
        {'id': 3, 'path': '/other-port', 'host': 'box', 'username': 'u', 'port': 22},
        {'id': 4, 'path': '/other-user', 'host': 'box', 'username': 'v', 'port': 2222},
    ])
    assert [f['active'] for f in folders] == [True, True, False, False]
    assert folders[0]['host'] == 'box' and folders[0]['port'] == 2222 and folders[0]['username'] == 'u'
    assert db.connections == [(1, 'box', 2222, 'u')]


# ---------------------------------------------------------------------------
# Opening a session
# ---------------------------------------------------------------------------

class FakeTransport:
    def __init__(self, active=True):
        self.active = active
        self.keepalive = None

    def set_keepalive(self, seconds):
        self.keepalive = seconds

    def is_active(self):
        return self.active


class FakeSSHClient:
    instances = []
    connect_error = None

    def __init__(self):
        self.connect_kwargs = None
        self.transport = FakeTransport()
        self.closed = False
        self.sftp = object()
        FakeSSHClient.instances.append(self)

    def set_missing_host_key_policy(self, policy):
        self.policy = policy

    def connect(self, **kwargs):
        self.connect_kwargs = kwargs
        if FakeSSHClient.connect_error:
            raise FakeSSHClient.connect_error

    def get_transport(self):
        return self.transport

    def open_sftp(self):
        return self.sftp

    def close(self):
        self.closed = True


@pytest.fixture
def fake_paramiko(monkeypatch):
    import paramiko
    FakeSSHClient.instances = []
    FakeSSHClient.connect_error = None
    monkeypatch.setattr(paramiko, 'SSHClient', FakeSSHClient)
    return FakeSSHClient


@pytest.fixture
def creds(monkeypatch):
    state = {'creds': {'host': 'box', 'port': 22, 'username': 'u', 'password': 'pw'}}
    monkeypatch.setattr(vps, 'load_vps_credentials', lambda: state['creds'])
    return state


def test_open_vps_sftp_connects_with_a_keepalive(fake_paramiko, creds):
    client, sftp = vps.open_vps_sftp(timeout=7)
    assert sftp is client.sftp
    kw = client.connect_kwargs
    assert kw['hostname'] == 'box' and kw['port'] == 22 and kw['username'] == 'u'
    assert kw['password'] == 'pw' and kw['timeout'] == 7
    assert kw['allow_agent'] is False and kw['look_for_keys'] is False
    assert client.transport.keepalive == 30


def test_open_vps_sftp_survives_a_missing_transport(fake_paramiko, creds, monkeypatch):
    monkeypatch.setattr(FakeSSHClient, 'get_transport', lambda self: None)
    client, _ = vps.open_vps_sftp()
    assert client.connect_kwargs is not None


def test_open_vps_sftp_refuses_without_config_or_password(fake_paramiko, creds):
    creds['creds'] = None
    with pytest.raises(ValueError, match='not configured'):
        vps.open_vps_sftp()
    creds['creds'] = {'host': 'box', 'port': 22, 'username': 'u', 'password': ''}
    with pytest.raises(ValueError, match='password'):
        vps.open_vps_sftp()
    assert fake_paramiko.instances == []


# ---------------------------------------------------------------------------
# The pooled session
# ---------------------------------------------------------------------------

@pytest.fixture
def pool(fake_paramiko, creds):
    vps.close_pooled_session()
    yield vps._POOL
    vps.close_pooled_session()


def test_the_pool_reuses_a_warm_session(pool):
    with vps.vps_session() as (c1, s1):
        pass
    with vps.vps_session() as (c2, s2):
        pass
    assert c1 is c2 and s1 is s2
    assert len(FakeSSHClient.instances) == 1
    assert c1.closed is False


def test_the_pool_reconnects_after_the_idle_timeout(pool):
    with vps.vps_session() as (c1, _):
        pass
    pool['at'] = time.time() - vps.IDLE_TIMEOUT - 1
    with vps.vps_session() as (c2, _):
        pass
    assert c2 is not c1 and c1.closed is True
    assert len(FakeSSHClient.instances) == 2


def test_the_pool_reconnects_when_the_transport_died(pool):
    with vps.vps_session() as (c1, _):
        pass
    c1.transport.active = False
    with vps.vps_session() as (c2, _):
        pass
    assert c2 is not c1 and c1.closed is True


def test_the_pool_reconnects_when_the_transport_is_gone(pool, monkeypatch):
    with vps.vps_session() as (c1, _):
        pass
    monkeypatch.setattr(c1, 'get_transport', lambda: None)
    with vps.vps_session() as (c2, _):
        pass
    assert c2 is not c1


def test_the_pool_reconnects_when_the_credentials_change(pool, creds):
    with vps.vps_session() as (c1, _):
        pass
    creds['creds'] = {**creds['creds'], 'host': 'other'}
    with vps.vps_session() as (c2, _):
        pass
    assert c2 is not c1 and c1.closed is True
    assert c2.connect_kwargs['hostname'] == 'other'


def test_a_transport_error_in_the_body_drops_the_session(pool):
    with pytest.raises(OSError):
        with vps.vps_session() as (c1, _):
            raise OSError('socket closed')
    assert c1.closed is True
    assert pool['client'] is None
    with vps.vps_session() as (c2, _):
        pass
    assert c2 is not c1


def test_a_value_error_in_the_body_keeps_the_session(pool):
    with pytest.raises(ValueError):
        with vps.vps_session() as (c1, _):
            raise ValueError('bad path')
    assert c1.closed is False
    with vps.vps_session() as (c2, _):
        pass
    assert c2 is c1


def test_the_pool_releases_its_lock_when_opening_fails(pool, creds, fake_paramiko):
    fake_paramiko.connect_error = OSError('refused')
    with pytest.raises(OSError):
        with vps.vps_session():
            pass
    # An RLock lets its own thread back in, so a leaked hold only shows from
    # another thread: a non-blocking acquire there must succeed.
    import threading
    got = []

    def probe():
        ok = vps._POOL_LOCK.acquire(blocking=False)
        got.append(ok)
        if ok:
            vps._POOL_LOCK.release()

    t = threading.Thread(target=probe)
    t.start()
    t.join(1)
    assert got == [True]


def test_the_pool_refuses_without_a_connection(pool, creds):
    creds['creds'] = None
    with pytest.raises(ValueError, match='not configured'):
        with vps.vps_session():
            pass


def test_closing_the_pool_closes_the_client_and_tolerates_a_bad_close(pool):
    with vps.vps_session() as (c1, _):
        pass
    c1.close = lambda: (_ for _ in ()).throw(OSError('already gone'))
    vps.close_pooled_session()          # must not raise
    assert pool['client'] is None and pool['key'] is None


# ---------------------------------------------------------------------------
# The usage snapshot
# ---------------------------------------------------------------------------

QUOTA = """Disk quotas for user tester (uid 1001):
     Filesystem  blocks   quota   limit   grace   files   quota   limit   grace
      /dev/sdu1 384836764  1953125000       0             302       0       0
"""
DF = """Filesystem     1024-blocks       Used  Available Capacity Mounted on
/dev/sdu1      17507329500 8426489932 8905039924      49% /home6
"""
CPU = "96\n16.00 16.52 15.95 9/15324 223984\n"
NET = """Inter-|   Receive                         |  Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
    lo: 3616508458330 2293207953 0 0 0 0 0 0 3616508458330 2293207953 0 0 0 0 0 0
  eth0: 102575421072169 163605332132 0 20245 20231 0 0 906724442 382432947865665 287469378896 0 0 0 0 0 0
"""


def _output(quota=QUOTA, df=DF, cpu=CPU, net=NET, err=''):
    return (quota + '@@DF@@\n' + df + '@@CPU@@\n' + cpu + '@@NET@@\n' + net, err)


@pytest.fixture
def exec_box(monkeypatch):
    """`open_vps_sftp` returning a client whose exec_command replies from a script."""
    state = {'out': _output(), 'cmds': [], 'client': None}

    class Stream:
        def __init__(self, data):
            self.data = data.encode() if isinstance(data, str) else data

        def read(self):
            return self.data

    class Sftp:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True
            if state.get('sftp_close_error'):
                raise OSError('already closed')

    class Client:
        def __init__(self):
            self.closed = False
            self.sftp = Sftp()

        def exec_command(self, cmd, timeout=None):
            state['cmds'].append((cmd, timeout))
            out, err = state['out']
            return None, Stream(out), Stream(err)

        def close(self):
            self.closed = True

    def open_sftp(timeout=10):
        state['client'] = Client()
        return state['client'], state['client'].sftp

    monkeypatch.setattr(vps, 'open_vps_sftp', open_sftp)
    return state


def test_snapshot_runs_one_command_and_closes_everything(exec_box):
    snap = vps.vps_usage_snapshot(timeout=9)
    assert len(exec_box['cmds']) == 1
    cmd, timeout = exec_box['cmds'][0]
    assert timeout == 9
    assert 'quota -w' in cmd and '@@DF@@' in cmd and '@@CPU@@' in cmd and '@@NET@@' in cmd
    assert exec_box['client'].closed is True and exec_box['client'].sftp.closed is True

    assert snap['disk'] == {'used': 384836764 * 1024, 'limit': 1953125000 * 1024,
                            'filesystem': '/dev/sdu1', 'percent': 19.7, 'source': 'quota'}
    assert snap['volume']['mount'] == '/home6' and snap['volume']['percent'] == 48.1
    assert snap['load'] == {'load1': 16.0, 'load5': 16.52, 'load15': 15.95, 'cores': 96, 'percent': 16.7}
    assert snap['net'] == {'iface': 'eth0', 'rx_bytes': 102575421072169, 'tx_bytes': 382432947865665}


def test_snapshot_falls_back_to_df_when_no_quota_is_set(exec_box):
    exec_box['out'] = _output(quota='')
    disk = vps.vps_usage_snapshot()['disk']
    assert disk['source'] == 'df'
    assert disk['used'] == 8426489932 * 1024
    assert disk['limit'] == (8426489932 + 8905039924) * 1024
    assert disk['filesystem'] == '/dev/sdu1' and disk['percent'] == 48.1


def test_snapshot_treats_a_zero_quota_limit_as_no_quota(exec_box):
    exec_box['out'] = _output(quota='      /dev/sdu1 100  0  0  none  1 0 0\n')
    assert vps.vps_usage_snapshot()['disk']['source'] == 'df'


def test_snapshot_reports_nothing_when_the_box_exposes_nothing(exec_box):
    exec_box['out'] = _output(quota='', df='', cpu='', net='')
    snap = vps.vps_usage_snapshot()
    assert snap == {'disk': None, 'volume': None, 'load': None, 'net': None}


def test_snapshot_survives_stderr_noise_and_a_missing_loadavg(exec_box):
    # stderr is appended after stdout, so a shell warning lands past the last
    # marker and must not disturb the net parse; nproc alone is not a load.
    exec_box['out'] = _output(cpu='8\n', err='bash: warning: setlocale: LC_ALL: cannot change locale\n')
    snap = vps.vps_usage_snapshot()
    assert snap['load'] is None
    assert snap['net']['iface'] == 'eth0'
    assert snap['disk']['source'] == 'quota'


def test_snapshot_tolerates_a_failing_sftp_close(exec_box):
    exec_box['sftp_close_error'] = True
    assert vps.vps_usage_snapshot()['disk']['source'] == 'quota'
    assert exec_box['client'].closed is True


def test_the_back_compat_disk_wrapper_returns_only_the_disk(exec_box):
    assert vps.vps_disk_usage()['source'] == 'quota'


# --- the parsers' odd inputs the main parser tests leave out -----------------

def test_quota_skips_unparsable_device_lines():
    assert vps._parse_quota('/dev/sdu1 lots more none\n/dev/sdu2 10 20 0 none 1 0 0')[0] == 10 * 1024


def test_df_skips_short_and_unparsable_lines():
    text = 'Filesystem 1024-blocks Used Available Capacity Mounted on\nshort line\n' \
           '/dev/x a b c 1% /m\n/dev/y 100 40 60 40% /n'
    assert vps._parse_df(text)['mount'] == '/n'
    assert vps._parse_df('header only\n/dev/z 0 0 0 0% /zero')['percent'] is None


def test_loadavg_rejects_non_numeric_loads():
    assert vps._parse_loadavg('a b c', '4') is None


def test_netdev_skips_malformed_rows():
    text = ' eth0: not numbers\n eth1: 1 2 3\n eth2: 5 0 0 0 0 0 0 0 7 0 0 0 0 0 0 0\n : 1 1 1 1 1 1 1 1 1'
    assert vps._parse_netdev(text) == {'iface': 'eth2', 'rx_bytes': 5, 'tx_bytes': 7}


def test_the_pool_tolerates_a_client_that_fails_to_close(pool):
    def bad_close():
        raise OSError('already gone')
    # ...when reconnecting over a stale one
    with vps.vps_session() as (c1, _):
        pass
    c1.transport.active = False
    c1.close = bad_close
    with vps.vps_session() as (c2, _):
        pass
    assert c2 is not c1
    # ...and when dropping it after a transport error in the body
    c2.close = bad_close
    with pytest.raises(OSError, match='socket'):
        with vps.vps_session():
            raise OSError('socket closed')
    assert pool['client'] is None


def test_netdev_skips_a_row_whose_counters_are_not_numbers():
    text = ' eth0: a b c d e f g h i j\n eth2: 5 0 0 0 0 0 0 0 7 0 0 0 0 0 0 0'
    assert vps._parse_netdev(text)['iface'] == 'eth2'

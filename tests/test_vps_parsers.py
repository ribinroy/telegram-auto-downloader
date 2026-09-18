"""Parsers for what the seedbox reports over SSH. These read another machine's
command output, so malformed and missing input is the normal case."""
import pytest

from backend.web_app import vps

QUOTA = """Filesystem  blocks   quota   limit   grace   files   quota   limit   grace
      /dev/sdu1 384836764  1953125000       0             302       0       0"""

DF = """Filesystem     1024-blocks       Used  Available Capacity Mounted on
/dev/sdu1      17507329500 8426489932 8905039924      49% /home6"""

NETDEV = """Inter-|   Receive                         |  Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
    lo: 3616508458330 2293207953 0 0 0 0 0 0 3616508458330 2293207953 0 0 0 0 0 0
  eth0: 102575421072169 163605332132 0 20245 20231 0 0 906724442 382432947865665 287469378896 0 0 0 0 0 0
vethc979831: 51583594737 10214578 0 0 0 0 0 0 2424966488 18482048 0 0 0 0 0 0
  eth1: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"""


# --- quota ----------------------------------------------------------------

def test_quota_reports_bytes_from_1k_blocks():
    used, limit, fs = vps._parse_quota(QUOTA)
    assert used == 384836764 * 1024
    assert limit == 1953125000 * 1024
    assert fs == '/dev/sdu1'


def test_quota_uses_the_hard_limit_when_no_soft_one_is_set():
    used, limit, _ = vps._parse_quota('      /dev/sdu1 100  0  400000  none  1 0 0')
    assert limit == 400000 * 1024


def test_quota_takes_the_smaller_of_two_limits():
    _, limit, _ = vps._parse_quota('      /dev/sdu1 100  900  400  none  1 0 0')
    assert limit == 400 * 1024


def test_quota_tolerates_the_over_quota_asterisk():
    used, _, _ = vps._parse_quota('      /dev/sdu1 500*  400  0  7days  1 0 0')
    assert used == 500 * 1024


@pytest.mark.parametrize('text', ['', 'quota: command not found',
                                  'Disk quotas for user x (uid 1): none', None])
def test_quota_returns_none_when_there_is_nothing_to_read(text):
    assert vps._parse_quota(text) is None


# --- df -------------------------------------------------------------------

def test_df_reports_the_volume():
    got = vps._parse_df(DF)
    assert got['mount'] == '/home6'
    assert got['total'] == 17507329500 * 1024
    assert got['percent'] == 48.1


@pytest.mark.parametrize('text', ['', 'df: no such file', None])
def test_df_returns_none_on_junk(text):
    assert vps._parse_df(text) is None


# --- load -----------------------------------------------------------------

def test_load_is_reported_against_the_core_count():
    got = vps._parse_loadavg('16.00 16.52 15.95 9/15324 223984', '96')
    assert (got['load1'], got['load5'], got['load15']) == (16.0, 16.52, 15.95)
    assert got['cores'] == 96
    assert got['percent'] == 16.7


def test_load_without_a_core_count_reports_no_percentage():
    got = vps._parse_loadavg('1.00 1.00 1.00', '')
    assert got['cores'] == 0 and got['percent'] is None


@pytest.mark.parametrize('text', ['', 'garbage', None])
def test_load_returns_none_on_junk(text):
    assert vps._parse_loadavg(text, '4') is None


# --- /proc/net/dev --------------------------------------------------------

def test_netdev_picks_the_busiest_physical_interface():
    got = vps._parse_netdev(NETDEV)
    assert got['iface'] == 'eth0'          # not lo, not the veth
    assert got['rx_bytes'] == 102575421072169
    assert got['tx_bytes'] == 382432947865665


def test_netdev_skips_virtual_interfaces_even_when_busy():
    busy_veth = """ face |bytes ...
    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
docker0: 888 1 0 0 0 0 0 0 888 1 0 0 0 0 0 0
  eth0: 10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0"""
    assert vps._parse_netdev(busy_veth)['iface'] == 'eth0'


def test_netdev_ignores_an_interface_with_no_traffic():
    assert vps._parse_netdev('  eth1: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0') is None


@pytest.mark.parametrize('text', ['', 'nonsense', None])
def test_netdev_returns_none_on_junk(text):
    assert vps._parse_netdev(text) is None

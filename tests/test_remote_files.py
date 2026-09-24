"""The VPS as an explorer drive. Every test drives a FakeSFTP - no seedbox."""
import contextlib
import pytest

from backend import remote_files as rfs
from backend.files import FsError


@pytest.fixture
def remote(monkeypatch, fake_sftp):
    """Point vps_session at the fake, and give the account a quota."""
    class FakeClient:
        def exec_command(self, cmd, timeout=None):
            out = ('      /dev/sdu1 100000  200000  0   1 0 0\n'
                   '@@DF@@\nFilesystem 1024-blocks Used Available Capacity Mounted on\n'
                   '/dev/sdu1 500000 100000 400000 20% /home6\n')
            stream = type('S', (), {'read': lambda self, _o=out: _o.encode()})()
            return None, stream, type('S', (), {'read': lambda self: b''})()

    @contextlib.contextmanager
    def session(timeout=15):
        yield FakeClient(), fake_sftp

    monkeypatch.setattr(rfs, 'vps_session', session)
    rfs._quota_cache.update(at=0.0, usage=None)
    return fake_sftp


# --- path scheme ----------------------------------------------------------

def test_is_remote_only_matches_the_prefix():
    assert rfs.is_remote('vps:/home6/x') is True
    assert rfs.is_remote('/mnt/disk') is False
    assert rfs.is_remote(None) is False


def test_any_remote_spots_a_mixed_selection():
    assert rfs.any_remote(['/a', 'vps:/b']) is True
    assert rfs.any_remote(['/a', '/b']) is False
    assert rfs.any_remote([]) is False


def test_strip_and_tag_round_trip():
    assert rfs.strip('vps:/home6/x') == '/home6/x'
    assert rfs.tag('/home6/x') == 'vps:/home6/x'
    assert rfs.strip('/already/local') == '/already/local'


def test_the_sidebar_root_resolves_to_the_login_home():
    """vps:~ means "wherever this login lands", which only the far end knows."""
    assert rfs.strip('vps:~') == ''
    assert rfs.strip('vps:') == ''


# --- roots ----------------------------------------------------------------

def test_no_root_when_the_vps_is_not_configured(monkeypatch):
    monkeypatch.setattr(rfs, 'load_vps_credentials', lambda: None)
    assert rfs.list_roots() == []


def test_root_is_built_without_touching_ssh(monkeypatch):
    """The explorer fetches roots on every page load; it must not wait on a
    login across the internet."""
    monkeypatch.setattr(rfs, 'load_vps_credentials',
                        lambda: {'host': 'box.example', 'username': 'u', 'port': 22, 'password': 'p'})
    monkeypatch.setattr(rfs, 'vps_session', None)  # would explode if used
    root = rfs.list_roots()[0]
    assert root['path'] == 'vps:~'
    assert root['group'] == 'drive' and root['kind'] == 'vps'
    assert root['writable'] is False
    assert root['usage'] is None


# --- listing --------------------------------------------------------------

def test_listing_the_root_lands_in_the_home_directory(remote):
    got = rfs.list_dir('vps:~')
    assert got['path'] == 'vps:/home6/tester'


def test_entries_carry_the_prefix_and_the_remote_flag(remote):
    entries = {e['name']: e for e in rfs.list_dir('vps:~')['entries']}
    assert entries['downloads']['path'] == 'vps:/home6/tester/downloads'
    assert entries['downloads']['is_dir'] is True
    assert entries['notes.txt']['remote'] is True
    assert entries['notes.txt']['size'] == 12


def test_hidden_entries_are_filtered_by_default(remote):
    names = [e['name'] for e in rfs.list_dir('vps:~')['entries']]
    assert '.cache' not in names
    names = [e['name'] for e in rfs.list_dir('vps:~', show_hidden=True)['entries']]
    assert '.cache' in names


def test_folders_sort_before_files(remote):
    entries = rfs.list_dir('vps:~')['entries']
    assert entries[0]['is_dir'] is True


def test_the_tree_stops_at_the_login_home(remote):
    """Above it is the provider's shared /homeN, which the account cannot
    list - offering an "up" that can only fail is worse than none."""
    assert rfs.list_dir('vps:~')['parent'] is None
    sub = rfs.list_dir('vps:/home6/tester/downloads')
    assert sub['parent'] == 'vps:/home6/tester'


def test_home_is_reported_so_the_breadcrumb_can_stop_there(remote):
    assert rfs.list_dir('vps:~')['home'] == 'vps:/home6/tester'


def test_a_remote_listing_is_never_writable(remote):
    got = rfs.list_dir('vps:~')
    assert got['writable'] is False
    assert got['trash'] is None


def test_capacity_comes_from_the_account_quota(remote):
    usage = rfs.list_dir('vps:~')['usage']
    assert usage['used'] == 100000 * 1024
    assert usage['total'] == 200000 * 1024
    assert usage['percent'] == 50.0


def test_an_unreadable_directory_is_403_not_404(remote):
    """Reporting "not found" sends you hunting for a folder that is really
    just someone else's business."""
    with pytest.raises(FsError) as e:
        rfs.list_dir('vps:/home6')
    assert e.value.status == 403
    assert 'ermission' in e.value.message


# --- search / size / delete ----------------------------------------------

def test_search_needs_two_characters(remote):
    with pytest.raises(FsError):
        rfs.search('vps:~', 'a')


def test_search_walks_into_subdirectories(remote):
    got = rfs.search('vps:~', 'ep01')
    assert [e['name'] for e in got['entries']] == ['ep01.mkv']
    assert got['entries'][0]['path'].startswith('vps:')


def test_search_honours_the_result_cap(remote):
    got = rfs.search('vps:~', 'mkv', limit=1)
    assert len(got['entries']) == 1
    assert got['truncated'] is True


def test_size_of_a_file_needs_no_du(remote):
    got = rfs.dir_size('vps:/home6/tester/notes.txt')
    assert got['size'] == 12 and got['files'] == 1


def test_delete_is_always_permanent(remote):
    """There is no trash on someone else's box, and inventing one in a seedbox
    home would be worse than saying so."""
    got = rfs.delete(['vps:/home6/tester/notes.txt'])
    assert got['permanent'] is True
    assert got['removed'] == ['vps:/home6/tester/notes.txt']
    assert '/home6/tester/notes.txt' in remote.removed


def test_delete_reports_per_path_errors_without_aborting(remote):
    got = rfs.delete(['vps:/home6/tester/missing', 'vps:/home6/tester/notes.txt'])
    assert len(got['errors']) == 1
    assert got['removed'] == ['vps:/home6/tester/notes.txt']

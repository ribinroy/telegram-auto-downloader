"""The remote drive's less-trodden paths: symlinks in a listing, a home the
far end cannot resolve, the quota probe failing or falling back to df, the
search deadline, `du` on a folder, text preview and recursive delete. Still
no seedbox: FakeSFTP throughout."""
import contextlib
import stat as st

import pytest

from backend import remote_files as rfs
from backend.files import FsError
from tests.conftest import FakeSFTP


def own_time(monkeypatch, module, **overrides):
    """Give `module` its own copy of the time module with some functions
    replaced, so the patch is invisible to every other thread in the process."""
    import time as _time
    import types as _types
    ns = _types.SimpleNamespace(**{k: getattr(_time, k) for k in dir(_time) if not k.startswith('_')})
    for k, v in overrides.items():
        setattr(ns, k, v)
    monkeypatch.setattr(module, 'time', ns)
    return ns


class LinkySFTP(FakeSFTP):
    """FakeSFTP with symlinks: `links` maps name -> target path (None for a
    dangling link), listed with S_IFLNK and resolved through stat()."""

    def __init__(self, tree, links, home='/home6/tester'):
        super().__init__(tree, home=home)
        self.links = links
        self.opened = []

    def listdir_attr(self, path):
        out = super().listdir_attr(path)
        if path != self.home:
            return out
        for name, _target in self.links.items():
            attr = type('Attr', (), {})()
            attr.filename, attr.st_mode, attr.st_size, attr.st_mtime = name, st.S_IFLNK | 0o777, 0, 1700000000
            out.append(attr)
        return out

    def stat(self, path):
        name = path.rsplit('/', 1)[-1]
        if name in self.links:
            target = self.links[name]
            if target is None:
                raise IOError(2, 'No such file')
            return super().stat(target)
        return super().stat(path)

    def open(self, path, mode='rb'):
        self.opened.append(path)
        data = b'line one\nline two\n' if path.endswith('notes.txt') else b'\xff' * 100

        class F:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n):
                return data[:n]
        return F()


class Client:
    def __init__(self, text='', fail=False):
        self.text, self.fail, self.commands = text, fail, []

    def exec_command(self, cmd, timeout=None):
        self.commands.append(cmd)
        if self.fail:
            raise OSError('channel closed')
        out = type('S', (), {'read': lambda self, _o=self.text: _o.encode()})()
        return None, out, type('S', (), {'read': lambda self: b''})()


@pytest.fixture
def remote(monkeypatch):
    sftp = LinkySFTP({
        '/home6/tester': {'downloads': None, 'notes.txt': 18, '.cache': None},
        '/home6/tester/downloads': {'Show': None, 'movie.mkv': 4096},
        '/home6/tester/downloads/Show': {'ep01.mkv': 2048},
    }, links={'dl-link': '/home6/tester/downloads', 'dangling': None})
    client = Client()

    @contextlib.contextmanager
    def session(timeout=15):
        yield client, sftp

    monkeypatch.setattr(rfs, 'vps_session', session)
    rfs._quota_cache.update(at=0.0, usage=None)
    return sftp, client


# --- listing ----------------------------------------------------------------

def test_a_symlinked_folder_lists_as_a_folder_and_a_dangling_one_as_broken(remote):
    entries = {e['name']: e for e in rfs.list_dir('vps:~')['entries']}
    assert entries['dl-link']['is_dir'] is True and entries['dl-link']['is_link'] is True
    dangling = entries['dangling']
    assert dangling['broken'] is True and dangling['is_dir'] is False and dangling['size'] == 0
    assert dangling['modified'] is None and dangling['mode'] is None


def test_stat_entry_describes_one_remote_path(remote):
    got = rfs.stat_entry('vps:/home6/tester/notes.txt')
    assert got['path'] == 'vps:/home6/tester/notes.txt' and got['size'] == 18 and got['remote']
    folder = rfs.stat_entry('vps:/home6/tester/downloads/')
    assert folder['is_dir'] and folder['name'] == 'downloads'
    with pytest.raises(FsError) as e:
        rfs.stat_entry('vps:/home6/tester/nothing')
    assert e.value.status == 404


def test_a_home_the_far_end_cannot_resolve_falls_back_to_root(remote):
    sftp, _client = remote
    real = sftp.normalize

    def normalize(path):
        if path in ('.', '', '~'):
            raise IOError(2, 'No home')
        return real(path)
    sftp.normalize = normalize
    got = rfs.list_dir('vps:/home6/tester/downloads')
    assert got['home'] == 'vps:/' and got['parent'] == 'vps:/home6/tester'
    with pytest.raises(FsError) as e:
        rfs.list_dir('vps:~')
    assert e.value.status == 404


def test_other_io_errors_are_404s(remote):
    sftp, _client = remote
    real = sftp.listdir_attr
    sftp.listdir_attr = lambda p: (_ for _ in ()).throw(IOError(5, 'I/O error')) if p.endswith('Show') else real(p)
    with pytest.raises(FsError) as e:
        rfs.list_dir('vps:/home6/tester/downloads/Show')
    assert e.value.status == 404 and 'I/O error' in e.value.message


# --- quota ------------------------------------------------------------------

def test_the_quota_probe_falls_back_to_df_and_then_gives_up(remote):
    _sftp, client = remote
    client.text = ('@@DF@@\nFilesystem 1024-blocks Used Available Capacity Mounted on\n'
                   '/dev/sdu1 500000 100000 400000 20% /home6\n')
    usage = rfs.list_dir('vps:~')['usage']
    assert usage['used'] == 100000 * 1024 and usage['total'] == 500000 * 1024 and usage['percent'] == 20.0
    assert len(client.commands) == 1

    assert rfs.list_dir('vps:~')['usage'] == usage                 # cached: no second probe
    assert len(client.commands) == 1

    rfs._quota_cache.update(at=0.0, usage=None)
    client.text = 'garbage'
    assert rfs.list_dir('vps:~')['usage'] is None
    rfs._quota_cache.update(at=0.0, usage=None)
    client.fail = True
    assert rfs.list_dir('vps:~')['usage'] is None


# --- search / size / text / delete ------------------------------------------------

def test_search_skips_unlistable_folders_and_stops_at_the_deadline(remote, monkeypatch):
    sftp, _client = remote
    sftp.restricted.add('/home6/tester/downloads/Show')
    got = rfs.search('vps:~', 'mkv')
    assert [e['name'] for e in got['entries']] == ['movie.mkv']    # ep01 sits behind the wall
    assert got['truncated'] is False

    clock = iter([0.0, 100.0, 200.0])
    own_time(monkeypatch, rfs, monotonic=lambda: next(clock))
    got = rfs.search('vps:~', 'mkv', timeout=10)
    assert got['truncated'] is True and got['entries'] == []


def test_dir_size_runs_du_over_the_folder(remote):
    _sftp, client = remote
    client.text = '12345\t/home6/tester/downloads\n@@N@@\n2\n1\n'
    got = rfs.dir_size('vps:/home6/tester/downloads')
    assert got == {'path': 'vps:/home6/tester/downloads', 'size': 12345, 'files': 2, 'dirs': 1, 'partial': False}
    assert "du -sb '/home6/tester/downloads'" in client.commands[-1]

    client.text = 'du: cannot read\n@@N@@\n'
    with pytest.raises(FsError, match='measure'):
        rfs.dir_size('vps:/home6/tester/downloads')
    with pytest.raises(FsError) as e:
        rfs.dir_size('vps:/home6/tester/nothing')
    assert e.value.status == 404


def test_dir_size_quotes_a_folder_name_with_an_apostrophe(remote):
    sftp, client = remote
    sftp.tree['/home6/tester']["it's"] = None
    sftp.tree["/home6/tester/it's"] = {}
    client.text = '1\n@@N@@\n0\n0\n'
    rfs.dir_size("vps:/home6/tester/it's")
    assert "'/home6/tester/it'\\''s'" in client.commands[-1]


def test_read_text_previews_a_file_head(remote):
    sftp, _client = remote
    got = rfs.read_text('vps:/home6/tester/notes.txt', max_bytes=8)
    assert got == {'path': 'vps:/home6/tester/notes.txt', 'text': 'line one', 'truncated': True, 'size': 18}
    assert sftp.opened == ['/home6/tester/notes.txt']
    binary = rfs.read_text('vps:/home6/tester/downloads/movie.mkv')
    assert '�' in binary['text']                                   # undecodable bytes replaced
    with pytest.raises(FsError, match='Not a file'):
        rfs.read_text('vps:/home6/tester/downloads')
    with pytest.raises(FsError) as e:
        rfs.read_text('vps:/home6/tester/nothing.txt')
    assert e.value.status == 404


def test_delete_walks_a_folder_bottom_up(remote):
    sftp, _client = remote
    got = rfs.delete(['vps:/home6/tester/downloads'])
    assert got['removed'] == ['vps:/home6/tester/downloads'] and got['errors'] == []
    assert sftp.removed == ['/home6/tester/downloads/Show/ep01.mkv', '/home6/tester/downloads/Show',
                            '/home6/tester/downloads/movie.mkv', '/home6/tester/downloads']

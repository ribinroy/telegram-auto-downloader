"""Shared test setup.

Two rules the whole suite depends on:

* **Nothing touches the real deployment.** DOWNLOAD_DIR, SCREENSHOTS_DIR and the
  database URL are redirected to a temp directory *before* backend.config is
  imported, because that module creates its directories at import time. Import
  order in this file is therefore load-bearing.
* **Nothing touches the network.** A seedbox, a Telegram account and two torrent
  clients are not test fixtures; every module that reaches out is stubbed at its
  own boundary by the test that needs it.
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# --- redirect the app's writable paths before backend.config lands ----------
_TMP = Path(tempfile.mkdtemp(prefix='downlee-tests-'))
os.environ.setdefault('DOWNLOAD_DIR', str(_TMP / 'downloads'))
os.environ.setdefault('SCREENSHOTS_DIR', str(_TMP / 'thumbs'))
os.environ.setdefault('DATABASE_URL', f'sqlite:///{_TMP / "test.db"}')
os.environ.setdefault('JWT_SECRET', 'test-secret-not-a-real-key')
os.environ.setdefault('SKIP_STARTUP_GREETING', '1')

import pytest  # noqa: E402


@pytest.fixture
def tmp_tree(tmp_path):
    """A small directory tree: dir with a file, a nested dir, a hidden file."""
    (tmp_path / 'Movies').mkdir()
    (tmp_path / 'Movies' / 'a.mkv').write_bytes(b'x' * 10)
    (tmp_path / 'Movies' / 'nested').mkdir()
    (tmp_path / 'Movies' / 'nested' / 'b.mp4').write_bytes(b'y' * 20)
    (tmp_path / '.hidden').write_text('secret')
    (tmp_path / 'notes.txt').write_text('hello world\n')
    return tmp_path


class FakeSFTP:
    """Minimal paramiko SFTPClient stand-in driven by a dict tree.

    `tree` maps an absolute posix dir -> {name: size or None}, where None means
    "this entry is a directory".
    """

    def __init__(self, tree, home='/home6/tester', restricted=()):
        self.tree = tree
        self.home = home
        # Dirs that exist and resolve, but refuse to be listed - the shared
        # /homeN above a seedbox account behaves exactly like this.
        self.restricted = set(restricted)
        self.removed = []

    def normalize(self, path):
        if path in ('.', '', '~'):
            return self.home
        path = path.rstrip('/') or '/'
        # realpath() resolves a path it has no permission to read into, so the
        # fake must not turn an unreadable directory into "no such file".
        if (path not in self.tree and path not in self.restricted
                and path not in self._all_files()):
            raise IOError(2, 'No such file')
        return path

    def _all_files(self):
        out = set()
        for d, entries in self.tree.items():
            for name in entries:
                out.add(d.rstrip('/') + '/' + name)
        return out

    def listdir_attr(self, path):
        import stat as st
        if path in self.restricted:
            raise IOError(13, 'Permission denied')
        if path not in self.tree:
            raise IOError(2, 'No such file')
        out = []
        for name, size in self.tree[path].items():
            attr = type('Attr', (), {})()
            attr.filename = name
            attr.st_mode = (st.S_IFDIR | 0o755) if size is None else (st.S_IFREG | 0o644)
            attr.st_size = 0 if size is None else size
            attr.st_mtime = 1700000000
            out.append(attr)
        return out

    def stat(self, path):
        import stat as st
        path = path.rstrip('/') or '/'
        attr = type('Attr', (), {})()
        attr.filename = path.rsplit('/', 1)[-1]
        if path in self.tree:
            attr.st_mode = st.S_IFDIR | 0o755
            attr.st_size = 0
        else:
            parent, _, name = path.rpartition('/')
            entries = self.tree.get(parent or '/', {})
            if name not in entries:
                raise IOError(2, 'No such file')
            attr.st_mode = st.S_IFREG | 0o644
            attr.st_size = entries[name] or 0
        attr.st_mtime = 1700000000
        return attr

    def remove(self, path):
        self.removed.append(path)

    def rmdir(self, path):
        self.removed.append(path)

    def close(self):
        pass


@pytest.fixture
def fake_sftp():
    return FakeSFTP({
        '/home6/tester': {'downloads': None, 'notes.txt': 12, '.cache': None},
        '/home6/tester/downloads': {'Show.S01': None, 'movie.mkv': 4096},
        '/home6/tester/downloads/Show.S01': {'ep01.mkv': 2048},
        '/home6/tester/.cache': {},
    }, restricted=('/home6',))

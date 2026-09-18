"""Local filesystem layer. The guards here are the only thing between a web
session and the operating system, so they get the most attention."""
import os
import pytest

from backend import files as fs
from backend.files import FsError


# --- resolve_path ---------------------------------------------------------

def test_resolve_path_requires_something():
    with pytest.raises(FsError) as e:
        fs.resolve_path('')
    assert 'required' in e.value.message


def test_resolve_path_requires_an_absolute_path():
    with pytest.raises(FsError) as e:
        fs.resolve_path('relative/thing')
    assert 'absolute' in e.value.message


def test_resolve_path_404s_on_a_missing_path(tmp_path):
    with pytest.raises(FsError) as e:
        fs.resolve_path(str(tmp_path / 'nope'))
    assert e.value.status == 404


def test_resolve_path_collapses_traversal(tmp_tree):
    got = fs.resolve_path(str(tmp_tree / 'Movies' / '..' / 'notes.txt'))
    assert got == (tmp_tree / 'notes.txt').resolve()


def test_follow_false_keeps_the_final_component(tmp_tree):
    """So deleting or renaming a symlink acts on the link, not its target."""
    link = tmp_tree / 'link.mkv'
    link.symlink_to(tmp_tree / 'Movies' / 'a.mkv')
    assert fs.resolve_path(str(link), follow=False).name == 'link.mkv'
    assert fs.resolve_path(str(link), follow=True).name == 'a.mkv'


# --- write guards ---------------------------------------------------------

@pytest.mark.parametrize('protected', ['/etc', '/usr', '/boot', '/etc/ssh', '/usr/bin/x'])
def test_guard_write_refuses_the_operating_system(protected):
    with pytest.raises(FsError) as e:
        fs.guard_write(protected)
    assert e.value.status == 403


def test_a_protected_root_on_its_own_mount_is_still_protected(monkeypatch):
    """Regression: /boot is a separate mount on plenty of machines, and the
    "not on / means it is a data disk" shortcut used to wave it straight
    through - PROTECTED_ROOTS was never consulted."""
    monkeypatch.setattr(fs, '_mountpoint_for', lambda p: '/boot')
    for path in ('/boot', '/boot/efi', '/boot/vmlinuz'):
        with pytest.raises(FsError) as e:
            fs.guard_write(path)
        assert e.value.status == 403


def test_guard_write_refuses_the_filesystem_root():
    with pytest.raises(FsError) as e:
        fs.guard_write('/')
    assert e.value.status == 403


def test_guard_write_allows_an_ordinary_directory(tmp_tree):
    fs.guard_write(str(tmp_tree / 'Movies'))  # must not raise


def test_guard_target_refuses_a_mount_point():
    with pytest.raises(FsError) as e:
        fs.guard_target('/')
    assert e.value.status == 403


def test_readonly_mode_refuses_every_write(tmp_tree, monkeypatch):
    monkeypatch.setattr(fs, 'EXPLORER_READONLY', True)
    with pytest.raises(FsError) as e:
        fs.guard_write(str(tmp_tree / 'Movies'))
    assert e.value.status == 403


# --- _safe_name -----------------------------------------------------------

@pytest.mark.parametrize('bad', ['', '   ', '.', '..', 'a/b', 'a\\b', '\x00'])
def test_safe_name_rejects_traversal_and_separators(bad):
    with pytest.raises(FsError):
        fs._safe_name(bad)


def test_safe_name_accepts_an_ordinary_component():
    assert fs._safe_name(' movie.mkv ') == 'movie.mkv'


# --- kind_for -------------------------------------------------------------

@pytest.mark.parametrize('name,kind', [
    ('a.mkv', 'video'), ('a.JPG', 'image'), ('a.flac', 'audio'),
    ('a.zip', 'archive'), ('a.pdf', 'document'), ('a.txt', 'text'),
    ('a.unknownext', 'file'), ('noext', 'file'),
])
def test_kind_for_classifies_by_extension(name, kind):
    assert fs.kind_for(name) == kind


def test_kind_for_directory_wins_over_extension():
    assert fs.kind_for('folder.mkv', is_dir=True) == 'folder'


# --- listing --------------------------------------------------------------

def test_list_dir_hides_dotfiles_by_default(tmp_tree):
    names = [e['name'] for e in fs.list_dir(str(tmp_tree))['entries']]
    assert '.hidden' not in names
    assert 'Movies' in names and 'notes.txt' in names


def test_list_dir_can_show_hidden(tmp_tree):
    names = [e['name'] for e in fs.list_dir(str(tmp_tree), show_hidden=True)['entries']]
    assert '.hidden' in names


def test_list_dir_sorts_folders_first(tmp_tree):
    entries = fs.list_dir(str(tmp_tree))['entries']
    assert entries[0]['is_dir'] is True


def test_list_dir_refuses_a_file(tmp_tree):
    with pytest.raises(FsError):
        fs.list_dir(str(tmp_tree / 'notes.txt'))


def test_list_dir_reports_the_parent(tmp_tree):
    assert fs.list_dir(str(tmp_tree / 'Movies'))['parent'] == str(tmp_tree)


def test_trash_is_only_advertised_once_it_exists(tmp_tree, monkeypatch):
    """So the sidebar never links to a trash folder that was never created."""
    monkeypatch.setattr(fs, '_mountpoint_for', lambda p: str(tmp_tree))
    assert fs.list_dir(str(tmp_tree))['trash'] is None
    (tmp_tree / '.downlee-trash').mkdir()
    assert fs.list_dir(str(tmp_tree))['trash'] == str(tmp_tree / '.downlee-trash')


# --- mutations ------------------------------------------------------------

def test_make_dir_and_reject_a_duplicate(tmp_tree):
    entry = fs.make_dir(str(tmp_tree), 'New')
    assert entry['is_dir'] and (tmp_tree / 'New').is_dir()
    with pytest.raises(FsError):
        fs.make_dir(str(tmp_tree), 'New')


def test_make_dir_rejects_traversal(tmp_tree):
    with pytest.raises(FsError):
        fs.make_dir(str(tmp_tree), '../escaped')


def test_rename_refuses_an_existing_target(tmp_tree):
    with pytest.raises(FsError) as e:
        fs.rename(str(tmp_tree / 'notes.txt'), 'Movies')
    assert e.value.status == 409


def test_rename_moves_the_file(tmp_tree):
    entry = fs.rename(str(tmp_tree / 'notes.txt'), 'renamed.txt')
    assert entry['name'] == 'renamed.txt'
    assert (tmp_tree / 'renamed.txt').exists()
    assert not (tmp_tree / 'notes.txt').exists()


def test_delete_moves_to_trash_by_default(tmp_tree, monkeypatch):
    monkeypatch.setattr(fs, '_mountpoint_for', lambda p: str(tmp_tree))
    results = fs.delete([str(tmp_tree / 'notes.txt')])
    assert results[0]['trashed'] is True
    assert not (tmp_tree / 'notes.txt').exists()
    assert (tmp_tree / '.downlee-trash').is_dir()
    assert list((tmp_tree / '.downlee-trash').iterdir())


def test_permanent_delete_unlinks(tmp_tree):
    results = fs.delete([str(tmp_tree / 'notes.txt')], permanent=True)
    assert results[0]['trashed'] is False
    assert not (tmp_tree / 'notes.txt').exists()


def test_delete_reports_per_path_errors_without_aborting(tmp_tree):
    """One refusal must not abandon the rest of the selection."""
    results = fs.delete(['/etc/hostname', str(tmp_tree / 'notes.txt')], permanent=True)
    assert results[0].get('error')
    assert not results[1].get('error')
    assert not (tmp_tree / 'notes.txt').exists()


def test_transfer_copies_without_clobbering(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    (dest / 'a.mkv').write_bytes(b'existing')
    fs.transfer([str(tmp_tree / 'Movies' / 'a.mkv')], str(dest))
    assert (dest / 'a.mkv').read_bytes() == b'existing'   # untouched
    assert (dest / 'a (2).mkv').exists()                   # copy landed beside it


def test_transfer_move_removes_the_source(tmp_tree):
    dest = tmp_tree / 'dest'
    dest.mkdir()
    fs.transfer([str(tmp_tree / 'Movies' / 'a.mkv')], str(dest), move=True)
    assert (dest / 'a.mkv').exists()
    assert not (tmp_tree / 'Movies' / 'a.mkv').exists()


# --- search / size / preview ---------------------------------------------

def test_search_needs_two_characters(tmp_tree):
    with pytest.raises(FsError):
        fs.search(str(tmp_tree), 'a')


def test_search_finds_nested_entries(tmp_tree):
    got = fs.search(str(tmp_tree), 'mkv')
    assert any(e['name'] == 'a.mkv' for e in got['entries'])
    assert got['truncated'] is False


def test_search_respects_the_result_cap(tmp_tree):
    for i in range(10):
        (tmp_tree / f'match{i}.bin').touch()
    got = fs.search(str(tmp_tree), 'match', limit=3)
    assert len(got['entries']) == 3
    assert got['truncated'] is True


def test_dir_size_totals_the_tree(tmp_tree):
    got = fs.dir_size(str(tmp_tree / 'Movies'))
    assert got['size'] == 30          # 10 + 20 bytes
    assert got['files'] == 2
    assert got['partial'] is False


def test_read_text_truncates_and_reports_it(tmp_tree):
    got = fs.read_text(str(tmp_tree / 'notes.txt'), max_bytes=5)
    assert got['text'] == 'hello'
    assert got['truncated'] is True


def test_read_text_refuses_a_directory(tmp_tree):
    with pytest.raises(FsError):
        fs.read_text(str(tmp_tree / 'Movies'))

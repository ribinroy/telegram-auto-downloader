"""Small shared helpers - encryption at rest, formatting, and the path search
that decides whether a download's file still exists."""
import pytest

from backend import utils
from backend.web_app import helpers


# --- secrets at rest ------------------------------------------------------

def test_encrypt_decrypt_round_trip():
    for secret in ('hunter2', '', 'ünïcodé ✓', 'x' * 500):
        assert utils.decrypt_secret(utils.encrypt_secret(secret)) == secret


def test_encryption_is_not_reversible_by_eye():
    token = utils.encrypt_secret('hunter2')
    assert 'hunter2' not in token


def test_decrypting_junk_returns_empty_rather_than_raising():
    """A corrupt stored secret must not take a settings page down with it."""
    for junk in ('', 'not-a-token', 'gAAAAA-bogus'):
        assert utils.decrypt_secret(junk) == ''


# --- formatting -----------------------------------------------------------

@pytest.mark.parametrize('n,expected', [
    (0, '0.0B'), (512, '512.0B'), (1024, '1.0KB'),
    (1024 ** 2, '1.0MB'), (1024 ** 3, '1.0GB'), (1024 ** 4, '1.0TB'),
])
def test_human_readable_size(n, expected):
    assert utils.human_readable_size(n) == expected


@pytest.mark.parametrize('secs,expected', [
    (0, '-'), (None, '-'), (45, '45s'), (90, '1m 30s'), (3725, '1h 2m 5s'),
])
def test_format_time(secs, expected):
    assert utils.format_time(secs) == expected


@pytest.mark.parametrize('mime,folder', [
    ('image/png', 'Images'), ('video/mp4', 'Videos'),
    ('application/pdf', 'Documents'), (None, 'Documents'), ('', 'Documents'),
])
def test_media_folder_from_mime(mime, folder):
    assert utils.get_media_folder(mime) == folder


# --- candidate_file_paths -------------------------------------------------

@pytest.fixture
def no_spec(monkeypatch):
    monkeypatch.setattr('backend.utils.resolve_spec', lambda *a, **k: {})


def test_candidates_include_the_defaults(no_spec):
    from backend.config import DOWNLOAD_DIR
    paths = helpers.candidate_file_paths({'downloaded_from': 'telegram'}, 'a.mkv')
    assert DOWNLOAD_DIR / 'a.mkv' in paths
    assert DOWNLOAD_DIR / 'Videos' / 'a.mkv' in paths


def test_vps_downloads_look_in_the_vps_folder_first(no_spec):
    from backend.config import DOWNLOAD_DIR
    paths = helpers.candidate_file_paths({'downloaded_from': 'vps'}, 'a.mkv')
    assert paths[0] == DOWNLOAD_DIR / 'VPS' / 'a.mkv'


def test_the_source_spec_folder_wins(monkeypatch):
    monkeypatch.setattr('backend.utils.resolve_spec',
                        lambda *a, **k: {'folder': '/mnt/media'})
    from pathlib import Path
    paths = helpers.candidate_file_paths({'downloaded_from': 'youtube.com'}, 'a.mkv')
    assert paths[0] == Path('/mnt/media/a.mkv')


def test_an_explicit_destination_outranks_everything(monkeypatch):
    """A VPS transfer started into a torrent client's local_dir cannot be
    derived from the spec later - it is on the record."""
    monkeypatch.setattr('backend.utils.resolve_spec',
                        lambda *a, **k: {'folder': '/mnt/media'})
    from pathlib import Path
    paths = helpers.candidate_file_paths(
        {'downloaded_from': 'vps', 'dest_base': '/mnt/torrents'}, 'a.mkv')
    assert paths[0] == Path('/mnt/torrents/a.mkv')


def test_candidates_are_all_absolute(no_spec):
    paths = helpers.candidate_file_paths({'downloaded_from': 'telegram'}, 'a.mkv')
    assert paths and all(p.is_absolute() for p in paths)

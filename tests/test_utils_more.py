"""Spec resolution against the real tables, the legacy-key migration of
stored secrets, the state-file helpers, and the web helpers' remaining
branches (renamed variants, range responses)."""
import json
from pathlib import Path

import pytest

from backend import utils
from backend.web_app import helpers


# --- resolve_spec ---------------------------------------------------------------

def test_resolve_spec_without_a_mapping_is_all_defaults(db):
    assert utils.resolve_spec('telegram') == {'folder': None, 'quality': None, 'is_secured': False}


def test_resolve_spec_reads_the_sources_mapping(db):
    db.add_download_type_map('youtube.com', is_secured=True, folder='/mnt/yt', quality='720p')
    assert utils.resolve_spec('youtube.com') == {'folder': '/mnt/yt', 'quality': '720p', 'is_secured': True}


def test_a_watched_folder_overrides_the_vps_folder_and_can_hide(db):
    db.add_download_type_map('vps', folder='/mnt/vps')
    outer = db.add_vps_watch_folder('/home/u/dl', host='h', username='u')
    inner = db.add_vps_watch_folder('/home/u/dl/private/', host='h', username='u')
    db.update_vps_watch_folder(outer['id'], folder='/mnt/outer')
    db.update_vps_watch_folder(inner['id'], is_secured=True)

    # Longest prefix wins; a watched folder with no folder of its own keeps
    # the source mapping's
    spec = utils.resolve_spec('vps', path='/home/u/dl/private/a.mkv')
    assert spec == {'folder': '/mnt/vps', 'quality': None, 'is_secured': True}
    spec = utils.resolve_spec('vps', path='/home/u/dl/public/a.mkv')
    assert spec == {'folder': '/mnt/outer', 'quality': None, 'is_secured': False}
    # The folder itself matches, with or without the trailing slash it was saved with
    assert utils.resolve_spec('vps', path='/home/u/dl/private')['is_secured'] is True
    assert utils.resolve_spec('vps', path='/home/u/dl/private/')['is_secured'] is True
    # A sibling that merely shares the prefix string is not inside it
    assert utils.resolve_spec('vps', path='/home/u/dl-other/a.mkv')['folder'] == '/mnt/vps'
    assert db.get_vps_watch_folder_for_path('') is None


def test_a_removed_watched_folder_no_longer_matches(db):
    wf = db.add_vps_watch_folder('/home/u/dl', host='h', username='u')
    db.update_vps_watch_folder(wf['id'], folder='/mnt/x')
    db.delete_vps_watch_folder(wf['id'])
    assert utils.resolve_spec('vps', path='/home/u/dl/a.mkv')['folder'] is None


def test_spec_folder_creates_the_folder_or_falls_back(tmp_path):
    wanted = tmp_path / 'new' / 'deep'
    assert utils.spec_folder({'folder': str(wanted)}, tmp_path) == wanted
    assert wanted.is_dir()
    assert utils.spec_folder({}, tmp_path) == tmp_path
    assert utils.spec_folder(None, tmp_path) == tmp_path
    blocker = tmp_path / 'file'
    blocker.write_text('x')
    assert utils.spec_folder({'folder': str(blocker / 'under-a-file')}, tmp_path) == tmp_path


# --- secrets: the legacy key -----------------------------------------------------

def test_a_secret_under_the_legacy_key_is_read_and_re_encrypted(db):
    legacy = utils._fernet_for(utils._LEGACY_FALLBACK_SECRET).encrypt(b'old-pass').decode()
    db.set_setting('vps_config', json.dumps({'host': 'h', 'password_enc': legacy}))
    assert utils.decrypt_secret(legacy) == 'old-pass'
    stored = json.loads(db.get_setting('vps_config'))['password_enc']
    assert stored != legacy
    assert utils._fernet().decrypt(stored.encode()) == b'old-pass'   # now under the current key


def test_legacy_migration_is_best_effort(monkeypatch):
    """No database wired up: the caller still gets the plaintext."""
    monkeypatch.setattr('backend.database.db_manager', None)
    legacy = utils._fernet_for(utils._LEGACY_FALLBACK_SECRET).encrypt(b'old-pass').decode()
    assert utils.decrypt_secret(legacy) == 'old-pass'


def test_encrypting_none_is_an_empty_secret():
    assert utils.decrypt_secret(utils.encrypt_secret(None)) == ''


# --- state file ------------------------------------------------------------------

def test_save_and_load_state_round_trip(tmp_path):
    path = tmp_path / 'downloads.json'
    utils.save_state([{'file': 'a', 'when': Path('/x')}], path)
    assert utils.load_state(path) == [{'file': 'a', 'when': '/x'}]
    path.write_text(json.dumps({'downloads': [{'file': 'b'}]}))
    assert utils.load_state(path) == [{'file': 'b'}]
    assert utils.load_state(tmp_path / 'missing.json') == []


def test_human_readable_size_goes_up_to_petabytes():
    assert utils.human_readable_size(1024 ** 5) == '1.0PB'


# --- helpers ---------------------------------------------------------------------

@pytest.fixture
def dots_to_spaces(db):
    from backend.rename import invalidate_rules_cache
    db.add_rename_rule(r'(?<=\w)[._](?=\w)', ' ', name='dots to spaces')
    invalidate_rules_cache()
    yield
    invalidate_rules_cache()


def test_existing_variant_prefers_the_path_itself(tmp_path, dots_to_spaces):
    plain = tmp_path / 'ep.01.mkv'
    plain.write_bytes(b'x')
    assert helpers.existing_variant(plain) == plain


def test_existing_variant_falls_back_to_the_renamed_name(tmp_path, dots_to_spaces):
    renamed = tmp_path / 'ep 01.mkv'
    renamed.write_bytes(b'x')
    assert helpers.existing_variant(tmp_path / 'ep.01.mkv') == renamed
    # Neither there: the original path, so the caller can create it
    assert helpers.existing_variant(tmp_path / 'other.01.mkv') == tmp_path / 'other.01.mkv'


def test_existing_variant_survives_a_broken_rule_engine(tmp_path, monkeypatch):
    def boom(name, source):
        raise RuntimeError('rules exploded')
    monkeypatch.setattr('backend.rename.rename_for_download', boom)
    assert helpers.existing_variant(tmp_path / 'x.mkv') == tmp_path / 'x.mkv'


def test_local_copy_exists_needs_a_file_name(db):
    assert helpers.local_copy_exists({'downloaded_from': 'telegram', 'file': None}) is False


@pytest.fixture
def served(app, tmp_path):
    f = tmp_path / 'clip.bin'
    f.write_bytes(b'0123456789')

    def get(headers=None, **kw):
        with app.app.test_request_context('/x', headers=headers or {}):
            return helpers.range_response(f, **kw)
    return get


def test_range_response_serves_the_whole_file_without_a_range(served):
    res = served()
    assert res.status_code == 200
    assert res.headers['Content-Length'] == '10'
    assert res.headers['Accept-Ranges'] == 'bytes'
    assert res.mimetype == 'application/octet-stream'
    assert b''.join(res.response) == b'0123456789'


def test_range_response_answers_a_byte_range(served):
    res = served({'Range': 'bytes=2-5'})
    assert res.status_code == 206
    assert res.headers['Content-Range'] == 'bytes 2-5/10'
    assert res.headers['Content-Length'] == '4'
    assert b''.join(res.response) == b'2345'


def test_range_response_open_ended_and_past_the_end(served):
    res = served({'Range': 'bytes=7-'})
    assert res.headers['Content-Range'] == 'bytes 7-9/10'
    assert b''.join(res.response) == b'789'
    res = served({'Range': 'bytes=50-60'})
    assert res.status_code == 206                 # clamped rather than an exception
    assert res.headers['Content-Range'] == 'bytes 9-9/10'


def test_range_response_names_the_download(served):
    res = served(download_name='ünï clip.bin', mime_type='video/mp4')
    assert res.mimetype == 'video/mp4'
    assert res.headers['Content-Disposition'] == "attachment; filename*=UTF-8''%C3%BCn%C3%AF%20clip.bin"

"""backend.config reads the environment once at import. The pieces with
logic - the secret resolution, the booleans, the validation and the
list-valued settings - are exercised here without disturbing the already
imported module (conftest pointed it at a temp directory on purpose)."""
import os
import runpy
from pathlib import Path

import pytest

from backend import config


@pytest.mark.parametrize('raw,expected', [
    ('1', True), ('true', True), ('YES', True), (' on ', True),
    ('0', False), ('false', False), ('no', False), ('off', False), ('maybe', False),
])
def test_env_bool_parses_the_usual_spellings(monkeypatch, raw, expected):
    monkeypatch.setenv('DL_TEST_FLAG', raw)
    assert config._env_bool('DL_TEST_FLAG') is expected


def test_env_bool_default_applies_when_unset_or_blank(monkeypatch):
    monkeypatch.delenv('DL_TEST_FLAG', raising=False)
    assert config._env_bool('DL_TEST_FLAG') is False
    assert config._env_bool('DL_TEST_FLAG', True) is True
    monkeypatch.setenv('DL_TEST_FLAG', '   ')
    assert config._env_bool('DL_TEST_FLAG', True) is True


# --- validate_config ---------------------------------------------------------

def test_validate_config_lists_what_is_missing(monkeypatch, capsys):
    monkeypatch.setattr(config, 'API_ID', 0)
    monkeypatch.setattr(config, 'API_HASH', 'your_api_hash_here')
    assert config.validate_config() is False
    out = capsys.readouterr().out
    assert 'API_ID' in out and 'API_HASH' in out and '.env' in out


def test_validate_config_passes_with_credentials(monkeypatch):
    monkeypatch.setattr(config, 'API_ID', 12345)
    monkeypatch.setattr(config, 'API_HASH', 'abc')
    assert config.validate_config() is True


# --- the app secret -----------------------------------------------------------

def test_the_environment_secret_wins(monkeypatch, tmp_path):
    monkeypatch.setattr(config, 'JWT_SECRET_FILE', tmp_path / '.jwt_secret')
    monkeypatch.setenv('JWT_SECRET', '  from-env  ')
    assert config._resolve_jwt_secret() == 'from-env'
    assert not (tmp_path / '.jwt_secret').exists()


def test_a_persisted_secret_is_reused(monkeypatch, tmp_path):
    secret_file = tmp_path / '.jwt_secret'
    secret_file.write_text('persisted\n')
    monkeypatch.setattr(config, 'JWT_SECRET_FILE', secret_file)
    monkeypatch.delenv('JWT_SECRET', raising=False)
    assert config._resolve_jwt_secret() == 'persisted'


def test_a_fresh_secret_is_generated_and_kept_owner_only(monkeypatch, tmp_path):
    secret_file = tmp_path / 'deeper' / '.jwt_secret'
    monkeypatch.setattr(config, 'JWT_SECRET_FILE', secret_file)
    monkeypatch.delenv('JWT_SECRET', raising=False)
    first = config._resolve_jwt_secret()
    assert len(first) >= 48
    assert secret_file.read_text().strip() == first
    assert oct(os.stat(secret_file).st_mode & 0o777) == '0o600'
    # Stable across restarts
    assert config._resolve_jwt_secret() == first


def test_an_empty_secret_file_is_replaced(monkeypatch, tmp_path):
    secret_file = tmp_path / '.jwt_secret'
    secret_file.write_text('\n')
    monkeypatch.setattr(config, 'JWT_SECRET_FILE', secret_file)
    monkeypatch.delenv('JWT_SECRET', raising=False)
    assert config._resolve_jwt_secret()
    assert secret_file.read_text().strip()


# --- list-valued settings, evaluated at import --------------------------------

def load_config(monkeypatch, **env):
    """Run the config module's source again, as a throwaway namespace, under
    the given environment. The already-imported module is left as it is."""
    for key, value in env.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    return runpy.run_path(str(Path(config.__file__)), run_name='downlee_config_probe')


def test_cors_defaults_to_the_vite_dev_ports(monkeypatch):
    ns = load_config(monkeypatch, CORS_ORIGINS=None)
    assert 'http://localhost:5173' in ns['CORS_ORIGINS']


def test_cors_env_is_a_comma_list_or_a_wildcard(monkeypatch):
    ns = load_config(monkeypatch, CORS_ORIGINS=' https://a.example , https://b.example ,')
    assert ns['CORS_ORIGINS'] == ['https://a.example', 'https://b.example']
    ns = load_config(monkeypatch, CORS_ORIGINS='*')
    assert ns['CORS_ORIGINS'] == '*'


def test_probe_hosts_default_the_port_to_53(monkeypatch):
    ns = load_config(monkeypatch, NET_PROBE_HOSTS='10.0.0.1:853,10.0.0.2')
    assert ns['NET_PROBE_HOSTS'] == [('10.0.0.1', 853), ('10.0.0.2', 53)]
    ns = load_config(monkeypatch, NET_PROBE_HOSTS=None)
    assert ns['NET_PROBE_HOSTS'] == [('1.1.1.1', 53), ('8.8.8.8', 53)]


def test_thumb_workers_is_bounded(monkeypatch):
    assert load_config(monkeypatch, THUMB_WORKERS='3')['THUMB_WORKERS'] == 3
    auto = load_config(monkeypatch, THUMB_WORKERS=None)['THUMB_WORKERS']
    assert 1 <= auto <= 4


def test_paths_strip_quotes_from_the_env_file(monkeypatch, tmp_path):
    """An empty string (not an unset variable) stands in for "not configured"
    here: python-dotenv fills in unset variables from the real .env, and the
    deployment's SCREENSHOTS_DIR is not a directory a test should create."""
    quoted = tmp_path / 'quoted'
    ns = load_config(monkeypatch, DOWNLOAD_DIR=f'"{quoted}"', SCREENSHOTS_DIR='',
                     BASE_DIR=f"'{tmp_path}'")
    assert ns['DOWNLOAD_DIR'] == quoted and quoted.is_dir()
    assert ns['SCREENSHOTS_DIR'] == quoted / '.thumbs'
    assert ns['LOGS_DIR'] == tmp_path / 'logs'
    shots = tmp_path / 'shots'
    ns = load_config(monkeypatch, SCREENSHOTS_DIR=f"'{shots}'")
    assert ns['SCREENSHOTS_DIR'] == shots and shots.is_dir()

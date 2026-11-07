"""Wiring the redacting handler into the root logger, and the edges of the
filter and chmod helper that test_logsafe.py leaves alone."""
import logging
import os

import pytest

from backend import logsafe


@pytest.fixture
def root_logger_restored():
    root = logging.getLogger()
    saved = (list(root.handlers), list(root.filters), root.level)
    yield root
    for h in list(root.handlers):
        root.removeHandler(h)
        try:
            h.close()
        except Exception:  # noqa: BLE001
            pass
    for f in list(root.filters):
        root.removeFilter(f)
    for h in saved[0]:
        root.addHandler(h)
    for f in saved[1]:
        root.addFilter(f)
    root.setLevel(saved[2])


def test_install_replaces_root_handlers_with_a_private_redacting_one(tmp_path, root_logger_restored):
    root = root_logger_restored
    stray = logging.StreamHandler()
    root.addHandler(stray)
    log_dir = tmp_path / 'logs'
    log_dir.mkdir()
    log_file = log_dir / 'app.log'

    handler = logsafe.install(log_file, level=logging.DEBUG)

    assert root.handlers == [handler]                       # the stray one is gone
    assert isinstance(handler, logsafe.PrivateRotatingFileHandler)
    assert root.level == logging.DEBUG
    assert oct(os.stat(log_file).st_mode & 0o777) == '0o600'
    assert oct(os.stat(log_dir).st_mode & 0o777) == '0o750'

    logging.getLogger('werkzeug').info('"GET /api/files/stream?path=/x&token=eyJleak.sig HTTP/1.1" 206 -')
    # A logger that doesn't propagate still goes through the handler's filter
    quiet = logging.getLogger('quiet.child')
    quiet.propagate = False
    quiet.addHandler(handler)
    try:
        quiet.warning('password=%s', 'hunter2')
    finally:
        quiet.removeHandler(handler)
        quiet.propagate = True
    handler.flush()
    text = log_file.read_text()
    assert 'eyJleak' not in text and 'hunter2' not in text
    assert text.count('[redacted]') == 2
    assert '[INFO]' in text and '[WARNING]' in text


def test_install_accepts_a_log_in_the_current_directory(tmp_path, root_logger_restored, monkeypatch):
    """dirname('') is '' - the chmod must fall back to '.' instead of failing."""
    monkeypatch.chdir(tmp_path)
    handler = logsafe.install('bare.log')
    handler.close()
    assert (tmp_path / 'bare.log').exists()


def test_the_filter_passes_a_record_it_cannot_format():
    record = logging.LogRecord('x', logging.INFO, '', 0, 'bad %d format', ('not-a-number',), None)
    assert logsafe.RedactSecretsFilter().filter(record) is True


def test_the_filter_leaves_a_clean_record_alone():
    record = logging.LogRecord('x', logging.INFO, '', 0, 'plain %s', ('text',), None)
    logsafe.RedactSecretsFilter().filter(record)
    assert record.args == ('text',)          # not collapsed when nothing changed


def test_chmod_is_best_effort(tmp_path):
    logsafe._chmod(str(tmp_path / 'does-not-exist'), 0o600)   # no raise

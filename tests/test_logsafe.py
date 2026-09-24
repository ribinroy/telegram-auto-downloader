"""Credentials must never reach the log file - see backend/logsafe.py."""
import logging
import os

from backend import logsafe


def test_redacts_media_token_in_a_request_line():
    line = ('192.168.0.63 - - [18/Sep/2026 10:10:27] "GET '
            '/api/files/stream?path=/x.mp4&token=eyJhbGciOiJIUzI1NiJ9.abc.def HTTP/1.1" 206 -')
    out = logsafe.redact(line)
    assert 'eyJhbGciOiJIUzI1NiJ9' not in out
    assert 'token=[redacted]' in out
    assert '/api/files/stream?path=/x.mp4' in out  # the useful part survives


def test_leaves_ordinary_query_strings_alone():
    line = 'GET /api/downloads?filter=all&sort_by=created_at HTTP/1.1'
    assert logsafe.redact(line) == line


def test_redacts_every_secret_param():
    for param in logsafe.SECRET_PARAMS:
        assert '[redacted]' in logsafe.redact(f'GET /x?{param}=supersecretvalue')


def test_filter_handles_werkzeug_style_args():
    """Werkzeug passes the request line as a positional arg, so a filter that
    only inspects record.msg would miss every token."""
    record = logging.LogRecord(
        'werkzeug', logging.INFO, '', 0, '%s - - [%s] "%s" %s -',
        ('1.2.3.4', 'now', 'GET /api/files/stream?path=/e&token=eyJleak.sig HTTP/1.1', '206'),
        None)
    assert logsafe.RedactSecretsFilter().filter(record) is True
    assert 'eyJleak' not in record.getMessage()
    assert 'token=[redacted]' in record.getMessage()


def test_scrub_file_redacts_in_place_and_keeps_the_inode(tmp_path):
    """The running service holds an open fd, so a scrub must not swap the file."""
    log = tmp_path / 'app.log'
    log.write_text(
        'GET /a?token=eyJone.sig\n'
        'GET /b?filter=all\n'
        'GET /c?token=eyJtwo.sig\n')
    inode_before = os.stat(log).st_ino

    assert logsafe.scrub_file(str(log)) == 2

    assert os.stat(log).st_ino == inode_before
    text = log.read_text()
    assert 'eyJone' not in text and 'eyJtwo' not in text
    assert text.count('token=[redacted]') == 2
    assert 'GET /b?filter=all' in text          # untouched lines are preserved
    assert oct(os.stat(log).st_mode & 0o777) == '0o600'


def test_scrub_file_is_a_noop_on_a_missing_file(tmp_path):
    assert logsafe.scrub_file(str(tmp_path / 'nope.log')) == 0


def test_rotation_keeps_every_file_owner_only(tmp_path):
    """A rollover creates a brand new file; without the subclass it lands at
    the process umask (644) and the log is world-readable again."""
    path = tmp_path / 'roll.log'
    handler = logsafe.PrivateRotatingFileHandler(str(path), maxBytes=200, backupCount=2)
    handler.addFilter(logsafe.RedactSecretsFilter())
    log = logging.getLogger('rolltest')
    log.handlers = [handler]
    log.propagate = False
    log.setLevel(logging.INFO)

    for i in range(40):
        log.info('GET /api/files/stream?token=eyJsecret%s.sig HTTP/1.1', i)
    handler.close()

    written = sorted(tmp_path.glob('roll.log*'))
    assert len(written) > 1, 'expected at least one rollover'
    for f in written:
        assert oct(os.stat(f).st_mode & 0o777) == '0o600', f
        assert 'eyJsecret' not in f.read_text()

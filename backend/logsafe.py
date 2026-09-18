"""Keep credentials out of the log file.

`media_token_required` exists so that no token ends up "in a URL, browser
history or an access log" - but Werkzeug's request log writes the full request
line, query string included, which defeats exactly that last part. A media
token is good for MEDIA_TOKEN_HOURS of arbitrary file read as the service user,
so a world-readable log full of them is a credential store in all but name.

This module is the counterpart to that comment: a logging filter that redacts
secret-bearing query parameters wherever they appear, and a handler that keeps
the file private and bounded.
"""
import logging
import os
import re
from logging.handlers import RotatingFileHandler

# Query parameters whose value is a credential. `token` is the media token;
# the others are here so a future route can't quietly reintroduce the problem.
SECRET_PARAMS = ('token', 'access_token', 'refresh_token', 'api_key', 'apikey',
                 'password', 'secret', 'sig', 'signature')

_SECRET_RE = re.compile(
    r'(?i)\b(' + '|'.join(SECRET_PARAMS) + r')=([^&\s"\'<>]+)')

REDACTED = r'\1=[redacted]'

# The log is only ever read by a human or a tail; 10 MB x 5 keeps a useful
# window without the 70 MB unrotated file this replaced.
MAX_BYTES = 10 * 1024 * 1024
BACKUP_COUNT = 5
# Owner-only. A media token in here is worth as much as the session that made it.
LOG_MODE = 0o600
DIR_MODE = 0o750


def redact(text: str) -> str:
    """Replace the value of every secret-bearing query parameter."""
    return _SECRET_RE.sub(REDACTED, text)


class RedactSecretsFilter(logging.Filter):
    """Strip credentials from a record before it reaches any handler.

    It works on the *formatted* message rather than on `args`, because the
    caller that matters here is Werkzeug, which passes the request line as a
    positional argument - inspecting `msg` alone would miss it entirely.
    """

    def filter(self, record):
        try:
            message = record.getMessage()
        except Exception:
            return True
        cleaned = redact(message)
        if cleaned != message:
            record.msg = cleaned
            record.args = ()
        return True


def _chmod(path, mode):
    """Best effort: a permissions failure must never stop the service booting."""
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def install(log_file, level=logging.INFO,
            fmt="%(asctime)s [%(levelname)s] %(message)s"):
    """Configure root logging: rotating, owner-only, secrets redacted."""
    log_file = str(log_file)
    handler = RotatingFileHandler(
        log_file, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding='utf-8')
    handler.setFormatter(logging.Formatter(fmt))
    # On the handler as well as the root logger: a handler added later (or a
    # logger with propagate=False) would otherwise bypass the filter.
    handler.addFilter(RedactSecretsFilter())

    root = logging.getLogger()
    root.setLevel(level)
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.addFilter(RedactSecretsFilter())

    _chmod(os.path.dirname(log_file) or '.', DIR_MODE)
    _chmod(log_file, LOG_MODE)
    return handler


def scrub_file(path) -> int:
    """Redact secrets already written to a log file, in place.

    Rewrites the same inode (never a rename) because the running process holds
    an open descriptor to it: replacing the file would leave the service writing
    to an orphan. Redaction only ever shortens a line, so the content fits, and
    the handler opens in append mode, so later writes still land at the new end.

    Returns the number of lines changed.
    """
    path = str(path)
    if not os.path.exists(path):
        return 0
    changed = 0
    with open(path, 'r+', encoding='utf-8', errors='replace') as f:
        lines = f.readlines()
        out = []
        for line in lines:
            cleaned = redact(line)
            if cleaned != line:
                changed += 1
            out.append(cleaned)
        if changed:
            f.seek(0)
            f.writelines(out)
            f.truncate()
    _chmod(path, LOG_MODE)
    return changed

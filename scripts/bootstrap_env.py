#!/usr/bin/env python3
"""Write a working .env from .env.example, for `make env` / `make up`.

Never overwrites an existing .env - that file holds your secrets, and
regenerating JWT_SECRET would log everyone out and make every stored
password undecryptable. Fills in what a first run needs:

- JWT_SECRET: a fresh random secret
- DATABASE_URL: a local PostgreSQL user/database with a random password
  (`make db` creates exactly that user and database)
- DOWNLOAD_DIR: ./downloads, created

Each can be overridden from the environment, e.g.
    make up DOWNLOAD_DIR=/mnt/media DB_NAME=downlee
"""
import argparse
import os
import re
import secrets
import sys
from pathlib import Path


def set_var(text, key, value):
    """Set KEY=value in .env text: replace the line (commented or not) if the
    example has one, else append it."""
    pattern = re.compile(rf'^#?\s*{re.escape(key)}=.*$', re.M)
    line = f'{key}={value}'
    if pattern.search(text):
        return pattern.sub(lambda _m: line, text, count=1)
    return text.rstrip('\n') + f'\n{line}\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', default=Path(__file__).resolve().parent.parent, type=Path,
                        help='project root (where .env and .env.example live)')
    args = parser.parse_args()

    root = args.root
    env_path, example = root / '.env', root / '.env.example'
    if env_path.exists():
        print(f'.env already exists - leaving it as it is ({env_path})')
        return 0
    if not example.exists():
        print(f'missing {example}', file=sys.stderr)
        return 1

    download_dir = Path(os.environ.get('DOWNLOAD_DIR') or root / 'downloads').expanduser().resolve()
    db_name = os.environ.get('DB_NAME') or 'downlee'
    db_user = os.environ.get('DB_USER') or 'downlee'
    db_host = os.environ.get('DB_HOST') or 'localhost'
    db_port = os.environ.get('DB_PORT') or '5432'
    # URL-safe and quote-free, so it is safe both in the URL and in the SQL
    # `make db` runs to create the user
    db_pass = os.environ.get('DB_PASS') or secrets.token_hex(16)

    text = example.read_text()
    text = set_var(text, 'JWT_SECRET', secrets.token_urlsafe(48))
    text = set_var(text, 'DATABASE_URL', f'postgresql://{db_user}:{db_pass}@{db_host}:{db_port}/{db_name}')
    text = set_var(text, 'DOWNLOAD_DIR', str(download_dir))
    for key in ('WEB_PORT', 'WEB_HOST'):
        if os.environ.get(key):
            text = set_var(text, key, os.environ[key])

    download_dir.mkdir(parents=True, exist_ok=True)
    env_path.write_text(text)
    env_path.chmod(0o600)  # it holds the app secret and the database password
    print(f'wrote {env_path}')
    print(f'  DOWNLOAD_DIR={download_dir}')
    print(f'  DATABASE_URL=postgresql://{db_user}:***@{db_host}:{db_port}/{db_name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

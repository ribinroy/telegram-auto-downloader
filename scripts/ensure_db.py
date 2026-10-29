#!/usr/bin/env python3
"""Create the PostgreSQL user and database .env points at, if missing - for
`make db` / `make up`.

Idempotent: an existing user or database is left alone (an existing user's
password is not changed - if it differs from .env, fix one of the two by
hand rather than have this guess which is right). Only acts on a local
server; a remote DATABASE_URL is assumed to be managed elsewhere.

Runs psql as the `postgres` system user via sudo, so it may ask for your
password once. The tables themselves are created by the app on first start.
"""
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
LOCAL_HOSTS = {'localhost', '127.0.0.1', '::1', ''}


def read_database_url():
    for line in (ROOT / '.env').read_text().splitlines():
        line = line.strip()
        if line.startswith('DATABASE_URL='):
            return line.split('=', 1)[1].strip().strip('"\'')
    return None


def psql(sql, *, database='postgres'):
    """Run one statement as the postgres superuser; return its output."""
    result = subprocess.run(
        ['sudo', '-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
        capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f'psql failed: {result.stderr.strip() or result.stdout.strip()}')
    return result.stdout.strip()


def ident(name):
    return '"' + name.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def main():
    if not (ROOT / '.env').exists():
        sys.exit('no .env yet - run `make env` first')
    url = read_database_url()
    if not url:
        sys.exit('DATABASE_URL is not set in .env')
    parsed = urlparse(url)
    if not parsed.scheme.startswith('postgres'):
        print(f'DATABASE_URL is not PostgreSQL ({parsed.scheme}) - nothing to create')
        return 0
    if parsed.hostname not in LOCAL_HOSTS:
        print(f'database is on {parsed.hostname} - not creating it here')
        return 0

    user = unquote(parsed.username or '')
    password = unquote(parsed.password or '')
    db = parsed.path.lstrip('/')
    if not user or not db:
        sys.exit('DATABASE_URL needs a user and a database name')

    if psql(f'SELECT 1 FROM pg_roles WHERE rolname = {literal(user)}') == '1':
        print(f'database user {user} already exists')
    else:
        psql(f'CREATE ROLE {ident(user)} LOGIN PASSWORD {literal(password)}')
        print(f'created database user {user}')

    if psql(f'SELECT 1 FROM pg_database WHERE datname = {literal(db)}') == '1':
        print(f'database {db} already exists')
    else:
        psql(f'CREATE DATABASE {ident(db)} OWNER {ident(user)}')
        print(f'created database {db}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

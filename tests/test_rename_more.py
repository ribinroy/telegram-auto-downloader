"""The rename engine's slower paths: the regex timeout, the stored-rule
cache, and replaying the chain over files already on disk - collisions,
missing files, a rename the OS refuses, the dry run that must come first."""
import os
import re
import time

import pytest

from backend import rename
from backend.rename import InvalidPattern


# --- names / validation -------------------------------------------------------

def test_unique_name_gives_up_after_a_thousand_collisions(tmp_path):
    (tmp_path / 'a.mkv').touch()
    for n in range(2, 1000):
        (tmp_path / f'a ({n}).mkv').touch()
    assert rename.unique_name(tmp_path, 'a.mkv') == 'a.mkv'


def test_validate_rejects_an_over_long_pattern():
    with pytest.raises(InvalidPattern, match='too long'):
        rename.validate_rule('a' * (rename.MAX_PATTERN_LENGTH + 1))


def test_a_rule_that_leaves_nothing_usable_keeps_the_original():
    """'???' is a non-empty result that sanitizes to nothing: the name stands."""
    out, applied = rename.apply_rules('README', rules=[({'id': 1, 'pattern': '.*', 'replacement': '???'},
                                                        re.compile('.*'))])
    assert (out, applied) == ('README', [])


# --- the regex timeout ----------------------------------------------------------

class _Slow:
    """Stands in for a compiled pattern that backtracks forever."""

    def search(self, text):
        return True

    def sub(self, replacement, text):
        time.sleep(0.2)
        return 'late'


def test_a_pattern_that_takes_too_long_is_abandoned(monkeypatch):
    monkeypatch.setattr(rename, 'REGEX_TIMEOUT_SECONDS', 0.05)
    with pytest.raises(InvalidPattern, match='too long'):
        rename._sub_with_timeout(_Slow(), '', 'x')
    # The abandoned worker keeps spinning until its sleep ends; let it, so the
    # chain below has a free worker for its second rule
    time.sleep(0.25)
    # ...and in the chain it is skipped, the next rule still runs
    out, applied = rename.apply_rules('Movie.mkv', rules=[
        ({'id': 1, 'name': 'slow', 'pattern': 'x', 'replacement': ''}, _Slow()),
        ({'id': 2, 'name': 'fast', 'pattern': 'Movie', 'replacement': 'Film'}, re.compile('Movie')),
    ])
    assert out == 'Film.mkv' and applied == ['fast']


# --- stored rules -----------------------------------------------------------------

def test_stored_rules_are_cached_by_token_and_a_bad_one_is_skipped(db):
    rename.invalidate_rules_cache()
    try:
        db.add_rename_rule('(unclosed', 'x', name='broken')            # no validation at the DB layer
        good = db.add_rename_rule('Movie', 'Film', name='ok')
        loaded = rename._load_rules()
        assert [r['name'] for r, _c in loaded] == ['ok']
        assert rename._load_rules() is loaded                           # same token: cached
        db.update_rename_rule(good['id'], replacement='Picture')
        assert [r['replacement'] for r, _c in rename._load_rules()] == ['Picture']
        assert rename.rename_for_download('Movie.mkv', 'vps') == 'Picture.mkv'
    finally:
        rename.invalidate_rules_cache()


def test_rename_for_download_falls_back_when_the_engine_itself_fails(monkeypatch):
    def broken():
        raise RuntimeError('db gone')
    monkeypatch.setattr(rename, '_load_rules', broken)
    assert rename.rename_for_download('../Movie.mkv', 'telegram') == 'Movie.mkv'
    assert rename.rename_for_download('...', 'telegram') == 'download'   # nothing usable survives


# --- applying to existing files -----------------------------------------------------

@pytest.fixture
def library(db, tmp_path):
    """Finished downloads with files on disk, under the 'dots to spaces' rule."""
    rename.invalidate_rules_cache()
    db.add_rename_rule(r'(?<=\w)[._](?=\w)', ' ', name='dots to spaces')
    on_disk = tmp_path / 'lib'
    on_disk.mkdir()
    (on_disk / 'The.Movie.mkv').write_bytes(b'a')
    (on_disk / 'Clash.Movie.mkv').write_bytes(b'b')
    (on_disk / 'Clash Movie.mkv').write_bytes(b'taken')               # the collision
    rows = {
        'plain': db.add_download(file='The.Movie.mkv', status='done', downloaded_from='vps',
                                 message_id='r-1', url='/x/The.Movie.mkv', dest_base=str(on_disk)),
        'clash': db.add_download(file='Clash.Movie.mkv', status='done', downloaded_from='vps',
                                 message_id='r-2', url='/x/Clash.Movie.mkv', dest_base=str(on_disk)),
        'missing': db.add_download(file='Gone.Movie.mkv', status='done', downloaded_from='vps',
                                   message_id='r-3', url='/x/Gone.Movie.mkv', dest_base=str(on_disk)),
        'running': db.add_download(file='Live.Movie.mkv', status='downloading', downloaded_from='vps',
                                   message_id='r-4', url='/x/Live.Movie.mkv', dest_base=str(on_disk)),
        'clean': db.add_download(file='Clean.mkv', status='done', downloaded_from='vps',
                                 message_id='r-5', url='/x/Clean.mkv', dest_base=str(on_disk)),
    }
    db.add_download(file='Deleted.Movie.mkv', status='done', downloaded_from='vps',
                    message_id='r-6', url='/x/Deleted.Movie.mkv', dest_base=str(on_disk))
    db.update_download_by_message_id('r-6', file_deleted=True)
    yield on_disk, rows
    rename.invalidate_rules_cache()


def test_find_current_path_looks_where_the_file_can_be(library):
    on_disk, rows = library
    assert rename.find_current_path(rows['plain']) == on_disk / 'The.Movie.mkv'
    assert rename.find_current_path(rows['missing']) is None
    assert rename.find_current_path({'file': ''}) is None


def test_a_dry_run_plans_everything_and_touches_nothing(library):
    on_disk, rows = library
    plan = rename.apply_to_existing(dry_run=True)
    by_id = {e['id']: e for e in plan['items']}
    assert plan['total'] == 3 and plan['renamed'] == 0 and plan['skipped'] == 1
    assert by_id[rows['plain']['id']] == {'id': rows['plain']['id'], 'from': 'The.Movie.mkv',
                                          'to': 'The Movie.mkv', 'applied': ['dots to spaces'],
                                          'source': 'vps', 'status': 'would_rename'}
    clash = by_id[rows['clash']['id']]
    assert clash['to'] == 'Clash Movie (2).mkv' and 'collision' in clash['note']
    assert by_id[rows['missing']['id']]['status'] == 'missing'
    assert rows['running']['id'] not in by_id and rows['clean']['id'] not in by_id
    assert (on_disk / 'The.Movie.mkv').exists()                        # untouched


def test_applying_renames_on_disk_and_in_the_record(library, db, monkeypatch):
    on_disk, rows = library
    from backend.web_app import base
    events = []
    monkeypatch.setattr(base, 'socketio', type('S', (), {'emit': lambda self, e, d: events.append((e, d))})())
    result = rename.apply_to_existing(dry_run=False)
    assert result['renamed'] == 2 and result['skipped'] == 1 and result['failed'] == 0
    assert (on_disk / 'The Movie.mkv').exists() and not (on_disk / 'The.Movie.mkv').exists()
    assert (on_disk / 'Clash Movie (2).mkv').read_bytes() == b'b'
    assert (on_disk / 'Clash Movie.mkv').read_bytes() == b'taken'      # the other file kept
    assert db.get_download_by_message_id('r-1')['file'] == 'The Movie.mkv'
    assert db.get_download_by_message_id('r-2')['file'] == 'Clash Movie (2).mkv'
    assert sorted(events, key=lambda e: e[1]['id']) == [
        ('download:renamed', {'id': rows['plain']['id'], 'message_id': 'r-1', 'file': 'The Movie.mkv'}),
        ('download:renamed', {'id': rows['clash']['id'], 'message_id': 'r-2', 'file': 'Clash Movie (2).mkv'})]
    # A second run finds nothing left to rename - only the file still missing
    again = rename.apply_to_existing(dry_run=False)
    assert again['renamed'] == 0 and [e['status'] for e in again['items']] == ['missing']


def test_a_rename_the_os_refuses_is_recorded_not_raised(library, db, monkeypatch):
    on_disk, rows = library

    def refuse(src, dst):
        raise OSError(30, 'Read-only file system')
    monkeypatch.setattr(os, 'replace', refuse)
    result = rename.apply_to_existing(dry_run=False)
    assert result['failed'] == 2 and result['renamed'] == 0
    failed = [e for e in result['items'] if e['status'] == 'failed']
    assert all('Read-only' in e['note'] for e in failed)
    assert db.get_download_by_message_id('r-1')['file'] == 'The.Movie.mkv'


def test_the_limit_caps_the_renameable_items(library):
    """`limit` counts the items that can be renamed; a file missing on disk
    is listed on the way past without ending the walk. (No route passes a
    limit today, so this pins the contract rather than a UI behaviour.)"""
    plan = rename.apply_to_existing(dry_run=True, limit=1)
    assert [e['status'] for e in plan['items'] if e['status'] != 'missing'] == ['would_rename']
    assert plan['total'] <= 2


def test_emit_renamed_never_raises(monkeypatch):
    import backend.web_app as web

    def broken():
        raise RuntimeError('no socket')
    monkeypatch.setattr(web, 'get_socketio', broken)
    rename._emit_renamed(1, None, 'x.mkv')                              # swallowed

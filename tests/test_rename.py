"""The rename engine rewrites attacker-influenced names before a byte is
written, so its failure modes matter more than its happy path."""
import pytest

from backend import rename
from backend.rename import InvalidPattern, RenameError


def rules(*specs):
    """Compile (pattern, replacement, **opts) tuples the way _load_rules does."""
    import re
    out = []
    for i, spec in enumerate(specs):
        pattern, replacement = spec[0], spec[1]
        opts = spec[2] if len(spec) > 2 else {}
        out.append(({'id': i, 'name': f'r{i}', 'pattern': pattern,
                     'replacement': replacement, **opts}, re.compile(pattern)))
    return out


# --- sanitize_filename ----------------------------------------------------

@pytest.mark.parametrize('raw', ['../../etc/passwd', 'a/b', 'x\\y', 'na:me', 'q?uery'])
def test_sanitize_strips_path_and_illegal_characters(raw):
    out = rename.sanitize_filename(raw)
    for bad in ('/', '\\', ':', '?'):
        assert bad not in out
    assert '..' not in out


def test_sanitize_refuses_a_name_that_reduces_to_nothing():
    for raw in ('', '   ', '...', '/'):
        with pytest.raises(RenameError):
            rename.sanitize_filename(raw)


def test_sanitize_restores_a_stripped_extension():
    assert rename.sanitize_filename('Movie', fallback_ext='.mkv') == 'Movie.mkv'
    # Already has one: not doubled.
    assert rename.sanitize_filename('Movie.mkv', fallback_ext='.mkv') == 'Movie.mkv'


def test_sanitize_trims_the_stem_not_the_extension():
    long_name = 'a' * 500 + '.mkv'
    out = rename.sanitize_filename(long_name)
    assert out.endswith('.mkv')
    assert len(out.encode('utf-8')) <= rename.MAX_NAME_BYTES


# --- unique_name ----------------------------------------------------------

def test_unique_name_returns_the_name_when_free(tmp_path):
    assert rename.unique_name(tmp_path, 'a.mkv') == 'a.mkv'


def test_unique_name_suffixes_on_collision(tmp_path):
    (tmp_path / 'a.mkv').touch()
    assert rename.unique_name(tmp_path, 'a.mkv') == 'a (2).mkv'
    (tmp_path / 'a (2).mkv').touch()
    assert rename.unique_name(tmp_path, 'a.mkv') == 'a (3).mkv'


# --- validate_rule --------------------------------------------------------

def test_validate_rejects_empty_and_broken_patterns():
    with pytest.raises(InvalidPattern):
        rename.validate_rule('')
    with pytest.raises(InvalidPattern):
        rename.validate_rule('(unclosed')


def test_validate_rejects_a_backreference_with_no_group():
    with pytest.raises(InvalidPattern):
        rename.validate_rule('abc', r'\9')


def test_validate_rejects_javascript_style_group_syntax():
    """$1 compiles fine and silently writes a literal "$1" into the filename."""
    with pytest.raises(InvalidPattern) as e:
        rename.validate_rule(r'(\d+)', '$1')
    assert '\\1' in str(e.value)
    # No capture group -> nothing to confuse, so it is allowed.
    rename.validate_rule('abc', '$1')


# --- apply_rules ----------------------------------------------------------

def test_rules_match_the_stem_so_the_extension_survives():
    """The natural "dots to spaces" rule must not turn Movie.mkv into Movie mkv."""
    out, applied = rename.apply_rules(
        'The.Movie.2024.mkv', rules=rules((r'(?<=\w)[._](?=\w)', ' ')))
    assert out == 'The Movie 2024.mkv'
    assert applied


def test_unchanged_name_reports_no_rules_applied():
    out, applied = rename.apply_rules('clean.mkv', rules=rules(('nomatch', 'x')))
    assert (out, applied) == ('clean.mkv', [])


def test_source_scoped_rule_is_skipped_for_other_sources():
    r = rules(('a', 'b', {'source': 'youtube.com'}))
    assert rename.apply_rules('aaa.mkv', source='vps', rules=r)[0] == 'aaa.mkv'
    assert rename.apply_rules('aaa.mkv', source='youtube.com', rules=r)[0] != 'aaa.mkv'


def test_stop_on_match_halts_the_chain():
    r = rules(('a', 'b', {'stop_on_match': True}), ('b', 'c'))
    out, applied = rename.apply_rules('aaa.mkv', rules=r)
    assert out == 'bbb.mkv'          # the second rule never ran
    assert len(applied) == 1


def test_a_rule_that_empties_the_name_keeps_the_original():
    """Reattaching the extension would otherwise produce a file called mkv.mkv."""
    out, applied = rename.apply_rules('Movie.mkv', rules=rules((r'.*', '')))
    assert (out, applied) == ('Movie.mkv', [])


def test_rules_cannot_escape_the_directory():
    out, _ = rename.apply_rules('Movie.mkv', rules=rules((r'Movie', '../../etc/passwd')))
    assert '/' not in out and '..' not in out


def test_a_broken_rule_is_skipped_not_fatal():
    """A rule whose replacement blows up must not take the download with it."""
    r = rules((r'(Movie)', r'\9'), (r'Movie', 'Film'))
    out, applied = rename.apply_rules('Movie.mkv', rules=r)
    assert out == 'Film.mkv'
    assert applied == ['r1']


def test_collapses_the_whitespace_a_substitution_leaves_behind():
    out, _ = rename.apply_rules('A   B.mkv', rules=rules((r'A', 'A')))
    # The rule itself changes nothing, so nothing is applied and the name stands.
    assert out == 'A   B.mkv'
    out, _ = rename.apply_rules('A-B-C.mkv', rules=rules((r'-', ' ')))
    assert out == 'A B C.mkv'


def test_extensionless_names_are_handled():
    out, _ = rename.apply_rules('README', rules=rules((r'README', 'NOTES')))
    assert out == 'NOTES'


# --- preview / entry point ------------------------------------------------

def test_preview_reports_the_change_without_touching_anything():
    got = rename.preview_rules('a.b.mkv', rules=rules((r'\.', ' ')))
    assert got['original'] == 'a.b.mkv'
    assert got['changed'] is True
    assert got['new'].endswith('.mkv')


def test_rename_for_download_never_raises(monkeypatch):
    """It is fed Telegram attachment names, SFTP basenames and yt-dlp titles -
    all attacker-influenced, all joined onto a directory."""
    monkeypatch.setattr(rename, '_load_rules', lambda: rules((r'.*', '')))
    for name in ('../../etc/passwd', '', '   ', 'ok.mkv', 'x' * 400 + '.mkv'):
        out = rename.rename_for_download(name, 'telegram')
        assert '/' not in out and '..' not in out


def test_rename_for_download_sanitizes_even_with_no_rules(monkeypatch):
    monkeypatch.setattr(rename, '_load_rules', lambda: [])
    assert '/' not in rename.rename_for_download('../../etc/passwd', 'vps')

"""The downloads list and its annotations, plus the per-source specs that
drive them."""
import pytest


@pytest.fixture
def seeded(db):
    """A small library across three sources, one of them secured."""
    db.add_download(file='a.mkv', status='done', downloaded_from='telegram',
                    message_id='m-a', author='Alice', total_bytes=100, progress=100)
    db.add_download(file='b.mp4', status='failed', downloaded_from='youtube.com',
                    message_id='m-b', author='Bob', url='https://y/1')
    db.add_download(file='c.mkv', status='downloading', downloaded_from='vps',
                    message_id='m-c', url='/remote/c.mkv', progress=42)
    db.add_download_type_map('vps', is_secured=True, folder='/mnt/secret')
    return db


def items(res):
    body = res.get_json()
    return body['downloads'] if isinstance(body, dict) and 'downloads' in body else body


# --- listing --------------------------------------------------------------

def test_list_returns_the_library(client, seeded, auth):
    res = client.get('/api/downloads', headers=auth)
    assert res.status_code == 200
    assert {d['file'] for d in items(res)} >= {'a.mkv', 'b.mp4'}


def test_a_secured_source_is_hidden_by_default(client, seeded, auth):
    """`hidden` is computed at query time, so a spec change applies backwards."""
    names = {d['file'] for d in items(client.get('/api/downloads', headers=auth))}
    assert 'c.mkv' not in names
    names = {d['file'] for d in items(
        client.get('/api/downloads?include_hidden=true', headers=auth))}
    assert 'c.mkv' in names


def test_entries_are_annotated_with_hidden_and_destination(client, seeded, auth):
    res = client.get('/api/downloads?include_hidden=true', headers=auth)
    entry = next(d for d in items(res) if d['file'] == 'c.mkv')
    assert entry['hidden'] is True
    assert entry['dest_folder'] == '/mnt/secret'


def test_search_filters_by_name(client, seeded, auth):
    res = client.get('/api/downloads?search=b.mp4', headers=auth)
    assert [d['file'] for d in items(res)] == ['b.mp4']


def test_author_filter(client, seeded, auth):
    res = client.get('/api/downloads?author=Alice', headers=auth)
    assert all(d['author'] == 'Alice' for d in items(res))


def test_pagination_caps_the_page(client, seeded, auth):
    res = client.get('/api/downloads?limit=1&offset=0&include_hidden=true', headers=auth)
    assert len(items(res)) == 1


def test_authors_lists_the_distinct_set(client, seeded, auth):
    res = client.get('/api/authors', headers=auth)
    body = res.get_json()
    authors = body['authors'] if isinstance(body, dict) else body
    assert 'Alice' in authors and 'Bob' in authors


def test_stats_are_aggregates(client, seeded, auth):
    body = client.get('/api/stats', headers=auth).get_json()
    assert isinstance(body, dict)
    assert any(isinstance(v, (int, float)) for v in body.values())


def test_metrics_is_open_by_design(client, db):
    """Documented as unauthenticated; it exposes counters only."""
    res = client.get('/metrics')
    assert res.status_code == 200


# --- mutations ------------------------------------------------------------

def test_delete_is_a_soft_delete(client, seeded, auth):
    res = client.post('/api/delete', headers=auth, json={'message_id': 'm-a'})
    assert res.status_code == 200
    names = {d['file'] for d in items(
        client.get('/api/downloads?include_hidden=true', headers=auth))}
    assert 'a.mkv' not in names
    # ...but the row is still there: a soft delete only stamps deleted_at.
    rows = seeded.get_all_downloads(include_deleted=True)
    row = next(r for r in rows if r['message_id'] == 'm-a')
    assert row['deleted_at'] is not None


def test_delete_without_an_id_is_a_harmless_no_op(client, seeded, auth):
    """Documenting current behaviour: the route is lenient rather than 400,
    and deletes nothing. Worth tightening, but it destroys no data."""
    before = {d['file'] for d in items(
        client.get('/api/downloads?include_hidden=true', headers=auth))}
    client.post('/api/delete', headers=auth, json={})
    after = {d['file'] for d in items(
        client.get('/api/downloads?include_hidden=true', headers=auth))}
    assert before == after


def test_retry_404s_on_an_unknown_download(client, seeded, auth):
    res = client.post('/api/retry', headers=auth, json={'id': 999999})
    assert res.status_code in (400, 404)
    assert res.get_json().get('error')


def test_stop_without_an_id_changes_nothing(client, seeded, auth):
    """Same leniency as /api/delete - it is a no-op, not a 400."""
    client.post('/api/stop', headers=auth, json={})
    row = next(d for d in items(client.get('/api/downloads?include_hidden=true', headers=auth))
               if d['file'] == 'c.mkv')
    assert row['status'] == 'downloading'


def test_pause_is_telegram_only(client, seeded, auth):
    """A yt-dlp or SFTP transfer has no pause, and must say so."""
    res = client.post('/api/pause', headers=auth, json={'message_id': 'm-b'})
    assert res.status_code >= 400


# --- per-source specs -----------------------------------------------------

def test_mapping_crud(client, db, auth):
    created = client.post('/api/mappings', headers=auth,
                          json={'downloaded_from': 'vimeo.com', 'folder': '/mnt/v',
                                'quality': '1080p', 'is_secured': False})
    assert created.status_code in (200, 201), created.get_data(as_text=True)

    listed = client.get('/api/mappings', headers=auth).get_json()
    rows = listed['mappings'] if isinstance(listed, dict) else listed
    row = next(r for r in rows if r['downloaded_from'] == 'vimeo.com')
    assert row['folder'] == '/mnt/v' and row['quality'] == '1080p'

    updated = client.put(f"/api/mappings/{row['id']}", headers=auth,
                         json={'folder': '/mnt/other', 'is_secured': True})
    assert updated.status_code == 200

    assert client.delete(f"/api/mappings/{row['id']}", headers=auth).status_code == 200
    rows = client.get('/api/mappings', headers=auth).get_json()
    rows = rows['mappings'] if isinstance(rows, dict) else rows
    assert not any(r['downloaded_from'] == 'vimeo.com' for r in rows)


def test_a_spec_change_applies_to_existing_downloads(client, seeded, auth):
    """hidden is never stamped on a row, so unsecuring a source reveals its
    whole back catalogue at once."""
    rows = client.get('/api/mappings', headers=auth).get_json()
    rows = rows['mappings'] if isinstance(rows, dict) else rows
    vps = next(r for r in rows if r['downloaded_from'] == 'vps')
    client.put(f"/api/mappings/{vps['id']}", headers=auth, json={'is_secured': False})
    names = {d['file'] for d in items(client.get('/api/downloads', headers=auth))}
    assert 'c.mkv' in names

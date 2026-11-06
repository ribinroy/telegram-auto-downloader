"""The analytics aggregation: time series (by day, filled; by hour), the
per-source/author/status breakdowns, the window, and what deleted or
undated rows do to it. Rows are handed to the route directly so their
timestamps can be chosen."""
from datetime import datetime, timedelta

import pytest


def row(created, **over):
    base = {'id': 1, 'file': 'a.mkv', 'status': 'done', 'downloaded_from': 'telegram',
            'total_bytes': 100, 'author': 'Alice', 'created_at': created, 'deleted_at': None}
    base.update(over)
    return base


class Library(list):
    """The rows the route is fed; `seen` records each include_deleted asked."""
    seen = None


@pytest.fixture
def rows(db, monkeypatch):
    library = Library()
    library.seen = []

    def get_all_downloads(include_deleted=False):
        library.seen.append(include_deleted)
        return [r for r in library if include_deleted or not r.get('deleted_at')]

    monkeypatch.setattr(db, 'get_all_downloads', get_all_downloads)
    return library


def test_the_default_window_is_thirty_days_by_day_and_filled(client, auth, rows):
    now = datetime.utcnow()
    rows += [
        row(now - timedelta(days=1), total_bytes=10),
        row(now - timedelta(days=1), total_bytes=20, status='failed', author=None,
            downloaded_from='youtube.com'),
        row(now - timedelta(days=45), total_bytes=999),           # outside the window
    ]
    body = client.get('/api/analytics', headers=auth).get_json()
    assert body['period_days'] == 30 and body['group_by'] == 'day'
    assert rows.seen == [False]

    series = body['time_series']
    assert len(series) in (30, 31)                                 # cutoff.date() .. today
    yesterday = (now - timedelta(days=1)).strftime('%Y-%m-%d')
    assert {s['label']: (s['count'], s['size']) for s in series}[yesterday] == (2, 30)
    assert sum(s['count'] for s in series) == 2                    # the rest is zero-filled
    assert [s['label'] for s in series] == sorted(s['label'] for s in series)

    assert body['by_source'] == [{'source': 'telegram', 'count': 1, 'size': 10},
                                 {'source': 'youtube.com', 'count': 1, 'size': 20}]
    assert body['by_author'] == [{'author': 'Alice', 'count': 1, 'size': 10},
                                 {'author': 'unknown', 'count': 1, 'size': 20}]
    assert body['by_status'] == {'done': 1, 'failed': 1}
    hourly = body['hourly_distribution']
    assert len(hourly) == 24 and sum(h['count'] for h in hourly) == 2
    assert hourly[(now - timedelta(days=1)).hour]['count'] == 2
    assert body['summary'] == {'total_downloads': 2, 'total_size': 30, 'completed': 1,
                               'failed': 1, 'success_rate': 50.0}


def test_grouping_by_hour_is_not_filled(client, auth, rows):
    at = datetime(2026, 9, 18, 14, 7)
    rows += [row(at), row(at + timedelta(minutes=10)), row(at + timedelta(hours=3))]
    body = client.get('/api/analytics?days=0&group_by=hour', headers=auth).get_json()
    assert body['time_series'] == [{'label': '2026-09-18 14:00', 'count': 2, 'size': 200},
                                   {'label': '2026-09-18 17:00', 'count': 1, 'size': 100}]


def test_all_time_starts_the_series_at_the_oldest_download(client, auth, rows):
    rows += [row(datetime.utcnow() - timedelta(days=3))]
    body = client.get('/api/analytics?days=0', headers=auth).get_json()
    series = body['time_series']
    assert len(series) == 4 and series[0]['count'] == 1 and series[-1]['count'] == 0


def test_deleted_rows_only_count_when_asked(client, auth, rows):
    now = datetime.utcnow()
    rows += [row(now), row(now, deleted_at=now)]
    assert client.get('/api/analytics', headers=auth).get_json()['summary']['total_downloads'] == 1
    body = client.get('/api/analytics?include_deleted=true', headers=auth).get_json()
    assert body['summary']['total_downloads'] == 2
    assert rows.seen == [False, True]


def test_timestamps_in_any_shape_are_accepted_and_bad_ones_skipped(client, auth, rows):
    now = datetime.utcnow()
    rows += [
        row(now.isoformat() + 'Z'),                   # what to_dict() produces
        row(now.replace(tzinfo=None)),                # a datetime object
        row(None, total_bytes=None),                  # never stamped: left out
        row('not a date'),                            # unparseable: left out
    ]
    body = client.get('/api/analytics', headers=auth).get_json()
    assert body['summary']['total_downloads'] == 2


def test_an_empty_library_has_an_empty_report(client, auth, rows):
    body = client.get('/api/analytics', headers=auth).get_json()
    assert body['time_series'] == [] and body['by_source'] == [] and body['by_status'] == {}
    assert body['summary']['success_rate'] == 0
    assert [h['count'] for h in body['hourly_distribution']] == [0] * 24


def test_analytics_over_the_real_table(client, db, auth):
    db.add_download(file='a.mkv', status='done', message_id='an-1', total_bytes=5, author='Zed')
    body = client.get('/api/analytics?days=7', headers=auth).get_json()
    assert body['by_author'] == [{'author': 'Zed', 'count': 1, 'size': 5}]
    assert body['time_series'][-1]['count'] == 1

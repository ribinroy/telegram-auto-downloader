"""The per-download media routes: what the view button learns from
/api/video/check, range streaming, the thumbnail list and image routes, the
yt-dlp version probe, and the schedule routes' validation."""
import json
import os
import stat
import textwrap

import pytest

from backend.config import DOWNLOAD_DIR
from backend import file_meta


@pytest.fixture
def media(client, auth):
    return client.get('/api/auth/media-token', headers=auth).get_json()['media_token']


@pytest.fixture
def thumbs_dir(tmp_path, monkeypatch):
    d = tmp_path / 'thumbs'
    monkeypatch.setattr(file_meta, 'THUMBS_DIR', d)
    return d


# --- /api/video/check -------------------------------------------------------------

def test_check_404s_on_an_unknown_download(client, db, auth):
    res = client.get('/api/video/check/99999', headers=auth)
    assert res.status_code == 404 and res.get_json()['exists'] is False


def test_check_declines_an_unfinished_download(client, db, auth):
    row = db.add_download(file='a.mkv', status='downloading', message_id='v-1')
    body = client.get(f"/api/video/check/{row['id']}", headers=auth).get_json()
    assert body == {'exists': False, 'error': 'Download not complete'}


def test_check_declines_a_record_without_a_file_name(client, db, auth):
    row = db.add_download(file='', status='done', message_id='v-2')
    body = client.get(f"/api/video/check/{row['id']}", headers=auth).get_json()
    assert body == {'exists': False, 'error': 'No file name'}


def test_check_tells_a_video_from_a_folder_from_another_file(client, db, auth):
    (DOWNLOAD_DIR / 'Videos').mkdir(exist_ok=True)
    (DOWNLOAD_DIR / 'Videos' / 'clip.MKV').write_bytes(b'x' * 7)
    (DOWNLOAD_DIR / 'Show').mkdir()
    (DOWNLOAD_DIR / 'notes.txt').write_text('x')
    video = db.add_download(file='clip.MKV', status='done', message_id='v-3')
    folder = db.add_download(file='Show', status='done', downloaded_from='vps', message_id='v-4')
    other = db.add_download(file='notes.txt', status='done', message_id='v-5')

    body = client.get(f"/api/video/check/{video['id']}", headers=auth).get_json()
    assert body == {'exists': True, 'kind': 'video', 'path': str(DOWNLOAD_DIR / 'Videos' / 'clip.MKV'),
                    'parent': str(DOWNLOAD_DIR / 'Videos'), 'size': 7, 'name': 'clip.MKV'}
    body = client.get(f"/api/video/check/{folder['id']}", headers=auth).get_json()
    assert body == {'exists': True, 'kind': 'dir', 'path': str(DOWNLOAD_DIR / 'Show'), 'name': 'Show'}
    body = client.get(f"/api/video/check/{other['id']}", headers=auth).get_json()
    assert body['kind'] == 'file' and body['size'] == 1


def test_check_keeps_file_deleted_honest_both_ways(client, db, auth):
    (DOWNLOAD_DIR / 'back.mkv').write_bytes(b'x')
    back = db.add_download(file='back.mkv', status='done', message_id='v-6')
    gone = db.add_download(file='gone.mkv', status='done', message_id='v-7')
    db.update_download_by_id(back['id'], file_deleted=True)

    assert client.get(f"/api/video/check/{back['id']}", headers=auth).get_json()['exists'] is True
    assert db.get_download_by_id(back['id'])['file_deleted'] is False
    body = client.get(f"/api/video/check/{gone['id']}", headers=auth).get_json()
    assert body == {'exists': False, 'error': 'File not found'}
    assert db.get_download_by_id(gone['id'])['file_deleted'] is True


# --- /api/video/stream ---------------------------------------------------------------

def test_stream_404s_for_what_cannot_be_played(client, db, auth, media):
    unfinished = db.add_download(file='a.mkv', status='downloading', message_id='s-1')
    nameless = db.add_download(file='', status='done', message_id='s-2')
    missing = db.add_download(file='nowhere.mkv', status='done', message_id='s-3')
    for row in (unfinished, nameless, missing):
        assert client.get(f"/api/video/stream/{row['id']}?token={media}").status_code == 404
    assert client.get(f'/api/video/stream/99999?token={media}').status_code == 404


def test_stream_serves_whole_and_ranged(client, db, auth, media):
    (DOWNLOAD_DIR / 'clip.mp4').write_bytes(b'0123456789')
    row = db.add_download(file='clip.mp4', status='done', message_id='s-4')
    res = client.get(f"/api/video/stream/{row['id']}?token={media}")
    assert res.status_code == 200 and res.data == b'0123456789'
    assert res.mimetype == 'video/mp4' and res.headers['Accept-Ranges'] == 'bytes'

    res = client.get(f"/api/video/stream/{row['id']}?token={media}", headers={'Range': 'bytes=3-5'})
    assert res.status_code == 206 and res.data == b'345'
    assert res.headers['Content-Range'] == 'bytes 3-5/10' and res.headers['Content-Length'] == '3'

    # The API token works in a header too (fetch/curl), never in the URL
    res = client.get(f"/api/video/stream/{row['id']}", headers={**auth, 'Range': 'bytes=8-'})
    assert res.status_code == 206 and res.data == b'89'
    assert client.get(f"/api/video/stream/{row['id']}").status_code == 401


# --- thumbnails ----------------------------------------------------------------------

def test_thumbs_list_is_empty_without_a_folder(client, db, auth, thumbs_dir):
    assert client.get('/api/thumbs/5', headers=auth).get_json() == {'thumbs': []}


def test_thumbs_list_and_serve(client, db, auth, media, thumbs_dir):
    d = thumbs_dir / '5'
    d.mkdir(parents=True)
    for name in ('2.jpg', '1.jpg', '10.jpg', 'notes.txt'):
        (d / name).write_bytes(b'\xff\xd8' + name.encode())
    assert client.get('/api/thumbs/5', headers=auth).get_json() == {'thumbs': ['1.jpg', '10.jpg', '2.jpg']}

    res = client.get(f'/api/thumbs/5/2.jpg?token={media}')
    assert res.status_code == 200 and res.mimetype == 'image/jpeg' and res.data == b'\xff\xd82.jpg'
    assert client.get(f'/api/thumbs/5/9.jpg?token={media}').status_code == 404
    assert client.get('/api/thumbs/5/2.jpg').status_code == 401


@pytest.mark.parametrize('name', ['..%2F..%2Fetc%2Fpasswd', '..', 'a%5Cb.jpg', '%2E%2E%2Fx.jpg'])
def test_thumb_names_cannot_leave_the_folder(client, db, auth, media, thumbs_dir, name):
    res = client.get(f'/api/thumbs/5/{name}?token={media}')
    assert res.status_code in (400, 404)
    if res.status_code == 400:
        assert res.get_json()['error'] == 'Invalid filename'


# --- yt-dlp version ----------------------------------------------------------------------

def test_ytdlp_version_without_the_downloader_is_an_error_not_a_crash(client, db, auth):
    body = client.get('/api/jobs/ytdlp-version', headers=auth).get_json()
    assert body['version'] is None and body['error']


def test_ytdlp_version_runs_the_binary(app, client, db, auth, tmp_path):
    fake = tmp_path / 'yt-dlp'
    fake.write_text('#!/bin/sh\necho 2026.03.03\n')
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)

    class Stub:
        YTDLP_PATH = str(fake)
    app.ytdlp_downloader = Stub()
    assert client.get('/api/jobs/ytdlp-version', headers=auth).get_json() == {'version': '2026.03.03'}


# --- schedules -----------------------------------------------------------------------------

def test_schedules_carry_next_run_and_the_servers_clock(client, db, auth):
    body = client.get('/api/jobs/schedules', headers=auth).get_json()
    assert {j['id'] for j in body['jobs']} == set(body['schedules'])
    assert all(s['next_run'] is None for s in body['schedules'].values())   # nothing enabled
    assert body['server_time'] and body['tz']

    client.put('/api/jobs/schedules/check_files', headers=auth, json={'enabled': True, 'time': '03:00'})
    body = client.get('/api/jobs/schedules', headers=auth).get_json()
    assert body['schedules']['check_files']['next_run']


def test_schedule_saves_are_validated(client, db, auth):
    res = client.put('/api/jobs/schedules/check_files', headers=auth, json={'days': []})
    assert res.status_code == 400 and 'at least one day' in res.get_json()['error']
    res = client.put('/api/jobs/schedules/check_files', headers=auth, json={'days': ['mon']})
    assert res.status_code == 400
    res = client.put('/api/jobs/schedules/check_files', headers=auth, json={'time': 5})
    assert res.status_code == 400
    # Disabling answers with no next run
    res = client.put('/api/jobs/schedules/check_files', headers=auth, json={'enabled': False})
    assert res.status_code == 200 and res.get_json()['schedule']['next_run'] is None


def test_check_files_route_reports_a_failing_job(client, db, auth, monkeypatch):
    import backend.jobs as jobs
    monkeypatch.setitem(jobs.JOBS['check_files'], 'run', lambda: (_ for _ in ()).throw(RuntimeError('disk gone')))
    res = client.post('/api/jobs/check-files', headers=auth)
    assert res.status_code == 500 and res.get_json()['error'] == 'disk gone'

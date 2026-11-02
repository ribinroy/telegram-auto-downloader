

def test_check_files_flips_the_deleted_flag_both_ways(db):
    from backend.config import DOWNLOAD_DIR
    from backend.jobs import run_check_files
    (DOWNLOAD_DIR / 'back.mkv').write_bytes(b'x')
    (DOWNLOAD_DIR / 'kept.mkv').write_bytes(b'x')
    db.add_download(file='back.mkv', status='done', downloaded_from='telegram', message_id='c-1')
    db.add_download(file='gone.mkv', status='done', downloaded_from='telegram', message_id='c-2')
    db.add_download(file='kept.mkv', status='done', downloaded_from='telegram', message_id='c-3')
    db.add_download(file='partial.mkv', status='downloading', downloaded_from='telegram', message_id='c-4')
    db.update_download_by_message_id('c-1', file_deleted=True)

    stats = run_check_files()

    assert stats == {'checked': 3, 'present': 2, 'missing': 1, 'marked_missing': 1, 'restored': 1}
    assert db.get_download_by_message_id('c-1')['file_deleted'] is False
    assert db.get_download_by_message_id('c-2')['file_deleted'] is True
    assert db.get_download_by_message_id('c-4')['file_deleted'] is False  # unfinished: untouched


def test_check_files_route_runs_the_job(client, db, auth):
    res = client.post('/api/jobs/check-files', headers=auth)
    assert res.status_code == 200
    assert res.get_json()['checked'] == 0

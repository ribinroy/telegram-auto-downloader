"""Rename rules, scheduled jobs and the VPS connection - the settings surface
that changes how downloads behave."""
import pytest

from backend.web_app.routes import vps_settings as vroute


# --- rename rules ---------------------------------------------------------

def make_rule(client, auth, **over):
    body = {'name': 'dots', 'pattern': r'(?<=\w)[._](?=\w)', 'replacement': ' ',
            'enabled': True}
    body.update(over)
    return client.post('/api/settings/rename-rules', headers=auth, json=body)


def rules_of(client, auth):
    body = client.get('/api/settings/rename-rules', headers=auth).get_json()
    return body['rules'] if isinstance(body, dict) else body


def test_rule_crud(client, db, auth):
    assert make_rule(client, auth).status_code in (200, 201)
    rules = rules_of(client, auth)
    assert len(rules) == 1 and rules[0]['name'] == 'dots'

    # PUT is a full replace, not a patch: the pattern is revalidated, so the
    # whole rule has to be sent.
    rid = rules[0]['id']
    assert client.put(f'/api/settings/rename-rules/{rid}', headers=auth,
                      json={'name': 'renamed', 'pattern': r'(?<=\w)[._](?=\w)',
                            'replacement': ' ', 'enabled': False}).status_code == 200
    assert rules_of(client, auth)[0]['name'] == 'renamed'


def test_a_partial_update_is_refused_rather_than_wiping_the_pattern(client, db, auth):
    """PUT revalidates, so a body without a pattern fails loudly instead of
    silently storing an empty one."""
    make_rule(client, auth)
    rid = rules_of(client, auth)[0]['id']
    res = client.put(f'/api/settings/rename-rules/{rid}', headers=auth,
                     json={'name': 'renamed'})
    assert res.status_code == 400
    assert rules_of(client, auth)[0]['pattern']    # still intact

    assert client.delete(f'/api/settings/rename-rules/{rid}', headers=auth).status_code == 200
    assert rules_of(client, auth) == []


def test_an_invalid_regex_is_refused_on_save(client, db, auth):
    res = make_rule(client, auth, pattern='(unclosed')
    assert res.status_code == 400
    assert rules_of(client, auth) == []


def test_javascript_group_syntax_is_refused_on_save(client, db, auth):
    """$1 compiles fine and would silently write a literal "$1" into filenames."""
    res = make_rule(client, auth, pattern=r'(\d+)', replacement='$1')
    assert res.status_code == 400


def test_an_empty_pattern_is_refused(client, db, auth):
    assert make_rule(client, auth, pattern='').status_code == 400


def test_preview_runs_an_unsaved_draft_without_storing_it(client, db, auth):
    res = client.post('/api/settings/rename-rules/test', headers=auth,
                      json={'rule': {'pattern': r'(?<=\w)\.(?=\w)', 'replacement': ' '},
                            'samples': ['The.Movie.2024.mkv', 'already clean.mkv']})
    assert res.status_code == 200
    body = res.get_json()
    assert body['changed'] == 1 and body['scanned'] == 2
    assert any(r['new'] == 'The Movie 2024.mkv' for r in body['results'])
    assert rules_of(client, auth) == []       # nothing was saved


def test_preview_refuses_a_broken_draft_before_it_can_be_saved(client, db, auth):
    res = client.post('/api/settings/rename-rules/test', headers=auth,
                      json={'rule': {'pattern': '(unclosed', 'replacement': ''},
                            'samples': ['x.mkv']})
    assert res.status_code == 400


def test_preview_leads_with_the_matches(client, db, auth):
    """They are what the user is checking; untouched names pad the rest."""
    res = client.post('/api/settings/rename-rules/test', headers=auth,
                      json={'rule': {'pattern': 'Movie', 'replacement': 'Film'},
                            'samples': ['clean.mkv', 'nothing.mkv', 'The.Movie.mkv']})
    results = res.get_json()['results']
    assert results[0]['changed'] is True


def test_reorder_changes_which_rule_runs_first(client, db, auth):
    make_rule(client, auth, name='first', pattern='a', replacement='b')
    make_rule(client, auth, name='second', pattern='b', replacement='c')
    ids = [r['id'] for r in rules_of(client, auth)]
    res = client.post('/api/settings/rename-rules/reorder', headers=auth,
                      json={'ids': list(reversed(ids))})
    assert res.status_code == 200
    assert [r['id'] for r in rules_of(client, auth)] == list(reversed(ids))


def test_apply_defaults_to_a_dry_run(client, db, auth):
    """It must never touch files unless asked - the default is a plan."""
    db.add_download(file='The.Movie.mkv', status='done',
                    downloaded_from='telegram', message_id='m-1')
    make_rule(client, auth)
    res = client.post('/api/settings/rename-rules/apply', headers=auth, json={})
    assert res.status_code == 200
    body = res.get_json()
    assert body.get('dry_run') is not False
    # The record is untouched by a dry run.
    rows = db.get_all_downloads()
    assert any(r['file'] == 'The.Movie.mkv' for r in rows)


# --- scheduled jobs -------------------------------------------------------

def test_schedules_list_every_job_with_its_timezone(client, db, auth):
    body = client.get('/api/jobs/schedules', headers=auth).get_json()
    assert body.get('tz')
    jobs = body['jobs'] if isinstance(body.get('jobs'), list) else body
    assert jobs


def test_saving_a_schedule_echoes_the_next_run(client, db, auth):
    body = client.get('/api/jobs/schedules', headers=auth).get_json()
    job_id = (body['jobs'] if isinstance(body.get('jobs'), list) else body)[0]['id']
    res = client.put(f'/api/jobs/schedules/{job_id}', headers=auth,
                     json={'enabled': True, 'time': '03:00', 'days': [0, 1, 2, 3, 4, 5, 6]})
    assert res.status_code == 200
    # The server echoes the recomputed schedule, next run included.
    assert res.get_json()['schedule']['next_run']


def test_an_invalid_time_is_refused(client, db, auth):
    body = client.get('/api/jobs/schedules', headers=auth).get_json()
    job_id = (body['jobs'] if isinstance(body.get('jobs'), list) else body)[0]['id']
    res = client.put(f'/api/jobs/schedules/{job_id}', headers=auth,
                     json={'enabled': True, 'time': '99:99'})
    assert res.status_code == 400


def test_an_unknown_job_is_404(client, db, auth):
    res = client.put('/api/jobs/schedules/no-such-job', headers=auth, json={'enabled': True})
    assert res.status_code == 404


# --- VPS connection -------------------------------------------------------

def test_vps_config_starts_empty(client, db, auth):
    body = client.get('/api/settings/vps', headers=auth).get_json()
    assert not body.get('host')


def test_saving_the_vps_never_echoes_the_password(client, db, auth, monkeypatch):
    monkeypatch.setattr(vroute, 'close_pooled_session', lambda: None)
    res = client.post('/api/settings/vps', headers=auth,
                      json={'host': 'box.example', 'port': 22,
                            'username': 'tester', 'password': 'secret'})
    assert res.status_code == 200
    body = client.get('/api/settings/vps', headers=auth).get_json()
    assert body['host'] == 'box.example'
    assert body.get('has_password') is True
    assert 'secret' not in str(body)


def test_saving_the_vps_drops_the_warm_ssh_session(client, db, auth, monkeypatch):
    """The pool points at the old box; leaving it would send the next call
    to the wrong host."""
    calls = []
    monkeypatch.setattr(vroute, 'close_pooled_session', lambda: calls.append(1))
    client.post('/api/settings/vps', headers=auth,
                json={'host': 'box.example', 'port': 22, 'username': 'u', 'password': 'p'})
    assert calls == [1]
    client.delete('/api/settings/vps', headers=auth)
    assert calls == [1, 1]


def test_watched_folders_crud(client, db, auth, monkeypatch):
    monkeypatch.setattr(vroute, 'close_pooled_session', lambda: None)
    client.post('/api/settings/vps', headers=auth,
                json={'host': 'box.example', 'port': 22, 'username': 'u', 'password': 'p'})
    res = client.post('/api/settings/vps/folders', headers=auth,
                      json={'paths': ['/home/u/watch']})
    assert res.status_code == 200
    folders = client.get('/api/settings/vps/folders', headers=auth).get_json()
    rows = folders['folders'] if isinstance(folders, dict) else folders
    row = next(r for r in rows if r['path'] == '/home/u/watch')
    assert row['active'] is True          # belongs to the saved connection

    patched = client.patch(f"/api/settings/vps/folders/{row['id']}", headers=auth,
                           json={'folder': '/mnt/dest', 'is_secured': True})
    assert patched.status_code == 200
    assert client.delete(f"/api/settings/vps/folders/{row['id']}",
                         headers=auth).status_code == 200


# --- usage ----------------------------------------------------------------

def test_usage_reports_a_clean_error_when_nothing_is_configured(client, db, auth):
    body = client.get('/api/vps/usage', headers=auth).get_json()
    assert body['disk'] is None
    assert 'configured' in body['disk_error']
    assert body['clients'] == []

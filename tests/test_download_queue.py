"""Download queue: admission, ordering, per-source caps and the routes that
drive it. The handlers themselves are stubbed - starting a waiting download
is resume_download(), which is recorded here instead of reaching Telegram,
yt-dlp or a seedbox."""
import threading

import pytest

from backend import download_queue as dq


@pytest.fixture
def started(monkeypatch):
    """Every handler ready; record what the queue starts, synchronously."""
    calls = []
    monkeypatch.setattr(dq, '_source_ready', lambda source: True)
    monkeypatch.setattr(dq, '_emit_status', lambda *a: None)
    monkeypatch.setattr(dq, '_notify', lambda: None)

    def fake_resume(download, force=False, count_retry=True):
        calls.append(download['message_id'])
        return True
    monkeypatch.setattr('backend.resume.resume_download', fake_resume)

    # Run queue-start workers inline so asserts see the result
    monkeypatch.setattr(dq, '_run_in_background', lambda fn: fn())
    return calls


def new(db, name, source='telegram'):
    """Create a download through admission, the way a handler does."""
    kwargs = {'vps': {'downloaded_from': 'vps', 'url': f'/r/{name}'},
              'ytdlp': {'downloaded_from': 'example.com', 'url': f'https://x/{name}'},
              'telegram': {}}[source]
    download, started = dq.admit(source, lambda status, position: db.add_download(
        file=name, status=status, queue_position=position, message_id=f'id-{name}', **kwargs))
    return download, started


def finish(db, name):
    db.update_download_by_message_id(f'id-{name}', status='done')


def statuses(db):
    return {d['file']: d['status'] for d in db.get_all_downloads()}


def test_downloads_past_the_limit_wait_in_arrival_order(db, started):
    dq.set_limits({'global': 2})
    results = [new(db, n) for n in ('a', 'b', 'c', 'd')]
    assert [s for _d, s in results] == [True, True, False, False]
    assert [d['file'] for d in db.get_waiting_downloads()] == ['c', 'd']
    assert [d['queue_position'] for d in db.get_waiting_downloads()] == [0, 1]


def test_a_freed_slot_goes_to_the_first_waiting_download(db, started):
    dq.set_limits({'global': 1})
    for n in ('a', 'b', 'c'):
        new(db, n)
    finish(db, 'a')
    assert dq.pump() == 1
    assert started == ['id-b']
    assert statuses(db)['b'] == 'downloading'
    # Leaving the queue clears its place in it
    assert db.get_download_by_message_id('id-b')['queue_position'] is None
    assert [d['file'] for d in db.get_waiting_downloads()] == ['c']


def test_a_full_source_cap_skips_ahead_instead_of_blocking_the_queue(db, started):
    dq.set_limits({'global': 3, 'vps': 1})
    new(db, 'v1', 'vps')
    new(db, 't1')
    new(db, 't2')
    new(db, 'v2', 'vps')          # global full -> waits
    new(db, 't3')                 # waits behind v2
    finish(db, 't1')
    dq.pump()
    # v2 is first in line but VPS is at its cap of 1, so t3 takes the slot
    assert started == ['id-t3']
    assert [d['file'] for d in db.get_waiting_downloads()] == ['v2']


def test_a_newcomer_does_not_jump_a_waiting_download_that_fits(db, started):
    dq.set_limits({'global': 1})
    new(db, 'a')
    new(db, 'b')
    finish(db, 'a')               # slot free, but b is already waiting for it
    _download, ran = new(db, 'c')
    assert ran is False
    assert [d['file'] for d in db.get_waiting_downloads()] == ['b', 'c']


def test_raising_the_limit_lets_the_queue_through(db, started):
    dq.set_limits({'global': 1})
    for n in ('a', 'b', 'c'):
        new(db, n)
    dq.set_limits({'global': 3})
    assert dq.pump() == 2
    assert started == ['id-b', 'id-c']


def test_lowering_the_limit_never_stops_a_running_download(db, started):
    dq.set_limits({'global': 3})
    for n in ('a', 'b', 'c'):
        new(db, n)
    dq.set_limits({'global': 1})
    assert set(statuses(db).values()) == {'downloading'}
    _download, ran = new(db, 'd')
    assert ran is False


def test_a_handler_that_refuses_fails_the_download_instead_of_stranding_it(db, started, monkeypatch):
    monkeypatch.setattr('backend.resume.resume_download', lambda *a, **k: False)
    dq.set_limits({'global': 1})
    new(db, 'a')
    new(db, 'b')
    finish(db, 'a')
    dq.pump()
    b = db.get_download_by_message_id('id-b')
    assert b['status'] == 'failed' and 'queue' in b['error']


def test_a_handler_that_is_not_ready_keeps_its_downloads_waiting(db, started, monkeypatch):
    dq.set_limits({'global': 1})
    new(db, 'a')
    new(db, 'b')
    finish(db, 'a')
    monkeypatch.setattr(dq, '_source_ready', lambda source: False)
    assert dq.pump() == 0
    assert statuses(db)['b'] == 'waiting'


def test_admission_holds_the_last_slot_against_a_race(db, started):
    """Many downloads arriving at once must not all see the same free slot."""
    dq.set_limits({'global': 2})
    names = [f'r{i}' for i in range(8)]
    threads = [threading.Thread(target=new, args=(db, n)) for n in names]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert list(statuses(db).values()).count('downloading') == 2
    positions = [d['queue_position'] for d in db.get_waiting_downloads()]
    assert positions == list(range(6))


def test_limits_are_validated():
    with pytest.raises(ValueError):
        dq._clean_limit(0, allow_none=False)
    with pytest.raises(ValueError):
        dq._clean_limit(dq.MAX_LIMIT + 1, allow_none=False)
    with pytest.raises(ValueError):
        dq._clean_limit(None, allow_none=False)       # the global cap can't be removed
    assert dq._clean_limit(None, allow_none=True) is None
    assert dq._clean_limit('4', allow_none=True) == 4


# --- routes ---------------------------------------------------------------

def test_queue_routes_reorder_and_start_now(client, db, auth, started):
    dq.set_limits({'global': 1})
    for n in ('a', 'b', 'c', 'd'):
        new(db, n)

    body = client.get('/api/queue', headers=auth).get_json()
    assert body['limits']['global'] == 1
    assert body['active']['total'] == 1
    assert [d['file'] for d in body['waiting']] == ['b', 'c', 'd']

    body = client.post('/api/queue/reorder', headers=auth,
                       json={'message_ids': ['id-d', 'id-b']}).get_json()
    # Ones left out of the list keep their order behind it
    assert [d['file'] for d in body['waiting']] == ['d', 'b', 'c']

    body = client.post('/api/queue/start-now', headers=auth, json={'message_id': 'id-c'}).get_json()
    assert started == ['id-c']
    assert [d['file'] for d in body['waiting']] == ['d', 'b']
    assert body['active']['total'] == 2          # past the limit, on purpose
    assert client.post('/api/queue/start-now', headers=auth,
                       json={'message_id': 'id-c'}).status_code == 400


def test_limits_route(client, db, auth, started):
    res = client.put('/api/queue/limits', headers=auth, json={'global': 5, 'vps': 2})
    assert res.status_code == 200
    assert res.get_json()['limits'] == {'global': 5, 'telegram': None, 'ytdlp': None, 'vps': 2}
    res = client.put('/api/queue/limits', headers=auth, json={'vps': None})
    assert res.get_json()['limits']['vps'] is None
    assert client.put('/api/queue/limits', headers=auth, json={'global': 0}).status_code == 400
    assert client.put('/api/queue/limits', headers=auth, json={'nope': 1}).status_code == 400


def test_stopping_a_waiting_download_takes_it_out_of_the_queue(client, db, auth, started):
    dq.set_limits({'global': 1})
    new(db, 'a', 'ytdlp')
    new(db, 'b', 'ytdlp')
    assert client.post('/api/stop', headers=auth, json={'message_id': 'id-b'}).status_code == 200
    b = db.get_download_by_message_id('id-b')
    assert b['status'] == 'stopped' and b['queue_position'] is None
    assert db.get_waiting_downloads() == []


def test_a_retry_with_no_free_slot_joins_the_queue(client, db, auth, started):
    dq.set_limits({'global': 1})
    new(db, 'a', 'ytdlp')
    failed = db.add_download(file='old', status='failed', message_id='id-old',
                             downloaded_from='example.com', url='https://x/old')
    res = client.post('/api/retry', headers=auth, json={'id': failed['id']})
    assert res.get_json() == {'status': 'waiting'}
    assert [d['file'] for d in db.get_waiting_downloads()] == ['old']
    assert started == []

"""Auth surface: tokens, revocation, rate limiting, the password-change lockdown."""
import pytest

from conftest import TEST_PASSWORD


def test_login_rejects_bad_credentials(client, db):
    res = client.post('/api/auth/login', json={'username': 'admin', 'password': 'wrong'})
    assert res.status_code == 401


def test_login_requires_both_fields(client, db):
    assert client.post('/api/auth/login', json={'username': 'admin'}).status_code == 400
    assert client.post('/api/auth/login', json={}).status_code == 400


def test_default_credentials_force_a_password_change(client, db):
    res = client.post('/api/auth/login', json={'username': 'admin', 'password': 'admin'})
    assert res.status_code == 200
    assert res.get_json()['must_change_password'] is True


def test_login_returns_a_token_pair(client, db, auth):
    res = client.post('/api/auth/login',
                      json={'username': 'admin', 'password': TEST_PASSWORD})
    body = res.get_json()
    assert body['token'] and body['refresh_token']
    assert body['expires_in'] > 0
    assert 'password' not in str(body).lower() or body.get('user', {}).get('password') is None


# --- access control -------------------------------------------------------

PROTECTED = [
    ('GET', '/api/downloads'), ('GET', '/api/stats'), ('GET', '/api/authors'),
    ('GET', '/api/analytics'), ('GET', '/api/mappings'),
    ('GET', '/api/settings/vps'), ('GET', '/api/settings/torrent'),
    ('GET', '/api/settings/rename-rules'), ('GET', '/api/jobs/schedules'),
    ('GET', '/api/files/roots'), ('POST', '/api/files/list'),
    ('GET', '/api/vps/usage'), ('GET', '/api/torrent/list'),
]


@pytest.mark.parametrize('method,path', PROTECTED)
def test_every_api_route_refuses_an_anonymous_caller(client, db, method, path):
    res = client.open(path, method=method, json={})
    assert res.status_code == 401, f'{method} {path} returned {res.status_code}'


@pytest.mark.parametrize('method,path', PROTECTED)
def test_every_api_route_accepts_a_valid_token(client, db, auth, method, path):
    res = client.open(path, method=method, json={}, headers=auth)
    assert res.status_code != 401, f'{method} {path} rejected a valid token'


def test_a_token_signed_with_the_wrong_secret_is_refused(client, db):
    import jwt
    forged = jwt.encode({'user_id': 1, 'username': 'admin', 'tv': 0},
                        'not-the-real-secret', algorithm='HS256')
    res = client.get('/api/downloads', headers={'Authorization': f'Bearer {forged}'})
    assert res.status_code == 401


def test_an_unsigned_token_is_refused(client, db):
    """alg=none is the classic JWT forgery; algorithms=['HS256'] must be pinned."""
    import base64, json as js
    def seg(d):
        return base64.urlsafe_b64encode(js.dumps(d).encode()).rstrip(b'=').decode()
    forged = f"{seg({'alg': 'none', 'typ': 'JWT'})}.{seg({'user_id': 1, 'tv': 0})}."
    res = client.get('/api/downloads', headers={'Authorization': f'Bearer {forged}'})
    assert res.status_code == 401


def test_garbage_authorization_headers_are_refused(client, db):
    for header in ('', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer not.a.jwt'):
        res = client.get('/api/downloads', headers={'Authorization': header})
        assert res.status_code == 401


def test_verify_confirms_a_good_token(client, db, auth):
    assert client.get('/api/auth/verify', headers=auth).status_code == 200


# --- token separation -----------------------------------------------------

def test_a_media_token_does_not_work_on_the_api(client, db, auth):
    media = client.get('/api/auth/media-token', headers=auth).get_json()['media_token']
    res = client.get('/api/downloads', headers={'Authorization': f'Bearer {media}'})
    assert res.status_code == 401


def test_a_media_token_is_accepted_on_a_media_route(client, db, auth):
    media = client.get('/api/auth/media-token', headers=auth).get_json()['media_token']
    # 404 (no such download) proves it got past the auth decorator.
    res = client.get(f'/api/video/stream/99999?token={media}')
    assert res.status_code != 401


# --- revocation -----------------------------------------------------------

def test_changing_the_password_invalidates_old_tokens(client, db, auth):
    assert client.get('/api/downloads', headers=auth).status_code == 200
    res = client.post('/api/auth/password', headers=auth,
                      json={'current_password': TEST_PASSWORD,
                            'new_password': 'another-password-456'})
    assert res.status_code == 200
    # The tv claim no longer matches users.token_version, so it dies at once.
    assert client.get('/api/downloads', headers=auth).status_code == 401


def test_password_change_enforces_a_minimum_length(client, db, auth):
    res = client.post('/api/auth/password', headers=auth,
                      json={'current_password': TEST_PASSWORD, 'new_password': 'short'})
    assert res.status_code == 400


def test_password_change_requires_the_current_password(client, db, auth):
    res = client.post('/api/auth/password', headers=auth,
                      json={'current_password': 'wrong', 'new_password': 'another-password-456'})
    assert res.status_code in (400, 401, 403)


def test_logout_all_kills_every_outstanding_token(client, db, auth):
    assert client.post('/api/auth/logout-all', headers=auth).status_code == 200
    assert client.get('/api/downloads', headers=auth).status_code == 401


# --- refresh rotation -----------------------------------------------------

def test_refresh_returns_a_new_pair(client, db, auth, login):
    login = login()
    res = client.post('/api/auth/refresh', json={'refresh_token': login['refresh_token']})
    assert res.status_code == 200
    assert res.get_json()['refresh_token'] != login['refresh_token']


def test_replaying_a_superseded_refresh_token_revokes_the_session(client, db, auth, login):
    login = login()
    first = login['refresh_token']
    rotated = client.post('/api/auth/refresh', json={'refresh_token': first}).get_json()
    # Theft detection: the old one coming back means someone copied it.
    assert client.post('/api/auth/refresh', json={'refresh_token': first}).status_code == 401
    assert client.post('/api/auth/refresh',
                       json={'refresh_token': rotated['refresh_token']}).status_code == 401


# --- rate limiting --------------------------------------------------------

def test_repeated_failures_are_rate_limited(client, db):
    codes = [client.post('/api/auth/login',
                         json={'username': 'nobody', 'password': f'x{i}'}).status_code
             for i in range(8)]
    assert 429 in codes, codes

"""The login brute-force limiter: lockout growth, expiry, table bounds, and
which address an attempt is keyed on behind a proxy."""
import time

import pytest

from backend.web_app import ratelimit
from backend.web_app.ratelimit import RateLimiter


@pytest.fixture
def clock(monkeypatch):
    """A controllable time.time() for the limiter."""
    state = {'now': 1_000_000.0}
    monkeypatch.setattr(ratelimit.time, 'time', lambda: state['now'])

    def advance(seconds):
        state['now'] += seconds
    return advance


@pytest.fixture
def limiter(clock):
    return RateLimiter(max_attempts=2, window=100, base_lockout=30, max_lockout=100)


# --- lockout ---------------------------------------------------------------

def test_failures_under_the_threshold_do_not_lock(limiter):
    assert limiter.register_failure(['ip:a']) == 0
    assert limiter.register_failure(['ip:a']) == 0
    assert limiter.retry_after(['ip:a']) == 0


def test_the_lockout_doubles_per_extra_failure_and_caps(limiter):
    limiter.register_failure(['ip:a'])
    limiter.register_failure(['ip:a'])
    assert limiter.register_failure(['ip:a']) == 30
    assert limiter.register_failure(['ip:a']) == 60
    assert limiter.register_failure(['ip:a']) == 100     # capped
    assert limiter.register_failure(['ip:a']) == 100


def test_retry_after_counts_down_and_expires(limiter, clock):
    for _ in range(3):
        limiter.register_failure(['ip:a'])
    assert 0 < limiter.retry_after(['ip:a']) <= 31
    clock(10)
    assert 0 < limiter.retry_after(['ip:a']) <= 21
    clock(25)
    assert limiter.retry_after(['ip:a']) == 0


def test_retry_after_is_the_longest_of_the_keys(limiter):
    for _ in range(3):
        limiter.register_failure(['ip:a'])
    for _ in range(4):
        limiter.register_failure(['user:bob'])
    assert limiter.retry_after(['ip:a', 'user:bob']) == limiter.retry_after(['user:bob'])
    assert limiter.retry_after(['ip:a']) < limiter.retry_after(['user:bob'])
    assert limiter.retry_after(['ip:nobody']) == 0


def test_failures_decay_out_of_the_window(limiter, clock):
    limiter.register_failure(['ip:a'])
    limiter.register_failure(['ip:a'])
    clock(101)                                   # both stamps fall out of the window
    assert limiter.register_failure(['ip:a']) == 0
    assert limiter.register_failure(['ip:a']) == 0
    assert limiter.register_failure(['ip:a']) == 30


def test_a_success_clears_the_counters(limiter):
    for _ in range(3):
        limiter.register_failure(['ip:a', 'user:bob'])
    limiter.register_success(['ip:a'])
    assert limiter.retry_after(['ip:a']) == 0
    assert limiter.retry_after(['user:bob']) > 0        # the other key is untouched
    limiter.reset()
    assert limiter.retry_after(['user:bob']) == 0


def test_every_key_of_an_attempt_is_counted(limiter):
    for _ in range(3):
        limiter.register_failure(['ip:a', 'user:bob'])
    assert limiter.retry_after(['ip:a']) > 0 and limiter.retry_after(['user:bob']) > 0


# --- table bounds ----------------------------------------------------------

def test_prune_drops_idle_keys_but_keeps_an_active_lockout(limiter, clock):
    for _ in range(3):
        limiter.register_failure(['ip:locked'])     # locked for 30s
    limiter.register_failure(['ip:idle'])
    clock(101)                                       # everything is older than the window
    # ...but the lockout is still running? No - 30s passed long ago. Make a
    # fresh one that is still active at prune time.
    for _ in range(3):
        limiter.register_failure(['ip:fresh'])
    clock(50)                                        # idle/locked stamps are stale; fresh is locked for 50 more
    now = ratelimit.time.time()
    limiter._prune(now)
    assert 'ip:idle' not in limiter._failures
    assert 'ip:locked' not in limiter._failures
    assert 'ip:fresh' in limiter._failures           # stale stamps, but still locked out


def test_a_flood_of_keys_is_capped_by_evicting_the_least_recent(limiter, clock, monkeypatch):
    monkeypatch.setattr(ratelimit, 'MAX_TRACKED_KEYS', 3)
    for _ in range(3):
        limiter.register_failure(['user:locked'])   # active lockout: never evicted
    for name in ('u1', 'u2', 'u3', 'u4'):
        clock(1)
        limiter.register_failure([f'user:{name}'])
    # register_failure prunes once the table is over the cap
    assert len(limiter._failures) <= 4
    assert 'user:locked' in limiter._failures
    assert 'user:u1' not in limiter._failures        # the oldest unlocked went first


# --- client address ---------------------------------------------------------

class Req:
    def __init__(self, remote_addr='10.0.0.9', **headers):
        self.remote_addr = remote_addr
        self.headers = {k.replace('_', '-'): v for k, v in headers.items()}


def test_client_ip_ignores_forwarded_headers_unless_told_to_trust_them(monkeypatch):
    monkeypatch.setattr('backend.config.TRUST_PROXY_HEADERS', False)
    req = Req(X_Forwarded_For='1.1.1.1', X_Real_IP='2.2.2.2')
    assert ratelimit.client_ip(req) == '10.0.0.9'


def test_client_ip_takes_the_nth_from_the_right_behind_trusted_proxies(monkeypatch):
    monkeypatch.setattr('backend.config.TRUST_PROXY_HEADERS', True)
    monkeypatch.setattr('backend.config.TRUSTED_PROXY_COUNT', 1)
    assert ratelimit.client_ip(Req(X_Forwarded_For='9.9.9.9, 8.8.8.8')) == '8.8.8.8'
    monkeypatch.setattr('backend.config.TRUSTED_PROXY_COUNT', 2)
    assert ratelimit.client_ip(Req(X_Forwarded_For='9.9.9.9, 8.8.8.8, 7.7.7.7')) == '8.8.8.8'
    # More proxies claimed than entries: the first entry, never an index error
    monkeypatch.setattr('backend.config.TRUSTED_PROXY_COUNT', 5)
    assert ratelimit.client_ip(Req(X_Forwarded_For='9.9.9.9, 8.8.8.8')) == '9.9.9.9'
    # A count of 0 still means at least one proxy
    monkeypatch.setattr('backend.config.TRUSTED_PROXY_COUNT', 0)
    assert ratelimit.client_ip(Req(X_Forwarded_For='9.9.9.9, 8.8.8.8')) == '8.8.8.8'


def test_client_ip_falls_back_to_x_real_ip_then_the_socket(monkeypatch):
    monkeypatch.setattr('backend.config.TRUST_PROXY_HEADERS', True)
    assert ratelimit.client_ip(Req(X_Real_IP=' 3.3.3.3 ')) == '3.3.3.3'
    assert ratelimit.client_ip(Req(X_Forwarded_For=' , ')) == '10.0.0.9'
    assert ratelimit.client_ip(Req(remote_addr=None)) == 'unknown'


def test_login_keys_bucket_by_ip_and_normalized_username(monkeypatch):
    monkeypatch.setattr('backend.config.TRUST_PROXY_HEADERS', False)
    assert ratelimit.login_keys(Req(), '  Admin ') == ['ip:10.0.0.9', 'user:admin']
    assert ratelimit.login_keys(Req(), '') == ['ip:10.0.0.9']

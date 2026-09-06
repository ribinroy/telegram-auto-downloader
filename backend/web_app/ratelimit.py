"""Brute-force protection for the login endpoint.

Deliberately in-process: DownLee runs as a single Flask process (SocketIO
threading mode), so a dict behind a lock is accurate and costs nothing. If the
app is ever run multi-worker this needs to move to Redis/Postgres - the
interface below is small enough to swap.

Two independent buckets are consulted on every attempt:

  * per source IP  - stops one host spraying many usernames
  * per username   - stops a distributed spray against one account

Failures decay out of a sliding window; once the threshold is crossed the key
is locked out for a period that doubles with each further failure, capped.
"""
import threading
import time

# Sliding window in which failures accumulate
WINDOW_SECONDS = 15 * 60
# Failures allowed inside the window before lockout kicks in
MAX_ATTEMPTS = 5
# First lockout, doubled per extra failure, capped at MAX_LOCKOUT_SECONDS
BASE_LOCKOUT_SECONDS = 30
MAX_LOCKOUT_SECONDS = 15 * 60
# Never let the table grow without bound
MAX_TRACKED_KEYS = 10_000


class RateLimiter:
    def __init__(self, max_attempts=MAX_ATTEMPTS, window=WINDOW_SECONDS,
                 base_lockout=BASE_LOCKOUT_SECONDS, max_lockout=MAX_LOCKOUT_SECONDS):
        self.max_attempts = max_attempts
        self.window = window
        self.base_lockout = base_lockout
        self.max_lockout = max_lockout
        self._lock = threading.Lock()
        self._failures = {}   # key -> list[timestamp]
        self._locked_until = {}  # key -> timestamp

    def _prune(self, now):
        """Drop keys with no recent activity (called under the lock)."""
        cutoff = now - self.window
        for key in [k for k, ts in self._failures.items() if not ts or ts[-1] < cutoff]:
            if self._locked_until.get(key, 0) <= now:
                self._failures.pop(key, None)
                self._locked_until.pop(key, None)

    def retry_after(self, keys):
        """Seconds the caller must wait, or 0 if the attempt may proceed."""
        now = time.time()
        with self._lock:
            return max((int(self._locked_until.get(k, 0) - now) + 1
                        for k in keys if self._locked_until.get(k, 0) > now),
                       default=0)

    def register_failure(self, keys):
        """Record a failed attempt against every key. Returns the resulting
        lockout in seconds (0 if still under the threshold)."""
        now = time.time()
        cutoff = now - self.window
        longest = 0
        with self._lock:
            if len(self._failures) > MAX_TRACKED_KEYS:
                self._prune(now)
            for key in keys:
                stamps = [t for t in self._failures.get(key, []) if t >= cutoff]
                stamps.append(now)
                self._failures[key] = stamps
                # max_attempts failures are allowed; the next one locks.
                over = len(stamps) - self.max_attempts
                if over > 0:
                    lockout = min(self.base_lockout * (2 ** (over - 1)), self.max_lockout)
                    self._locked_until[key] = now + lockout
                    longest = max(longest, int(lockout))
        return longest

    def register_success(self, keys):
        """Clear the counters for these keys after a successful auth."""
        with self._lock:
            for key in keys:
                self._failures.pop(key, None)
                self._locked_until.pop(key, None)

    def reset(self):
        with self._lock:
            self._failures.clear()
            self._locked_until.clear()


# The limiter guarding POST /api/auth/login
login_limiter = RateLimiter()


def client_ip(request):
    """Best-effort source address.

    X-Forwarded-For is only consulted when TRUST_PROXY_HEADERS is set, because
    an untrusted client can forge it - and a forgeable rate-limit key is worse
    than no rate limit at all. With N trusted proxies in front, the client
    address is the Nth entry from the right of the chain.
    """
    from backend.config import TRUST_PROXY_HEADERS, TRUSTED_PROXY_COUNT

    if TRUST_PROXY_HEADERS:
        forwarded = request.headers.get('X-Forwarded-For', '')
        chain = [p.strip() for p in forwarded.split(',') if p.strip()]
        if chain:
            index = max(0, len(chain) - max(1, TRUSTED_PROXY_COUNT))
            return chain[index]
        real_ip = (request.headers.get('X-Real-IP') or '').strip()
        if real_ip:
            return real_ip
    return request.remote_addr or 'unknown'


def login_keys(request, username):
    """Bucket keys for a login attempt: the source IP and the target account."""
    keys = [f'ip:{client_ip(request)}']
    if username:
        keys.append(f'user:{(username or "").strip().lower()}')
    return keys

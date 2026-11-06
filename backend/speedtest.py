"""Server -> internet speed test, run by the backend itself.

The browser test (routes/speedtest.py) measures the link between a device
and the box; this one measures the box's own uplink, against the public
LibreSpeed servers (https://librespeed.org/backend-servers/servers.php).
They exist to be hit by speed-test clients - unlike speed.cloudflare.com,
which sits behind bot protection and stalls non-browser callers. The
nearest server is picked by pinging them all, the way the LibreSpeed client
does; a short built-in list covers the day the directory is down.

It runs on a daemon thread so the request that starts it returns at once
and the page polls `status()` for the live figure. One run at a time.

Everything is stdlib `http.client`: the download reads `garbage.php` in
chunks until the deadline (asking for another chunk set if a server caps
the size); the upload posts 4 MB bodies back to back - the biggest every
public server accepts (some sit behind an 8 MB nginx limit) - until the
deadline. A streamed body with a Content-Length you then abandon leaves
the far end waiting, so uploads are whole requests.
"""
import http.client
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse, urljoin

logger = logging.getLogger(__name__)

SERVER_LIST_URL = 'https://librespeed.org/backend-servers/servers.php'
FALLBACK_SERVERS = [
    {'name': 'Frankfurt, Germany (Clouvider)', 'server': 'https://fra.speedtest.clouvider.net/backend',
     'dlURL': 'garbage.php', 'ulURL': 'empty.php', 'pingURL': 'empty.php', 'getIpURL': 'getIP.php'},
    {'name': 'Amsterdam, Netherlands (Sharktech)', 'server': 'https://amsspeed.sharktech.net',
     'dlURL': 'backend/garbage.php', 'ulURL': 'backend/empty.php', 'pingURL': 'backend/empty.php',
     'getIpURL': 'backend/getIP.php'},
    {'name': 'Chicago, USA (Sharktech)', 'server': 'https://chispeed.sharktech.net',
     'dlURL': 'backend/garbage.php', 'ulURL': 'backend/empty.php', 'pingURL': 'backend/empty.php',
     'getIpURL': 'backend/getIP.php'},
]
CHUNK = 1024 * 1024
UPLOAD_CHUNK = 4 * CHUNK
DOWNLOAD_CKSIZE = 100  # garbage.php?ckSize=N serves N MB; re-requested until the deadline
PHASE_SECONDS = 8.0
WARMUP = 0.3
PING_COUNT = 8
HISTORY_SIZE = 8
USER_AGENT = 'DownLee speed test'
_NOISE = os.urandom(UPLOAD_CHUNK)


def to_mbps(nbytes, seconds):
    return (nbytes * 8) / seconds / 1_000_000 if seconds > 0 else 0.0


def throughput_mbps(samples, warmup=WARMUP):
    """Steady rate over (t, bytes) samples, skipping the first `warmup`
    seconds (TCP slow start); the whole run when there's too little after."""
    if len(samples) < 2:
        return 0.0
    last = samples[-1]
    start = next((s for s in samples if s[0] >= warmup), None)
    if start and start is not last and last[0] - start[0] >= 0.5:
        return to_mbps(last[1] - start[1], last[0] - start[0])
    return to_mbps(last[1], last[0])


def recent_mbps(samples, window=0.5):
    if len(samples) < 2:
        return 0.0
    last = samples[-1]
    i = len(samples) - 2
    while i > 0 and last[0] - samples[i][0] < window:
        i -= 1
    return to_mbps(last[1] - samples[i][1], last[0] - samples[i][0])


def ping_stats(rtts):
    if not rtts:
        return {'min': 0.0, 'avg': 0.0, 'max': 0.0, 'jitter': 0.0}
    diffs = [abs(a - b) for a, b in zip(rtts, rtts[1:])]
    return {
        'min': min(rtts), 'avg': sum(rtts) / len(rtts), 'max': max(rtts),
        'jitter': sum(diffs) / len(diffs) if diffs else 0.0,
    }


class Cancelled(Exception):
    pass


# --- HTTP ----------------------------------------------------------------------

class _Conn:
    """One kept-alive connection to a URL's host; `request()` returns the
    response, which the caller reads (or `.close()`s to drop a big body)."""

    def __init__(self, url, timeout=15):
        p = urlparse(url)
        cls = http.client.HTTPSConnection if p.scheme == 'https' else http.client.HTTPConnection
        self.conn = cls(p.hostname, p.port, timeout=timeout)

    def request(self, url, method='GET', body=None, headers=None):
        p = urlparse(url)
        path = (p.path or '/') + (f'?{p.query}' if p.query else '')
        h = {'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity'}
        h.update(headers or {})
        self.conn.request(method, path, body=body, headers=h)
        return self.conn.getresponse()

    def close(self):
        self.conn.close()


def _url(server, key):
    base = server['server'].rstrip('/') + '/'
    return urljoin(base, (server.get(key) or '').lstrip('/'))


def _nocache(url):
    return f"{url}{'&' if '?' in url else '?'}r={time.time_ns()}"


# --- the network bits, each replaceable in tests -----------------------------

_servers_cache = {'at': 0.0, 'servers': None}


def fetch_servers():
    """The public LibreSpeed directory, cached for an hour; the built-in
    few when it can't be fetched."""
    if _servers_cache['servers'] and time.time() - _servers_cache['at'] < 3600:
        return _servers_cache['servers']
    try:
        c = _Conn(SERVER_LIST_URL, timeout=10)
        try:
            res = c.request(SERVER_LIST_URL)
            data = json.loads(res.read().decode() or '[]')
        finally:
            c.close()
        servers = [s for s in data if isinstance(s, dict) and s.get('server') and s.get('dlURL')]
        if servers:
            _servers_cache.update(at=time.time(), servers=servers)
            return servers
    except (OSError, ValueError, http.client.HTTPException) as e:
        logger.debug('speedtest server list failed: %s', e)
    return list(FALLBACK_SERVERS)


def _probe(server, timeout=4.0):
    """Best of two round trips, or None if the server doesn't answer."""
    best = None
    try:
        c = _Conn(server['server'], timeout=timeout)
        try:
            for _ in range(2):
                t0 = time.perf_counter()
                res = c.request(_nocache(_url(server, 'pingURL')))
                res.read()
                if res.status < 400:
                    rtt = (time.perf_counter() - t0) * 1000
                    best = rtt if best is None else min(best, rtt)
        finally:
            c.close()
    except (OSError, http.client.HTTPException):
        return None
    return best


def pick_server(servers, cancelled=lambda: False):
    """The server with the lowest round trip - pinged in parallel, since the
    directory spans three continents and the far ones take seconds."""
    with ThreadPoolExecutor(max_workers=16) as pool:
        rtts = list(pool.map(lambda s: _probe(s, timeout=3.0), servers))
    if cancelled():
        raise Cancelled()
    ranked = sorted(((r, s) for r, s in zip(rtts, servers) if r is not None), key=lambda x: x[0])
    if not ranked:
        raise RuntimeError('No speed-test server is reachable')
    rtt, server = ranked[0]
    return {'name': server.get('name') or server['server'], 'server': server['server'],
            'dlURL': server.get('dlURL'), 'ulURL': server.get('ulURL'),
            'pingURL': server.get('pingURL'), 'getIpURL': server.get('getIpURL'), 'probe_ms': rtt}


def fetch_meta(server):
    """Who the box is to the internet, as the test server sees it."""
    c = _Conn(server['server'], timeout=10)
    try:
        res = c.request(_nocache(_url(server, 'getIpURL') + '?isp=true'))
        data = json.loads(res.read().decode() or '{}')
    finally:
        c.close()
    text = data.get('processedString') or ''
    ip, _, isp = text.partition(' - ')
    raw = data.get('rawIspInfo') if isinstance(data.get('rawIspInfo'), dict) else {}
    isp = isp.strip()
    if isp == 'Unknown ISP':
        isp = ''
    return {
        'ip': ip.strip() or None,
        'isp': raw.get('org') or isp or None,
        'location': ', '.join(x for x in (raw.get('city'), raw.get('country')) if x) or None,
        'server': server['name'],
        'server_url': server['server'],
    }


def measure_ping(server, count=PING_COUNT, cancelled=lambda: False):
    """Round trips on one kept-alive connection; the first request pays
    for TCP + TLS and is not counted."""
    c = _Conn(server['server'])
    rtts = []
    try:
        for i in range(count + 1):
            if cancelled():
                raise Cancelled()
            t0 = time.perf_counter()
            res = c.request(_nocache(_url(server, 'pingURL')))
            res.read()
            if i:
                rtts.append((time.perf_counter() - t0) * 1000)
    finally:
        c.close()
    return rtts


def measure_download(server, seconds=PHASE_SECONDS, on_progress=None, cancelled=lambda: False):
    c = _Conn(server['server'], timeout=20)
    samples = [(0.0, 0)]
    total = 0
    t0 = time.perf_counter()
    last_report = t0
    try:
        while time.perf_counter() - t0 < seconds:
            res = c.request(_nocache(_url(server, 'dlURL') + f'?ckSize={DOWNLOAD_CKSIZE}'))
            if res.status != 200:
                raise RuntimeError(f'download refused ({res.status})')
            while True:
                if cancelled():
                    raise Cancelled()
                chunk = res.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                now = time.perf_counter()
                if now - last_report >= 0.1:
                    samples.append((now - t0, total))
                    last_report = now
                    if on_progress:
                        on_progress(samples)
                if now - t0 >= seconds:
                    res.close()  # drop the rest; the connection goes with it
                    break
        samples.append((time.perf_counter() - t0, total))
    finally:
        c.close()
    return samples


def measure_upload(server, seconds=PHASE_SECONDS, on_progress=None, cancelled=lambda: False):
    """Back-to-back 4 MB POSTs on one connection until the deadline."""
    c = _Conn(server['server'], timeout=30)
    samples = [(0.0, 0)]
    total = 0
    t0 = time.perf_counter()
    try:
        while time.perf_counter() - t0 < seconds:
            if cancelled():
                raise Cancelled()
            res = c.request(_nocache(_url(server, 'ulURL')), method='POST', body=_NOISE,
                            headers={'Content-Type': 'application/octet-stream'})
            res.read()
            if res.status >= 400:
                raise RuntimeError(f'upload refused ({res.status})')
            total += UPLOAD_CHUNK
            samples.append((time.perf_counter() - t0, total))
            if on_progress:
                on_progress(samples)
    finally:
        c.close()
    return samples


# --- the run ------------------------------------------------------------------

class InternetSpeedTest:
    """One run at a time, on its own thread; `status()` is what the page polls."""

    def __init__(self):
        self._lock = threading.Lock()
        self._thread = None
        self._cancel = False
        self._state = {'phase': 'idle', 'live_mbps': 0.0, 'progress': 0.0,
                       'result': None, 'error': None, 'meta': None}

    def status(self):
        with self._lock:
            return dict(self._state)

    @property
    def running(self):
        return self._thread is not None and self._thread.is_alive()

    def start(self, on_done=None):
        with self._lock:
            if self.running:
                return False
            self._cancel = False
            self._state.update(phase='servers', live_mbps=0.0, progress=0.0,
                               result=None, error=None, meta=None)
            self._thread = threading.Thread(target=self._run, args=(on_done,),
                                            name='internet-speedtest', daemon=True)
            self._thread.start()
            return True

    def cancel(self):
        self._cancel = True

    def _set(self, **kw):
        with self._lock:
            self._state.update(kw)

    def _progress(self, samples):
        self._set(live_mbps=recent_mbps(samples), progress=min(1.0, samples[-1][0] / PHASE_SECONDS))

    def _run(self, on_done):
        cancelled = lambda: self._cancel  # noqa: E731
        try:
            server = pick_server(fetch_servers(), cancelled=cancelled)
            meta = {'server': server['name'], 'server_url': server['server'],
                    'ip': None, 'isp': None, 'location': None}
            try:
                meta = fetch_meta(server)
            except (OSError, ValueError, http.client.HTTPException) as e:
                logger.debug('speedtest meta failed: %s', e)
            self._set(meta=meta, phase='ping')
            ping = ping_stats(measure_ping(server, cancelled=cancelled))

            self._set(phase='download', progress=0.0, live_mbps=0.0)
            down = measure_download(server, on_progress=self._progress, cancelled=cancelled)

            self._set(phase='upload', progress=0.0, live_mbps=0.0)
            up = measure_upload(server, on_progress=self._progress, cancelled=cancelled)

            result = {
                'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                'ping': ping,
                'download_mbps': throughput_mbps(down), 'download_bytes': down[-1][1],
                'upload_mbps': throughput_mbps(up), 'upload_bytes': up[-1][1],
                'meta': meta,
            }
            self._set(phase='done', result=result, live_mbps=0.0, progress=1.0)
            if on_done:
                on_done(result)
        except Cancelled:
            self._set(phase='idle', live_mbps=0.0, progress=0.0)
        except (OSError, http.client.HTTPException, RuntimeError, ValueError) as e:
            logger.warning('internet speed test failed: %s', e)
            self._set(phase='error', error=str(e) or e.__class__.__name__, live_mbps=0.0)


def record_history(db, result):
    """Write a finished run to the `speed_tests` table - the box's uplink is
    the same whoever is looking, so its history is shared."""
    meta = result.get('meta') or {}
    return db.add_speed_test(
        'internet', ping=result['ping'],
        download_mbps=result['download_mbps'], upload_mbps=result['upload_mbps'],
        download_bytes=result['download_bytes'], upload_bytes=result['upload_bytes'],
        client=meta.get('isp'), ip=meta.get('ip'),
        meta={k: meta.get(k) for k in ('server', 'server_url', 'location')} if meta else None,
    )


def read_history(db, limit=HISTORY_SIZE):
    return db.get_speed_tests('internet', limit=limit)


_test = InternetSpeedTest()


def get_test():
    return _test

"""qBittorrent WebUI API v2 client helpers (stdlib only).

Mirrors the stateless style of the Transmission RPC helpers: every call logs in
fresh (the SID cookie is cheap and avoids tracking session expiry). qBittorrent
rejects requests without a matching Referer header, so we always send one."""
import json
import base64
import urllib.parse
import urllib.request
import urllib.error
import http.cookiejar


# qBittorrent reports this eta when it cannot estimate one ("∞").
_QBIT_INFINITY_ETA = 8640000

# qBittorrent torrent state -> our shared status labels (same vocabulary the
# Transmission helper uses, so the frontend panel treats both identically).
_STATE_LABELS = {
    "downloading": "downloading", "metaDL": "downloading",
    "forcedDL": "downloading", "stalledDL": "downloading",
    "pausedDL": "stopped", "stoppedDL": "stopped",
    "pausedUP": "stopped", "stoppedUP": "stopped",
    "uploading": "seeding", "forcedUP": "seeding", "stalledUP": "seeding",
    "queuedDL": "download-wait", "queuedUP": "seed-wait",
    "checkingDL": "checking", "checkingUP": "checking",
    "checkingResumeData": "checking", "allocating": "checking", "moving": "checking",
    "error": "unknown", "missingFiles": "unknown", "unknown": "unknown",
}


def magnet_btih(magnet: str):
    """Extract the lowercase hex info-hash from a magnet's xt=urn:btih: param.
    Converts a 32-char base32 hash to 40-char hex. Returns None if absent."""
    m = (magnet or "")
    marker = "urn:btih:"
    idx = m.lower().find(marker)
    if idx == -1:
        return None
    raw = m[idx + len(marker):]
    # The hash ends at the next param/separator.
    for sep in ("&", "/", "?"):
        cut = raw.find(sep)
        if cut != -1:
            raw = raw[:cut]
    raw = raw.strip()
    if len(raw) == 40:
        return raw.lower()
    if len(raw) == 32:
        try:
            return base64.b32decode(raw.upper()).hex()
        except Exception:
            return None
    return raw.lower() or None


def _auth_header(cfg):
    """HTTP Basic auth header for a reverse proxy guarding the WebUI (e.g.
    seedhost). Empty when no credentials are configured."""
    if cfg.get("username") or cfg.get("password"):
        token = base64.b64encode(
            f"{cfg.get('username', '')}:{cfg.get('password', '')}".encode()).decode()
        return {"Authorization": f"Basic {token}"}
    return {}


def qbit_login(cfg, timeout: int = 20):
    """Authenticate and return (opener, base_url). Raises ValueError on failure.
    Sends HTTP Basic auth (for a reverse proxy) plus the WebUI form login; the
    opener carries the SID cookie for subsequent calls. If the form login does
    not return 'Ok.' (e.g. the WebUI bypasses auth for the proxied/localhost
    connection) we proceed on Basic auth, which is sent on every request."""
    base = (cfg.get("url") or "").strip().rstrip("/")
    if not base:
        raise ValueError("qBittorrent URL is not set")
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    data = urllib.parse.urlencode({
        "username": cfg.get("username", ""),
        "password": cfg.get("password", ""),
    }).encode()
    req = urllib.request.Request(
        f"{base}/api/v2/auth/login", data=data,
        headers={"Referer": base, "Content-Type": "application/x-www-form-urlencoded",
                 **_auth_header(cfg)},
        method="POST",
    )
    try:
        with opener.open(req, timeout=timeout) as resp:
            resp.read()  # body unused; success is the cookie + 200
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise ValueError("qBittorrent authentication failed — check username/password")
        raise ValueError(f"qBittorrent returned HTTP {e.code}")
    except urllib.error.URLError as e:
        raise ValueError(f"Cannot reach qBittorrent: {getattr(e, 'reason', e)}")
    return opener, base


def _qbit_request(cfg, path, data=None, expect_json=False, timeout: int = 20,
                  opener=None, base=None, allow_404=False):
    """Call a qBittorrent WebUI endpoint. POST when `data` is a dict (urlencoded),
    GET otherwise. Returns parsed JSON, raw text, or None on an allowed 404."""
    if opener is None or base is None:
        opener, base = qbit_login(cfg, timeout=timeout)
    url = f"{base}{path}"
    headers = {"Referer": base, **_auth_header(cfg)}
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    else:
        req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as e:
        if e.code == 404 and allow_404:
            return None
        if e.code in (401, 403):
            raise ValueError("qBittorrent authentication failed — check username/password")
        raise ValueError(f"qBittorrent error: HTTP {e.code}")
    except urllib.error.URLError as e:
        raise ValueError(f"Cannot reach qBittorrent: {getattr(e, 'reason', e)}")
    if expect_json:
        return json.loads(raw) if raw.strip() else None
    return raw


def qbit_test(cfg):
    """Return a human-readable connected message (raises ValueError on failure)."""
    opener, base = qbit_login(cfg)
    version = _qbit_request(cfg, "/api/v2/app/version", opener=opener, base=base) or "unknown version"
    return f"Connected to qBittorrent {version.strip()}"


def qbit_default_dir(cfg, opener=None, base=None):
    """The configured default save path (used to derive Telegram subfolders)."""
    prefs = _qbit_request(cfg, "/api/v2/app/preferences", expect_json=True,
                          opener=opener, base=base) or {}
    return (prefs.get("save_path") or "").rstrip("/")


def qbit_apply_session(cfg):
    """Set the session-wide temp (incomplete) directory from cfg.incomplete_dir.
    Enables/disables temp_path accordingly. Raises ValueError on RPC failure."""
    incomplete = (cfg.get("incomplete_dir") or "").strip()
    prefs = {"temp_path_enabled": bool(incomplete)}
    if incomplete:
        prefs["temp_path"] = incomplete
    _qbit_request(cfg, "/api/v2/app/setPreferences", data={"json": json.dumps(prefs)})


def _normalize(t):
    """Map a qBittorrent torrent-info dict to the shared status shape."""
    eta = t.get("eta")
    if not isinstance(eta, int) or eta < 0 or eta >= _QBIT_INFINITY_ETA:
        eta = None
    return {
        "id": 0,  # qBittorrent has no numeric id; the panel keys on hash.
        "name": t.get("name"),
        "hash": t.get("hash"),
        "status": _STATE_LABELS.get(t.get("state"), "unknown"),
        "percent_done": round((t.get("progress") or 0) * 100, 1),
        "rate_download": t.get("dlspeed") or 0,
        "rate_upload": t.get("upspeed") or 0,
        "total_size": t.get("size") or 0,
        "eta": eta,
        "download_dir": t.get("save_path"),
        "error": None,
        "added_date": t.get("added_on") or 0,
        "peers_connected": (t.get("num_seeds") or 0) + (t.get("num_leechs") or 0),
        "seeds_connected": t.get("num_seeds") or 0,
        "leeches_connected": t.get("num_leechs") or 0,
        "seeds_total": t.get("num_complete") if isinstance(t.get("num_complete"), int) and t.get("num_complete") >= 0 else None,
        "leeches_total": t.get("num_incomplete") if isinstance(t.get("num_incomplete"), int) and t.get("num_incomplete") >= 0 else None,
    }


def qbit_list(cfg):
    """Return all torrents in the shared normalized status shape."""
    opener, base = qbit_login(cfg)
    data = _qbit_request(cfg, "/api/v2/torrents/info", expect_json=True,
                         opener=opener, base=base) or []
    return [_normalize(t) for t in data]


def qbit_get(cfg, torrent_hash):
    """Fetch a single torrent (normalized) by hash, or None if unknown."""
    opener, base = qbit_login(cfg)
    data = _qbit_request(cfg, f"/api/v2/torrents/info?hashes={torrent_hash}",
                         expect_json=True, opener=opener, base=base) or []
    return _normalize(data[0]) if data else None


def qbit_add_magnet(cfg, magnet, download_dir=None, incomplete_dir=None, paused=False):
    """Add a magnet. Applies the temp dir first when given (session-wide). Returns
    {name, hash, duplicate}; name is None until metadata arrives."""
    info_hash = magnet_btih(magnet)
    temp = incomplete_dir if incomplete_dir is not None else cfg.get("incomplete_dir")
    if temp:
        qbit_apply_session({**cfg, "incomplete_dir": temp})
    opener, base = qbit_login(cfg)
    # Detect duplicate up front (qBittorrent's add returns Ok. regardless).
    duplicate = False
    if info_hash:
        existing = _qbit_request(cfg, f"/api/v2/torrents/info?hashes={info_hash}",
                                 expect_json=True, opener=opener, base=base) or []
        duplicate = bool(existing)
    data = {"urls": magnet, "paused": "true" if paused else "false"}
    if download_dir:
        data["savepath"] = download_dir
    _qbit_request(cfg, "/api/v2/torrents/add", data=data, opener=opener, base=base)
    return {"name": None, "hash": info_hash, "duplicate": duplicate}


def _qbit_start(cfg, joined, opener, base):
    """Start torrents, tolerating the v4 (resume) / v5 (start) endpoint rename."""
    res = _qbit_request(cfg, "/api/v2/torrents/start", data={"hashes": joined},
                        opener=opener, base=base, allow_404=True)
    if res is None:
        _qbit_request(cfg, "/api/v2/torrents/resume", data={"hashes": joined}, opener=opener, base=base)


def qbit_control(cfg, action, hashes, delete_data=False):
    """start | stop | remove | verify one or more torrents (by hash)."""
    joined = "|".join(hashes)
    opener, base = qbit_login(cfg)
    if action == "remove":
        _qbit_request(cfg, "/api/v2/torrents/delete",
                      data={"hashes": joined, "deleteFiles": "true" if delete_data else "false"},
                      opener=opener, base=base)
        return
    if action == "verify":
        # Recheck local data, then start — recovers a torrent with missing files.
        _qbit_request(cfg, "/api/v2/torrents/recheck", data={"hashes": joined}, opener=opener, base=base)
        _qbit_start(cfg, joined, opener, base)
        return
    if action == "start":
        _qbit_start(cfg, joined, opener, base)
        return
    # stop: qBittorrent 5.x renamed pause -> stop; try new path then legacy on 404.
    res = _qbit_request(cfg, "/api/v2/torrents/stop", data={"hashes": joined},
                        opener=opener, base=base, allow_404=True)
    if res is None:
        _qbit_request(cfg, "/api/v2/torrents/pause", data={"hashes": joined}, opener=opener, base=base)


def qbit_set_location(cfg, hashes, location):
    """Move torrents to a new save location (forces files out of the temp dir)."""
    _qbit_request(cfg, "/api/v2/torrents/setLocation",
                  data={"hashes": "|".join(hashes), "location": location})


def _bdecode(data, i):
    """Minimal bencode decoder -> (value, next_index)."""
    c = data[i:i + 1]
    if c == b"i":
        e = data.index(b"e", i)
        return int(data[i + 1:e]), e + 1
    if c == b"l":
        i += 1
        lst = []
        while data[i:i + 1] != b"e":
            v, i = _bdecode(data, i)
            lst.append(v)
        return lst, i + 1
    if c == b"d":
        i += 1
        d = {}
        while data[i:i + 1] != b"e":
            k, i = _bdecode(data, i)
            v, i = _bdecode(data, i)
            d[k] = v
        return d, i + 1
    colon = data.index(b":", i)
    length = int(data[i:colon])
    start = colon + 1
    return data[start:start + length], start + length


def torrent_file_info(data: bytes):
    """Return (btih_hex, name) for a .torrent file. The info-hash is the SHA-1 of
    the raw (exact-byte) `info` dictionary, so we capture its byte span rather than
    re-encoding."""
    import hashlib
    if data[0:1] != b"d":
        return None, None
    i = 1
    name = None
    info_hash = None
    while i < len(data) and data[i:i + 1] != b"e":
        key, i = _bdecode(data, i)
        start = i
        val, i = _bdecode(data, i)
        if key == b"info":
            info_hash = hashlib.sha1(data[start:i]).hexdigest()
            if isinstance(val, dict) and isinstance(val.get(b"name"), bytes):
                name = val[b"name"].decode("utf-8", "replace")
    return info_hash, name


def _qbit_post_multipart(cfg, path, fields, files, opener, base, timeout: int = 30):
    """POST multipart/form-data (for the .torrent file upload)."""
    boundary = "----DownLeeTorrentBoundary"
    parts = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, (filename, content, ctype) in files.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'.encode())
        parts.append(content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    headers = {"Referer": base,
               "Content-Type": f"multipart/form-data; boundary={boundary}",
               **_auth_header(cfg)}
    req = urllib.request.Request(f"{base}{path}", data=body, headers=headers, method="POST")
    try:
        with opener.open(req, timeout=timeout) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise ValueError("qBittorrent authentication failed — check username/password")
        raise ValueError(f"qBittorrent error: HTTP {e.code}")
    except urllib.error.URLError as e:
        raise ValueError(f"Cannot reach qBittorrent: {getattr(e, 'reason', e)}")


def qbit_add_file(cfg, torrent_bytes, download_dir=None, incomplete_dir=None, paused=False):
    """Add a .torrent file. Applies the temp dir first when given. Returns
    {name, hash, duplicate} (name/hash parsed from the file's metadata)."""
    info_hash, name = torrent_file_info(torrent_bytes)
    temp = incomplete_dir if incomplete_dir is not None else cfg.get("incomplete_dir")
    if temp:
        qbit_apply_session({**cfg, "incomplete_dir": temp})
    opener, base = qbit_login(cfg)
    duplicate = False
    if info_hash:
        existing = _qbit_request(cfg, f"/api/v2/torrents/info?hashes={info_hash}",
                                 expect_json=True, opener=opener, base=base) or []
        duplicate = bool(existing)
    fields = {"paused": "true" if paused else "false"}
    if download_dir:
        fields["savepath"] = download_dir
    _qbit_post_multipart(cfg, "/api/v2/torrents/add", fields,
                         {"torrents": ("upload.torrent", torrent_bytes, "application/x-bittorrent")},
                         opener, base)
    return {"name": name, "hash": info_hash, "duplicate": duplicate}

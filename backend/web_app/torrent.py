"""Torrent-client helpers.

Two clients are supported side-by-side: Transmission (JSON-RPC) and qBittorrent
(WebUI API v2, in qbittorrent.py). Config lives in the `torrent_config` setting
as a nested document keyed by client, with a `telegram_default` pointer for
unattended Telegram-channel magnets. The `torrent_*` dispatchers take an explicit
client and route to the right backend; everything keys torrents by hash so one
code path drives both."""
import json
import posixpath
from backend.database import get_db

CLIENTS = ("transmission", "qbittorrent")

# Telegram-sourced magnets are routed to dedicated subfolders (in-progress data
# temps through 'progress').
TELEGRAM_TORRENT_SUBDIR = "telegram/downloads"
TELEGRAM_PROGRESS_SUBDIR = "telegram/progress"

# Transmission status codes -> shared status labels.
_TRANSMISSION_STATUS = {
    0: "stopped", 1: "check-wait", 2: "checking",
    3: "download-wait", 4: "downloading", 5: "seed-wait", 6: "seeding",
}


def normalize_transmission_url(url: str) -> str:
    """Normalize a Transmission web/RPC URL to the RPC endpoint.

    Accepts the web UI URL (.../transmission/web/), a bare host:port, or the
    RPC URL itself, and returns the .../transmission/rpc endpoint."""
    url = (url or "").strip().rstrip("/")
    if url.endswith("/web"):
        return url[:-4] + "/rpc"
    if url.endswith("/rpc"):
        return url
    return url + ("/rpc" if "/transmission" in url else "/transmission/rpc")


# ---------------------------------------------------------------------------
# Config storage (nested, per-client)
# ---------------------------------------------------------------------------

def read_torrent_settings() -> dict:
    """Return the raw nested torrent config (sub-configs keep `password_enc`).

    Migrates the legacy flat Transmission shape (top-level `url`) into
    {transmission: <old>, telegram_default: 'transmission'}."""
    raw = get_db().get_setting("torrent_config")
    if not raw:
        return {"transmission": {}, "qbittorrent": {}, "telegram_default": None}
    try:
        cfg = json.loads(raw)
    except Exception:
        return {"transmission": {}, "qbittorrent": {}, "telegram_default": None}
    if "url" in cfg and "transmission" not in cfg and "qbittorrent" not in cfg:
        # Legacy flat Transmission config.
        return {
            "transmission": {
                "url": cfg.get("url", ""),
                "username": cfg.get("username", ""),
                "password_enc": cfg.get("password_enc", ""),
                "download_dir": cfg.get("download_dir", ""),
                "incomplete_dir": cfg.get("incomplete_dir", ""),
            },
            "qbittorrent": {},
            "telegram_default": "transmission" if cfg.get("url") else None,
        }
    cfg.setdefault("transmission", {})
    cfg.setdefault("qbittorrent", {})
    cfg.setdefault("telegram_default", None)
    return cfg


def write_torrent_settings(settings: dict):
    get_db().set_setting("torrent_config", json.dumps(settings))


def get_telegram_default():
    """The client string ('transmission'|'qbittorrent') used for Telegram-channel
    magnets, or None if unset/not configured."""
    settings = read_torrent_settings()
    client = settings.get("telegram_default")
    if client in CLIENTS and (settings.get(client) or {}).get("url"):
        return client
    return None


def load_torrent_config(client):
    """Load a client's config with the password decrypted, plus a `client` key.
    Returns None when that client is not configured."""
    from backend.utils import decrypt_secret
    if client not in CLIENTS:
        return None
    sub = read_torrent_settings().get(client) or {}
    if not sub.get("url"):
        return None
    return {
        "client": client,
        "url": sub["url"],
        "username": sub.get("username", ""),
        "password": decrypt_secret(sub.get("password_enc", "")),
        "download_dir": sub.get("download_dir", ""),
        "incomplete_dir": sub.get("incomplete_dir", ""),
    }


# ---------------------------------------------------------------------------
# Transmission backend
# ---------------------------------------------------------------------------

def transmission_rpc(method: str, arguments: dict = None, config: dict = None, timeout: int = 20):
    """Call the Transmission RPC API. Handles the 409 session-id handshake.
    Returns the response 'arguments' dict; raises ValueError with a readable
    message."""
    import base64
    import urllib.request
    import urllib.error

    cfg = config or load_torrent_config("transmission")
    if not cfg:
        raise ValueError("Torrent client is not configured")
    payload = json.dumps({"method": method, "arguments": arguments or {}}).encode()
    headers = {"Content-Type": "application/json"}
    if cfg.get("username") or cfg.get("password"):
        token = base64.b64encode(f"{cfg.get('username', '')}:{cfg.get('password', '')}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"

    session_id = None
    for attempt in range(2):
        req_headers = dict(headers)
        if session_id:
            req_headers["X-Transmission-Session-Id"] = session_id
        req = urllib.request.Request(cfg["url"], data=payload, headers=req_headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 409 and attempt == 0:
                session_id = e.headers.get("X-Transmission-Session-Id")
                continue
            if e.code == 401:
                raise ValueError("Transmission authentication failed — check username/password")
            raise ValueError(f"Transmission returned HTTP {e.code}")
        except urllib.error.URLError as e:
            raise ValueError(f"Cannot reach Transmission: {getattr(e, 'reason', e)}")
        if body.get("result") != "success":
            raise ValueError(f"Transmission error: {body.get('result')}")
        return body.get("arguments", {})
    raise ValueError("Transmission session negotiation failed")


def transmission_apply_session(cfg):
    """Push the incomplete (temp) download directory to Transmission. While a
    torrent downloads its data lives in `incomplete-dir`, then Transmission moves
    it to the torrent's `download-dir` on completion."""
    incomplete = (cfg.get("incomplete_dir") or "").strip()
    args = {"incomplete-dir-enabled": bool(incomplete)}
    if incomplete:
        args["incomplete-dir"] = incomplete
    transmission_rpc("session-set", args, config=cfg)


def transmission_test(cfg):
    session = transmission_rpc("session-get", config=cfg)
    return f"Connected to Transmission {session.get('version', 'unknown version')}"


def transmission_add_magnet(magnet, download_dir=None, incomplete_dir=None, paused=False, config=None):
    """Add a magnet to Transmission. Applies the temp dir right before the add
    (Transmission's incomplete-dir is session-wide but only affects active
    torrents). Returns the raw torrent-add result."""
    cfg = config or load_torrent_config("transmission")
    if not cfg:
        raise ValueError("Torrent client is not configured")
    temp = incomplete_dir if incomplete_dir is not None else cfg.get("incomplete_dir")
    if temp:
        transmission_apply_session({**cfg, "incomplete_dir": temp})
    args = {"filename": magnet}
    if download_dir:
        args["download-dir"] = download_dir
    if paused:
        args["paused"] = True
    return transmission_rpc("torrent-add", args, config=cfg)


def _transmission_normalize(t):
    """Map a Transmission torrent dict to the shared status shape."""
    def tracker_max(stats, key):
        vals = [s.get(key) for s in (stats or []) if isinstance(s.get(key), int) and s.get(key) >= 0]
        return max(vals) if vals else None

    eta = t.get("eta")
    stats = t.get("trackerStats") or []
    return {
        "id": t.get("id"),
        "name": t.get("name"),
        "hash": t.get("hashString"),
        "status": _TRANSMISSION_STATUS.get(t.get("status"), "unknown"),
        "percent_done": round((t.get("percentDone") or 0) * 100, 1),
        "rate_download": t.get("rateDownload") or 0,
        "rate_upload": t.get("rateUpload") or 0,
        "total_size": t.get("totalSize") or 0,
        "eta": eta if isinstance(eta, int) and eta >= 0 else None,
        "download_dir": t.get("downloadDir"),
        "error": t.get("errorString") or None,
        "added_date": t.get("addedDate") or 0,
        "peers_connected": t.get("peersConnected") or 0,
        "seeds_connected": t.get("peersSendingToUs") or 0,
        "leeches_connected": t.get("peersGettingFromUs") or 0,
        "seeds_total": tracker_max(stats, "seederCount"),
        "leeches_total": tracker_max(stats, "leecherCount"),
    }


def transmission_list(cfg):
    fields = [
        "id", "name", "hashString", "status", "percentDone",
        "rateDownload", "rateUpload", "totalSize", "eta",
        "downloadDir", "errorString", "addedDate",
        "peersConnected", "peersSendingToUs", "peersGettingFromUs",
        "trackerStats",
    ]
    result = transmission_rpc("torrent-get", {"fields": fields}, config=cfg)
    return [_transmission_normalize(t) for t in result.get("torrents", [])]


def transmission_get(cfg, torrent_hash):
    res = transmission_rpc("torrent-get", {
        "ids": [torrent_hash],
        "fields": ["id", "hashString", "name", "percentDone", "rateDownload",
                   "eta", "status", "totalSize", "errorString", "downloadDir"],
    }, config=cfg)
    torrents = res.get("torrents", [])
    return _transmission_normalize(torrents[0]) if torrents else None


def transmission_control(cfg, action, hashes, delete_data=False):
    method = {"start": "torrent-start", "stop": "torrent-stop", "remove": "torrent-remove"}[action]
    args = {"ids": hashes}  # Transmission accepts hash strings as ids
    if action == "remove" and delete_data:
        args["delete-local-data"] = True
    transmission_rpc(method, args, config=cfg)


def transmission_set_location(cfg, hashes, location):
    transmission_rpc("torrent-set-location",
                     {"ids": hashes, "location": location, "move": True}, config=cfg)


# Back-compat: a single-hash fetch returning the RAW Transmission dict.
def transmission_get_torrent(torrent_hash, config=None):
    res = transmission_rpc("torrent-get", {
        "ids": [torrent_hash],
        "fields": ["hashString", "name", "percentDone", "rateDownload",
                   "eta", "status", "totalSize", "errorString", "downloadDir"],
    }, config=config)
    torrents = res.get("torrents", [])
    return torrents[0] if torrents else None


# ---------------------------------------------------------------------------
# Client-agnostic dispatchers
# ---------------------------------------------------------------------------

def _resolve(client, config):
    cfg = config or load_torrent_config(client)
    if not cfg:
        raise ValueError(f"{client or 'Torrent'} client is not configured")
    return cfg


def apply_torrent_session(cfg):
    """Push the temp/incomplete dir to whichever client `cfg` describes."""
    if cfg.get("client") == "qbittorrent":
        from backend.web_app.qbittorrent import qbit_apply_session
        qbit_apply_session(cfg)
    else:
        transmission_apply_session(cfg)


def torrent_test(client, config=None):
    cfg = _resolve(client, config)
    if client == "qbittorrent":
        from backend.web_app.qbittorrent import qbit_test
        return qbit_test(cfg)
    return transmission_test(cfg)


def torrent_list(client, config=None):
    cfg = _resolve(client, config)
    if client == "qbittorrent":
        from backend.web_app.qbittorrent import qbit_list
        return qbit_list(cfg)
    return transmission_list(cfg)


def torrent_get(client, torrent_hash, config=None):
    cfg = _resolve(client, config)
    if client == "qbittorrent":
        from backend.web_app.qbittorrent import qbit_get
        return qbit_get(cfg, torrent_hash)
    return transmission_get(cfg, torrent_hash)


def torrent_control(client, action, hashes, delete_data=False, config=None):
    cfg = _resolve(client, config)
    if client == "qbittorrent":
        from backend.web_app.qbittorrent import qbit_control
        return qbit_control(cfg, action, hashes, delete_data)
    return transmission_control(cfg, action, hashes, delete_data)


def torrent_set_location(client, hashes, location, config=None):
    cfg = _resolve(client, config)
    if client == "qbittorrent":
        from backend.web_app.qbittorrent import qbit_set_location
        return qbit_set_location(cfg, hashes, location)
    return transmission_set_location(cfg, hashes, location)


def torrent_add_magnet(client, magnet, download_dir=None, incomplete_dir=None, paused=False, config=None):
    """Add a magnet to `client`. When `download_dir` is None, falls back to the
    client's configured default download folder. Returns the normalized
    {name, hash, duplicate}."""
    cfg = _resolve(client, config)
    target_dir = download_dir or cfg.get("download_dir") or None
    if client == "qbittorrent":
        from backend.web_app.qbittorrent import qbit_add_magnet
        return qbit_add_magnet(cfg, magnet, download_dir=target_dir,
                               incomplete_dir=incomplete_dir, paused=paused)
    res = transmission_add_magnet(magnet, download_dir=target_dir,
                                  incomplete_dir=incomplete_dir, paused=paused, config=cfg)
    t = res.get("torrent-added") or res.get("torrent-duplicate") or {}
    return {
        "name": t.get("name"),
        "hash": t.get("hashString"),
        "duplicate": "torrent-duplicate" in res,
    }


def torrent_telegram_dirs(client, config=None):
    """Resolve (download_dir, progress_dir) for Telegram-sourced magnets for the
    given client. Uses the client's configured default download folder when set;
    otherwise falls back to a `telegram/...` pair beside the client's own default
    download dir (the parent of it)."""
    cfg = _resolve(client, config)
    base = (cfg.get("download_dir") or "").rstrip("/")
    if base:
        prog_base = (cfg.get("incomplete_dir") or base).rstrip("/")
        return (posixpath.join(base, TELEGRAM_TORRENT_SUBDIR),
                posixpath.join(prog_base, TELEGRAM_PROGRESS_SUBDIR))
    # No configured default: derive from the client's own default download dir.
    if client == "qbittorrent":
        from backend.web_app.qbittorrent import qbit_default_dir
        default_dir = qbit_default_dir(cfg)
    else:
        default_dir = (transmission_rpc("session-get", config=cfg).get("download-dir") or "").rstrip("/")
    parent = posixpath.dirname(default_dir)
    if parent and parent != "/":
        return (posixpath.join(parent, TELEGRAM_TORRENT_SUBDIR),
                posixpath.join(parent, TELEGRAM_PROGRESS_SUBDIR))
    return TELEGRAM_TORRENT_SUBDIR, TELEGRAM_PROGRESS_SUBDIR


# Back-compat wrapper.
def transmission_telegram_dirs(config=None):
    return torrent_telegram_dirs("transmission", config=config)

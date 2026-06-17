"""Transmission torrent-client RPC helpers."""
import json
from backend.database import get_db


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



def load_torrent_config():
    """Load the saved torrent client (Transmission) config with the password
    decrypted. Returns {url, username, password} or None if not configured."""
    from backend.utils import decrypt_secret
    raw = get_db().get_setting("torrent_config")
    if not raw:
        return None
    try:
        cfg = json.loads(raw)
    except Exception:
        return None
    if not cfg.get("url"):
        return None
    return {
        "url": cfg["url"],
        "username": cfg.get("username", ""),
        "password": decrypt_secret(cfg.get("password_enc", "")),
        "incomplete_dir": cfg.get("incomplete_dir", ""),
    }



def apply_torrent_session(cfg):
    """Push session-wide settings to Transmission. Currently configures the
    incomplete (temp) download directory: while a torrent downloads, its data
    lives in `incomplete-dir`, then Transmission moves it to the torrent's
    `download-dir` on completion. Raises ValueError if the RPC fails."""
    incomplete = (cfg.get("incomplete_dir") or "").strip()
    args = {"incomplete-dir-enabled": bool(incomplete)}
    if incomplete:
        args["incomplete-dir"] = incomplete
    transmission_rpc("session-set", args, config=cfg)



# Telegram-sourced magnets are routed to dedicated subfolders under
# Transmission's base download dir (in-progress data temps through 'progress').
TELEGRAM_TORRENT_SUBDIR = "telegram/downloads"
TELEGRAM_PROGRESS_SUBDIR = "telegram/progress"



def transmission_add_magnet(magnet, download_dir=None, incomplete_dir=None, paused=False, config=None):
    """Add a magnet to Transmission. When `incomplete_dir` is given it overrides
    the session temp dir for this add (Transmission's incomplete-dir is
    session-wide but only active torrents are affected, so applying it right
    before the add gives each new torrent its own temp dir). Falls back to the
    saved config's incomplete dir otherwise. Returns the torrent-add result."""
    cfg = config or load_torrent_config()
    if not cfg:
        raise ValueError("Torrent client is not configured")
    temp = incomplete_dir if incomplete_dir is not None else cfg.get("incomplete_dir")
    if temp:
        apply_torrent_session({**cfg, "incomplete_dir": temp})
    args = {"filename": magnet}
    if download_dir:
        args["download-dir"] = download_dir
    if paused:
        args["paused"] = True
    return transmission_rpc("torrent-add", args, config=cfg)



def transmission_telegram_dirs(config=None):
    """Resolve the absolute (download_dir, incomplete_dir) for Telegram-sourced
    magnets. The telegram folder sits at the ROOT (the parent of Transmission's
    default download dir), not nested inside it — i.e. for a default dir of
    `<root>/movies` the telegram dirs are `<root>/telegram/...`, not
    `<root>/movies/telegram/...`."""
    import posixpath
    cfg = config or load_torrent_config()
    if not cfg:
        raise ValueError("Torrent client is not configured")
    default_dir = (transmission_rpc("session-get", config=cfg).get("download-dir") or "").rstrip("/")
    base = posixpath.dirname(default_dir)  # parent of the default download dir
    if base and base != "/":
        return (posixpath.join(base, TELEGRAM_TORRENT_SUBDIR),
                posixpath.join(base, TELEGRAM_PROGRESS_SUBDIR))
    return TELEGRAM_TORRENT_SUBDIR, TELEGRAM_PROGRESS_SUBDIR



def transmission_rpc(method: str, arguments: dict = None, config: dict = None, timeout: int = 20):
    """Call the Transmission RPC API (saved config unless one is passed in).

    Handles the 409 X-Transmission-Session-Id handshake. Returns the response
    'arguments' dict on success; raises ValueError with a readable message."""
    import base64
    import urllib.request
    import urllib.error

    cfg = config or load_torrent_config()
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


def transmission_get_torrent(torrent_hash, config=None):
    """Fetch a single torrent's live fields by hash. Returns the raw torrent
    dict (percentDone, rateDownload, eta, status, totalSize, errorString, name)
    or None if Transmission no longer knows about it."""
    res = transmission_rpc("torrent-get", {
        "ids": [torrent_hash],
        "fields": ["hashString", "name", "percentDone", "rateDownload",
                   "eta", "status", "totalSize", "errorString", "downloadDir"],
    }, config=config)
    torrents = res.get("torrents", [])
    return torrents[0] if torrents else None


"""VPS SSH/SFTP connection helpers."""
import json
from backend.database import get_db


def load_vps_credentials():
    """Load saved VPS connection credentials (password decrypted).

    Returns a dict {host, port, username, password} or None if not configured.
    """
    from backend.utils import decrypt_secret
    raw = get_db().get_setting("vps_config")
    if not raw:
        return None
    try:
        cfg = json.loads(raw)
    except Exception:
        return None
    host = cfg.get("host")
    if not host:
        return None
    return {
        "host": host,
        "port": int(cfg.get("port") or 22),
        "username": cfg.get("username", ""),
        "password": decrypt_secret(cfg.get("password_enc", "")),
    }



def annotate_vps_folders(folders):
    """Tag each watched folder with `active` = belongs to the currently saved
    VPS connection. Folders from other connections stay listed but inactive.

    Legacy folders created before connection-binding (no host recorded) are
    adopted into the current connection so they keep working."""
    creds = load_vps_credentials()
    cur_host = creds["host"] if creds else None
    cur_user = creds["username"] if creds else None
    cur_port = creds["port"] if creds else None
    db = get_db()
    for f in folders:
        # Adopt legacy host-less folders into the current connection
        if creds and not f.get("host"):
            db.set_vps_watch_folder_connection(f["id"], cur_host, cur_port, cur_user)
            f["host"], f["port"], f["username"] = cur_host, cur_port, cur_user
        f["active"] = bool(
            creds
            and f.get("host") == cur_host
            and f.get("username") == cur_user
            and (f.get("port") or 22) == cur_port
        )
    return folders



def open_vps_sftp(timeout=10):
    """Open an SSH+SFTP session using saved credentials.

    Returns (client, sftp). Raises ValueError if not configured, or
    paramiko/socket errors on connection failure. Caller must close client.
    """
    import paramiko
    creds = load_vps_credentials()
    if not creds:
        raise ValueError("VPS connection is not configured")
    if not creds["password"]:
        raise ValueError("No saved password for the VPS connection")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=creds["host"], port=creds["port"], username=creds["username"],
        password=creds["password"], timeout=timeout, allow_agent=False, look_for_keys=False,
    )
    # Keepalives so a transfer notices a dead link. Without them paramiko sits
    # in a blocking read on a socket the other end has long forgotten, and a
    # download just stops moving instead of failing (and being resumable).
    transport = client.get_transport()
    if transport:
        transport.set_keepalive(30)
    return client, client.open_sftp()



def _parse_quota(text: str):
    """Parse `quota -w` output into (used_bytes, limit_bytes, filesystem).

    The interesting line is the one starting with a device path:

        Filesystem  blocks   quota   limit   grace   files  quota  limit  grace
          /dev/sdu1 384836764  1953125000      0            302      0      0

    Numbers are 1K blocks. `quota` is the soft limit and `limit` the hard one;
    a seedbox usually sets only the soft one, and either may be 0 for "none",
    so the cap is whichever is set (the smaller when both are). A `*` suffix on
    the used figure means over quota - stripped rather than choked on.
    """
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) < 4 or not parts[0].startswith("/"):
            continue
        try:
            used = int(parts[1].rstrip("*"))
            soft = int(parts[2].rstrip("*"))
            hard = int(parts[3].rstrip("*"))
        except ValueError:
            continue
        caps = [c for c in (soft, hard) if c > 0]
        limit = min(caps) if caps else 0
        return used * 1024, limit * 1024, parts[0]
    return None


def _parse_df(text: str):
    """Fallback for a box without quotas: `df -Pk $HOME`'s data line."""
    lines = [l for l in (text or "").splitlines() if l.strip()]
    for line in lines[1:]:
        parts = line.split()
        if len(parts) < 4:
            continue
        try:
            used, avail = int(parts[2]), int(parts[3])
        except ValueError:
            continue
        # A shared seedbox volume's total is the whole array, which says nothing
        # about the account - but used+avail is at least an honest ceiling.
        return used * 1024, (used + avail) * 1024, parts[0]
    return None


def vps_disk_usage(timeout=15):
    """Account disk usage on the VPS: {used, limit, percent, filesystem, source}.

    Prefers the per-user quota, which is what a seedbox actually bills against;
    `df` only sees the shared volume, so it is a clearly-labelled fallback.
    """
    client, sftp = open_vps_sftp(timeout=timeout)
    try:
        try:
            sftp.close()
        except Exception:
            pass

        def run(cmd):
            _, out, err = client.exec_command(cmd, timeout=timeout)
            return out.read().decode(errors="replace") + err.read().decode(errors="replace")

        parsed, source = _parse_quota(run("quota -w 2>/dev/null")), "quota"
        if not parsed or not parsed[1]:
            df = _parse_df(run('df -Pk "$HOME" 2>/dev/null'))
            if df:
                parsed, source = df, "df"
        if not parsed:
            return None
        used, limit, fs = parsed
        return {
            "used": used,
            "limit": limit,
            "percent": round(used / limit * 100, 1) if limit else None,
            "filesystem": fs,
            "source": source,
        }
    finally:
        client.close()

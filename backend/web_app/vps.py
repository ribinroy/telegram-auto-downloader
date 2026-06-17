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
    return client, client.open_sftp()


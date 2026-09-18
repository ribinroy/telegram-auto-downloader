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
    """`df -Pk <path>`'s data line -> the volume's figures.

    {filesystem, mount, total, used, avail, percent}. On a seedbox this is the
    shared array every tenant's home sits on, not the account - which is why it
    is reported as the server's storage and never as yours.
    """
    for line in [l for l in (text or "").splitlines() if l.strip()][1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        try:
            total, used, avail = int(parts[1]), int(parts[2]), int(parts[3])
        except ValueError:
            continue
        return {
            "filesystem": parts[0],
            "mount": parts[5],
            "total": total * 1024,
            "used": used * 1024,
            "avail": avail * 1024,
            "percent": round(used / total * 100, 1) if total else None,
        }
    return None


def _parse_loadavg(text: str, cores_text: str):
    """/proc/loadavg + nproc -> {load1, load5, load15, cores, percent}.

    `percent` is load1 against the core count: a 96-core box at load 16 is
    busy-ish, not on fire, and the raw number alone reads alarming.
    """
    parts = (text or "").split()
    if len(parts) < 3:
        return None
    try:
        load1, load5, load15 = (float(x) for x in parts[:3])
    except ValueError:
        return None
    try:
        cores = int((cores_text or "").strip().splitlines()[0])
    except (ValueError, IndexError):
        cores = 0
    return {
        "load1": load1, "load5": load5, "load15": load15,
        "cores": cores,
        "percent": round(load1 / cores * 100, 1) if cores else None,
    }


# Virtual/container interfaces carry no real uplink traffic and would otherwise
# win on a box with a busy docker bridge.
_SKIP_IFACES = ("lo", "veth", "docker", "br-", "virbr", "tun", "tap")


def _parse_netdev(text: str):
    """/proc/net/dev -> the busiest physical interface's cumulative counters.

    {iface, rx_bytes, tx_bytes}. These are the *machine's* totals since boot -
    every tenant combined - because the box exposes no per-account accounting.
    """
    best = None
    for line in (text or "").splitlines():
        if ":" not in line:
            continue
        name, _, rest = line.partition(":")
        name = name.strip()
        if not name or name.startswith(_SKIP_IFACES):
            continue
        fields = rest.split()
        if len(fields) < 9:
            continue
        try:
            rx, tx = int(fields[0]), int(fields[8])
        except ValueError:
            continue
        if rx + tx == 0:
            continue
        if not best or rx + tx > best["rx_bytes"] + best["tx_bytes"]:
            best = {"iface": name, "rx_bytes": rx, "tx_bytes": tx}
    return best


# One exec, split on markers: four round-trips to a box across the internet for
# what is one panel would be silly, and SSH login is the expensive part anyway.
_SNAPSHOT_CMD = (
    'quota -w 2>/dev/null; echo "@@DF@@"; df -Pk "$HOME" 2>/dev/null; '
    'echo "@@CPU@@"; nproc 2>/dev/null; cat /proc/loadavg 2>/dev/null; '
    'echo "@@NET@@"; cat /proc/net/dev 2>/dev/null'
)


def vps_usage_snapshot(timeout=15):
    """Everything the usage panel reads off the VPS, in one SSH session.

    Returns {disk, volume, load, net} where `disk` is the per-account quota
    (what a seedbox bills against) and the rest describe the shared machine.
    Any individual piece is None when the box does not expose it.
    """
    client, sftp = open_vps_sftp(timeout=timeout)
    try:
        try:
            sftp.close()
        except Exception:
            pass
        _, out, err = client.exec_command(_SNAPSHOT_CMD, timeout=timeout)
        text = out.read().decode(errors="replace") + err.read().decode(errors="replace")
    finally:
        client.close()

    quota_txt, _, rest = text.partition("@@DF@@")
    df_txt, _, rest = rest.partition("@@CPU@@")
    cpu_txt, _, net_txt = rest.partition("@@NET@@")

    volume = _parse_df(df_txt)
    quota = _parse_quota(quota_txt)
    disk = None
    if quota and quota[1]:
        used, limit, fs = quota
        disk = {"used": used, "limit": limit, "filesystem": fs,
                "percent": round(used / limit * 100, 1), "source": "quota"}
    elif volume:
        # No quota set: the account has no cap of its own, so the honest
        # ceiling is what is left on the shared volume.
        disk = {"used": volume["used"], "limit": volume["used"] + volume["avail"],
                "filesystem": volume["filesystem"], "percent": volume["percent"],
                "source": "df"}

    cpu_lines = cpu_txt.strip().splitlines()
    load = _parse_loadavg(cpu_lines[1] if len(cpu_lines) > 1 else "",
                          cpu_lines[0] if cpu_lines else "")
    return {"disk": disk, "volume": volume, "load": load, "net": _parse_netdev(net_txt)}


def vps_disk_usage(timeout=15):
    """Back-compat wrapper: just the account's disk figures."""
    return vps_usage_snapshot(timeout=timeout)["disk"]

"""Network watchdog: pick downloads back up when the connection comes back.

A home server's uplink drops for ten seconds and nothing recovers on its own.
Each handler fails differently: Telethon burns its retry budget and the record
goes `failed`, a yt-dlp subprocess exits (and falls through to the browser
fallback, which fails too), an SFTP transfer dies on a socket error. The worst
case is the silent one - the TCP connection is gone but nothing raises, so the
transfer sits at 47% forever. That is what "the downloads look paused" means.

This thread watches for both, and only ever acts on something it has observed:

  * **Reconnects.** It TCP-probes NET_PROBE_HOSTS every NET_PROBE_INTERVAL
    seconds. When the link goes down it snapshots every running download's
    byte count; when the link comes back it waits RECONNECT_GRACE for the
    handlers to sort themselves out (Telethon often does) and only then
    resumes the ones that failed or never moved again.
  * **Stalls.** A download still marked `downloading` whose byte count has not
    changed for NET_STALL_SECONDS is force-restarted. A blip shorter than the
    probe interval never registers as an outage but still kills the socket,
    and that is the common case.
  * **Restarts.** A service (or machine) restart leaves every in-flight
    download marked `downloading` with nothing behind it - the process that
    was transferring is gone. On its first online tick the watchdog picks
    those orphans up from the bytes already on disk.

Recovery goes through backend.resume.resume_download() - the same call the
retry button makes - so an automatic recovery can't drift from a manual one.
A download the user stopped or paused is never touched: `stopped` and `paused`
are decisions, not failures.
"""
import logging
import socket
import threading
import time

from backend.config import (
    NET_PROBE_HOSTS, NET_PROBE_INTERVAL, NET_STALL_SECONDS,
)
from backend.database import get_db
from backend.resume import resume_download

logger = logging.getLogger(__name__)

# Seconds to wait after the link returns before judging anything: Telethon
# reconnects by itself and a transfer that resumes on its own needs no help.
RECONNECT_GRACE = 30
# A yt-dlp download this far along is probably muxing/remuxing, which moves no
# bytes for minutes on a big file. Restarting it there would throw that away.
NEAR_DONE_PROGRESS = 99
# Telethon may still be connecting (or waiting on a login) when the first tick
# comes round, and a Telegram resume needs the client to re-fetch the message.
# So a leftover download gets retried across this many ticks before we give up
# and mark it failed - better an honest failure with a retry button than a row
# that claims to be downloading forever.
STARTUP_RESUME_ATTEMPTS = 10


def probe_connectivity(hosts=None, timeout=4.0) -> bool:
    """True if any probe host accepts a TCP connection."""
    for host, port in (hosts or NET_PROBE_HOSTS):
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            continue
    return False


class NetworkWatchdog(threading.Thread):
    """Daemon thread that resumes downloads the network interrupted."""

    def __init__(self, interval=None, stall_seconds=None, probe=None):
        super().__init__(daemon=True, name='net-watchdog')
        self.interval = interval or NET_PROBE_INTERVAL
        self.stall_seconds = NET_STALL_SECONDS if stall_seconds is None else stall_seconds
        self._probe = probe or probe_connectivity
        self._stop = threading.Event()
        # Assume a working link at startup: the first probe corrects it, and
        # starting "offline" would treat boot as an outage.
        self.online = True
        self._interrupted = {}   # message_id -> downloaded_bytes when the link dropped
        self._recheck_at = None  # when to act on a restored link
        self._marks = {}         # message_id -> (downloaded_bytes, seen at this count since)
        self._orphans = None     # left over from the previous run; None until the first tick
        self._orphan_attempts = 0

    def stop(self):
        self._stop.set()

    def run(self):
        # A moment's grace so the first tick doesn't race database init.
        time.sleep(10)
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001 - the thread must survive
                logger.warning("network watchdog tick failed: %s", e)
            self._stop.wait(self.interval)

    # --- The tick ---------------------------------------------------------
    def tick(self, now=None):
        now = now or time.time()
        online = self._probe()

        if self.online and not online:
            self.online = False
            self._recheck_at = None
            self._snapshot_active()
            logger.warning("network down - %d download(s) in flight", len(self._interrupted))
            print(f"🔌 Network down ({len(self._interrupted)} download(s) in flight)")
        elif not self.online and online:
            self.online = True
            self._recheck_at = now + RECONNECT_GRACE
            logger.info("network back - checking downloads in %ds", RECONNECT_GRACE)
            print("🔌 Network back - checking interrupted downloads")

        if not online:
            # Anything still marked downloading during the outage is a
            # candidate too (including transfers the user started while down).
            self._snapshot_active()
            return

        if self._recheck_at and now >= self._recheck_at:
            self._recheck_at = None
            self._resume_interrupted()

        self._resume_orphans()
        self._sweep_stalls(now)

    # --- Reconnect handling ----------------------------------------------
    def _snapshot_active(self):
        for d in self._downloading():
            mid = d.get('message_id')
            if mid:
                self._interrupted.setdefault(mid, d.get('downloaded_bytes') or 0)

    def _resume_interrupted(self):
        pending, self._interrupted = self._interrupted, {}
        db = get_db()
        for message_id, bytes_before in pending.items():
            download = db.get_download_by_message_id(message_id)
            if not download or download.get('deleted_at'):
                continue
            status = download.get('status')
            if status == 'failed':
                self._resume(download, force=False, reason="failed while the link was down")
            elif status == 'downloading' and (download.get('downloaded_bytes') or 0) <= bytes_before:
                # Still "downloading" but not a byte moved since the outage:
                # whatever it is waiting on is never coming back.
                self._resume(download, force=True, reason="no progress since the link dropped")
            # done / stopped / paused, or bytes moving again: leave it alone.

    # --- Restart handling -------------------------------------------------
    def _resume_orphans(self):
        """Pick up downloads the previous run left behind.

        Whatever is still marked `downloading` on the first tick was in flight
        when the service went down - this process has no transfer for it, so
        the record would otherwise sit at its last percentage forever. Resuming
        without `force` is safe even for a record a user started in the seconds
        before this ran: every handler reports "already running" and declines."""
        if self._orphans is None:
            self._orphans = [d['message_id'] for d in self._downloading() if d.get('message_id')]
            if self._orphans:
                logger.info("%d download(s) interrupted by a restart", len(self._orphans))
                print(f"♻️  Resuming {len(self._orphans)} download(s) interrupted by the restart")
        if not self._orphans:
            return

        self._orphan_attempts += 1
        last_try = self._orphan_attempts >= STARTUP_RESUME_ATTEMPTS
        db = get_db()
        unresumed = []
        for message_id in self._orphans:
            download = db.get_download_by_message_id(message_id)
            if not download or download.get('deleted_at') or download.get('status') != 'downloading':
                continue  # finished, deleted or already dealt with
            if self._resume(download, force=False, reason="interrupted by a restart"):
                continue
            if not last_try:
                unresumed.append(message_id)  # Telegram still connecting, most likely
                continue
            db.update_download_by_message_id(
                message_id, status='failed', speed=0, pending_time=None,
                error='Interrupted by a restart and could not be resumed automatically')
            self._emit_status(message_id, 'failed')
        self._orphans = unresumed

    # --- Stall handling ---------------------------------------------------
    def _sweep_stalls(self, now):
        if not self.stall_seconds:
            return
        marks = {}
        for download in self._downloading():
            message_id = download.get('message_id')
            if not message_id:
                continue
            bytes_now = download.get('downloaded_bytes') or 0
            previous = self._marks.get(message_id)
            if not previous or previous[0] != bytes_now:
                marks[message_id] = (bytes_now, now)   # moving, or newly seen
                continue
            marks[message_id] = previous
            if now - previous[1] < self.stall_seconds:
                continue
            if (download.get('progress') or 0) >= NEAR_DONE_PROGRESS:
                continue  # muxing, not stalled
            self._resume(download, force=True,
                         reason=f"no progress for {int(now - previous[1])}s")
            # Restart from a fresh mark, so a download that needs a moment to
            # get going again isn't restarted on every following tick.
            marks[message_id] = (bytes_now, now)
        self._marks = marks

    # --- Helpers ----------------------------------------------------------
    def _downloading(self):
        return get_db().get_downloads_by_status('downloading')

    def _resume(self, download, force, reason) -> bool:
        name = download.get('file') or download.get('message_id')
        logger.info("resuming %s (%s)", name, reason)
        print(f"🔄 Resuming download: {name} ({reason})")
        if resume_download(download, force=force):
            return True
        logger.warning("could not resume %s", name)
        return False

    def _emit_status(self, message_id, status):
        from backend.web_app import get_socketio
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:status', {'message_id': message_id, 'status': status})

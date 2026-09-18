"""Torrent watcher: stop a torrent seeding the moment its download finishes.

A seedbox that keeps every finished torrent uploading is the default everywhere,
and on a home setup that is usually not what you want - the file is already
pulled down to DownLee, and the upload slot is just burning the VPS's bandwidth
allowance. This thread polls each configured client and stops (pauses) anything
that has finished downloading and moved on to seeding.

Two details it is deliberately careful about:

  * **It waits for `seeding`, not for 100%.** Both clients download into a temp
    dir and move the files to their final folder as part of completing; while
    that move runs the torrent is not seeding yet (Transmission finishes the
    move before it changes state, qBittorrent reports `moving`, which the
    normalizer maps to `checking`). Stopping on the raw percentage would race
    that move, and the VPS->DownLee pull would then look for files that are
    still in flight between two directories.
  * **It only stops a torrent once.** Restarting a completed torrent by hand -
    to seed back to a tracker, to re-check it - would otherwise be undone on
    the next tick, which is an infuriating thing to debug. The hashes it has
    already acted on live in memory, so a manual restart sticks until the
    service restarts.

Seeding is a requirement on private trackers, so this is a per-client setting
(`stop_on_complete` in the `torrent_config` blob, toggled in Settings -> VPS)
rather than something the watcher assumes. TORRENT_WATCH=0 turns the thread off
entirely.
"""
import logging
import threading
import time

from backend.config import TORRENT_WATCH_INTERVAL
from backend.web_app.torrent import (
    CLIENTS, load_torrent_config, read_torrent_settings, stop_on_complete_enabled,
    torrent_control, torrent_list,
)

logger = logging.getLogger(__name__)

# Statuses that mean "the data is complete and it is now uploading". Anything
# else - including `checking`, which is where qBittorrent's post-download move
# lands - is left alone.
SEEDING_STATUSES = {"seeding", "seed-wait"}


class TorrentWatcher(threading.Thread):
    """Poll every configured torrent client and stop completed torrents."""

    def __init__(self, interval: int = None):
        super().__init__(daemon=True, name="torrent-watch")
        self.interval = interval or TORRENT_WATCH_INTERVAL
        # (client, hash) pairs already stopped once - see the module docstring.
        self._handled = set()

    def run(self):
        while True:
            try:
                self.tick()
            except Exception as e:  # a watcher that dies silently is worse than a noisy one
                logger.error(f"Torrent watcher tick failed: {e}")
            time.sleep(self.interval)

    def tick(self):
        settings = read_torrent_settings()
        seen = set()
        for client in CLIENTS:
            sub = settings.get(client) or {}
            if not sub.get("url") or not stop_on_complete_enabled(sub):
                continue
            try:
                cfg = load_torrent_config(client)
                torrents = torrent_list(client, config=cfg)
            except Exception as e:
                # The VPS being unreachable is routine; the next tick retries.
                logger.debug(f"Torrent watcher could not list {client}: {e}")
                continue

            done = []
            for t in torrents:
                key = (client, t.get("hash"))
                seen.add(key)
                if not t.get("hash") or t.get("status") not in SEEDING_STATUSES:
                    continue
                if key in self._handled:
                    continue
                done.append(t)

            for t in done:
                try:
                    torrent_control(client, "stop", [t["hash"]], config=cfg)
                    self._handled.add((client, t["hash"]))
                    logger.info(f"Stopped seeding on {client}: {t.get('name')}")
                except Exception as e:
                    # Not marked handled, so the next tick tries again.
                    logger.warning(f"Could not stop {t.get('name')} on {client}: {e}")

        # Forget torrents that have been removed from their client, so the set
        # tracks what is actually there instead of growing for the process's life.
        self._handled &= seen

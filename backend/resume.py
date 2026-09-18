"""One way to pick an interrupted download back up.

The retry button, a Telegram "resume" and the network watchdog all land here,
so an automatic recovery can never behave differently from the manual one -
that kind of drift is a miserable bug to chase. Every source resumes from the
bytes already on disk (Telethon seeks to the partial file's size, yt-dlp runs
with -c, SFTP resumes at the local file's size), so a resume costs only what
was actually lost.

`force` is the difference between "this download is dead, start it again" and
"this download is wedged": without it a transfer that is still registered as
running is left alone, with it the in-flight task is cancelled and waited for
*before* the replacement starts. Skipping that wait is how you end up with two
writers on one file, or with the old task's cleanup deregistering the new one.
"""
import asyncio
import logging

from backend.database import get_db
from backend import metrics

logger = logging.getLogger(__name__)

# How long to wait for a handler to actually hand the download back. Generous:
# cancelling a wedged transfer can take a few seconds, and the alternative
# (giving up early) leaves the record marked downloading with nothing running.
RESUME_TIMEOUT = 45


def source_of(download) -> str:
    """Which handler owns this download: 'vps', 'telegram' or 'ytdlp'."""
    src = (download.get('downloaded_from') or '').lower()
    if src == 'vps':
        return 'vps'
    if src == 'telegram':
        return 'telegram'
    return 'ytdlp' if download.get('url') else 'telegram'


def resume_download(download, force: bool = False) -> bool:
    """Restart `download` from where it stopped. Returns True if a transfer is
    running again. Never raises - callers are route handlers and a watchdog
    thread, neither of which should die over one stubborn record."""
    from backend.web_app import get_web_app

    web = get_web_app()
    if not web:
        return False
    message_id = download.get('message_id')
    if not message_id:
        return False
    source = source_of(download)

    try:
        if source == 'vps':
            ok = _resume_vps(web, message_id, force)
        elif source == 'telegram':
            ok = _resume_telegram(web, message_id, force)
        else:
            ok = _resume_ytdlp(web, download, force)
    except Exception as e:  # noqa: BLE001 - one bad record must not take the caller down
        logger.warning("resume failed for %s (%s): %s", message_id, source, e)
        return False

    if ok:
        metrics.record_retry(download.get('downloaded_from') or source)
    return ok


def _resume_vps(web, message_id, force):
    if not web.vps_downloader:
        return False
    if force:
        # Blocks until the transfer thread is gone, force-closing its SSH
        # connection if it is stuck in a blocking read on a dead socket. If it
        # refuses to die, starting a second thread on the same files would be
        # worse than leaving it be.
        if not web.vps_downloader.stop_download(message_id):
            logger.warning("vps transfer %s did not stop; not restarting it", message_id)
            return False
    return bool(web.vps_downloader.resume_download(message_id))


def _resume_telegram(web, message_id, force):
    tg = web.telegram_downloader
    if not tg or not tg.loop:
        return False
    try:
        telegram_id = int(message_id)
    except (TypeError, ValueError):
        return False
    future = asyncio.run_coroutine_threadsafe(
        tg.resume_download(telegram_id, force=force), tg.loop)
    # The coroutine keeps running if this times out; we just stop waiting on it.
    return bool(future.result(timeout=RESUME_TIMEOUT))


def _resume_ytdlp(web, download, force):
    if not web.ytdlp_downloader or not web.event_loop:
        return False
    return bool(web.ytdlp_downloader.resume_download(download, web.event_loop, force=force))


def resume_by_id(download_id: int, force: bool = False) -> bool:
    """Resume by primary key, for callers holding an id rather than a record."""
    download = get_db().get_download_by_id(download_id)
    return resume_download(download, force=force) if download else False

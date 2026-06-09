"""
Telegram client and download handler
"""
import asyncio
import json
import logging
import os
import re
import subprocess
from datetime import datetime
from telethon import TelegramClient, events, utils as tg_utils
from telethon.errors import SessionPasswordNeededError
from backend.config import API_ID, API_HASH, CHAT_ID, DOWNLOAD_DIR, MAX_RETRIES, SESSION_FILE
from backend.database import get_db
from backend.utils import human_readable_size, get_media_folder
from backend.web_app import get_socketio
from backend import metrics
from backend.file_meta import poll_and_extract_meta, is_video_file

CHANNELS_SETTING_KEY = 'telegram_channels'
API_SETTING_KEY = 'telegram_api'
QUERIES_SETTING_KEY = 'bot_queries'
QUERY_TIMEOUT = 30  # seconds a query snippet may run

# Seeded on first run so the Queries tab has working examples
DEFAULT_QUERIES = [
    {
        'key': 'hello',
        'command': 'echo "Hello ${SENDER_NAME:-there}, hope you are good? 😊"',
    },
    {
        'key': 'health',
        'command': (
            'echo "✅ all good — $(uptime -p)"\n'
            'df -h "$DOWNLOAD_DIR" | awk \'NR==2 {print "💾 "$4" free of "$2" ("$5" used)"}\'\n'
            'disks=$(lsblk -dno NAME,TYPE | awk \'$2=="disk"{print $1}\')\n'
            'echo "🖴 $(echo "$disks" | grep -c .) disk(s) installed:"\n'
            'for d in $disks; do\n'
            '  model=$(lsblk -dno MODEL "/dev/$d" | xargs)\n'
            '  size=$(lsblk -dno SIZE "/dev/$d" | xargs)\n'
            '  health=$(sudo -n smartctl -H "/dev/$d" 2>/dev/null | awk -F: \'/overall-health|SMART Health Status/{gsub(/^ +/,"",$2); print $2}\')\n'
            '  mounts=$(lsblk -no MOUNTPOINT "/dev/$d" | sed \'/^$/d;/\\[SWAP\\]/d\' | sort -u)\n'
            '  avail=$(echo "$mounts" | xargs -r df -B1 --output=avail 2>/dev/null | awk \'NR>1{s+=$1} END{if(s>0) print s}\')\n'
            '  free=$([ -n "$avail" ] && numfmt --to=iec "$avail")\n'
            '  echo "• $d — $model ($size): ${health:-unknown (smartctl needs sudo)}${free:+ · ${free} free}"\n'
            'done'
        ),
    },
]


class TelegramDownloader:
    def __init__(self, download_tasks):
        self.download_tasks = download_tasks

        self.last_broadcast = 0
        self.authorized = False
        self._stopping = False
        self._handler = None  # Currently registered NewMessage handler
        self._mention_handler = None  # Command handler for messages tagging the account

        # Pending web-login state (phone -> code -> optional 2FA password)
        self._login_phone = None
        self._login_code_hash = None

        # API credentials: database setting first, .env as fallback. Without
        # them there is no client yet — it gets created once they are saved
        # via the web UI (Settings -> Telegram).
        self.api_id, self.api_hash, self.api_source = self._load_api_credentials()
        self.client = (TelegramClient(str(SESSION_FILE), self.api_id, self.api_hash)
                       if self.api_id and self.api_hash else None)

        # Monitored channels: [{'id': int, 'title': str}, ...] persisted in settings
        self.channels = self._load_channels()
        self._register_handler()

    # ------------------------------------------------------------------
    # API credentials (api_id/api_hash)
    # ------------------------------------------------------------------

    def _load_api_credentials(self):
        """Return (api_id, api_hash, source) from the DB setting, falling back
        to the .env values. api_hash is stored encrypted at rest."""
        from backend.utils import decrypt_secret
        raw = get_db().get_setting(API_SETTING_KEY)
        if raw:
            try:
                cfg = json.loads(raw)
                api_id = int(cfg.get('api_id') or 0)
                api_hash = decrypt_secret(cfg.get('api_hash_enc', ''))
                if api_id and api_hash:
                    return api_id, api_hash, 'database'
            except Exception as e:
                logging.error(f"Failed to parse {API_SETTING_KEY}: {e}")
        if API_ID and API_HASH and API_HASH != 'your_api_hash_here':
            return API_ID, API_HASH, 'env'
        return None, None, None

    def get_api_config(self):
        """API credential state for the settings UI (hash never exposed)."""
        return {
            'configured': bool(self.api_id and self.api_hash),
            'api_id': self.api_id,
            'has_hash': bool(self.api_hash),
            'source': self.api_source,
        }

    async def set_api_credentials(self, api_id, api_hash):
        """Save API credentials and swap in a new client without a restart.
        A blank api_hash keeps the previously saved one."""
        from backend.utils import encrypt_secret
        api_hash = api_hash or self.api_hash
        if not api_hash:
            return {'error': 'API hash is required'}
        get_db().set_setting(API_SETTING_KEY, json.dumps({
            'api_id': api_id,
            'api_hash_enc': encrypt_secret(api_hash),
        }))
        old_client = self.client
        self.api_id, self.api_hash, self.api_source = api_id, api_hash, 'database'
        self.authorized = False
        self._login_phone = None
        self._login_code_hash = None
        self.client = TelegramClient(str(SESSION_FILE), api_id, api_hash)
        self._handler = None  # handler belonged to the old client
        self._register_handler()
        if old_client:
            # Unblocks run_until_disconnected; _run reconnects with the new client
            await old_client.disconnect()
        return {'status': 'saved', **self.get_api_config()}

    # ------------------------------------------------------------------
    # Channel management
    # ------------------------------------------------------------------

    def _load_channels(self):
        """Load monitored channels from settings, seeding from .env CHAT_ID."""
        db = get_db()
        raw = db.get_setting(CHANNELS_SETTING_KEY)
        if raw:
            try:
                channels = json.loads(raw)
                if isinstance(channels, list):
                    return [c for c in channels if isinstance(c, dict) and c.get('id')]
            except Exception as e:
                logging.error(f"Failed to parse {CHANNELS_SETTING_KEY}: {e}")
        if CHAT_ID:
            channels = [{'id': CHAT_ID, 'title': str(CHAT_ID)}]
            db.set_setting(CHANNELS_SETTING_KEY, json.dumps(channels))
            return channels
        return []

    def _save_channels(self):
        get_db().set_setting(CHANNELS_SETTING_KEY, json.dumps(self.channels))

    def get_channels(self):
        return list(self.channels)

    def chat_ids(self):
        return [c['id'] for c in self.channels]

    def default_chat_id(self):
        """Fallback chat for legacy download records without a stored chat_id."""
        ids = self.chat_ids()
        return ids[0] if ids else CHAT_ID

    def _register_handler(self):
        """(Re-)register the NewMessage handlers: commands for any message
        tagging the account, file downloads for the current channel list."""
        if self.client is None:
            return
        if self._mention_handler:
            self.client.remove_event_handler(self._mention_handler)
            self._mention_handler = None
        if self._handler:
            self.client.remove_event_handler(self._handler)
            self._handler = None

        async def handle_mention(event):
            await self._handle_mention(event)

        self._mention_handler = handle_mention
        self.client.add_event_handler(handle_mention, events.NewMessage(incoming=True))

        ids = self.chat_ids()
        print(f"📡 Listening for new files on {len(ids)} channel(s): {ids}")
        if not ids:
            return

        async def handle_new_file(event):
            await self._handle_new_file(event)

        self._handler = handle_new_file
        self.client.add_event_handler(handle_new_file, events.NewMessage(chats=ids))

    async def _resolve_entity(self, identifier):
        """get_entity that tolerates numeric IDs in the wrong format.

        Channel/megagroup IDs must be passed in the -100-prefixed "marked"
        form; a bare ID makes Telethon guess "basic chat" (GetChatsRequest)
        and Telegram rejects it with "Invalid object ID for a chat". Try the
        plausible variants, then fall back to scanning dialogs (which also
        populates the entity cache)."""
        if not isinstance(identifier, int):
            return await self.client.get_entity(identifier)

        candidates = [identifier]
        digits = str(abs(identifier))
        if not str(identifier).startswith('-100'):
            candidates.append(int('-100' + digits))
        if identifier > 0:
            candidates.append(-identifier)

        first_error = None
        for cand in candidates:
            try:
                return await self.client.get_entity(cand)
            except Exception as e:
                first_error = first_error or e

        # Dialog scan fallback (user accounts only — bots can't list dialogs)
        me = await self.client.get_me()
        if not (me and me.bot):
            async for dialog in self.client.iter_dialogs():
                if dialog.id in candidates:
                    return dialog.entity

        raise first_error

    async def add_channel(self, identifier):
        """Resolve a channel/group/user by @username, t.me link, or numeric ID
        and add it to the monitored list."""
        if self.client is None:
            return {'error': 'Telegram is not connected'}
        identifier = str(identifier).strip()
        if identifier.lstrip('-').isdigit():
            identifier = int(identifier)
        entity = await self._resolve_entity(identifier)
        chat_id = tg_utils.get_peer_id(entity)
        title = (getattr(entity, 'title', None)
                 or getattr(entity, 'username', None)
                 or ' '.join(filter(None, [getattr(entity, 'first_name', None),
                                           getattr(entity, 'last_name', None)]))
                 or str(chat_id))
        if any(c['id'] == chat_id for c in self.channels):
            return {'error': f'"{title}" is already being monitored'}
        self.channels.append({'id': chat_id, 'title': title})
        self._save_channels()
        self._register_handler()
        return {'channels': self.get_channels()}

    async def remove_channel(self, chat_id):
        """Remove a channel from the monitored list."""
        self.channels = [c for c in self.channels if c['id'] != chat_id]
        self._save_channels()
        self._register_handler()
        return {'channels': self.get_channels()}

    async def list_dialogs(self, limit=200):
        """List the account's dialogs (channels/groups first) for the picker UI."""
        if self.client is None:
            return []
        me = await self.client.get_me()
        if me and me.bot:
            raise ValueError('Bot accounts cannot list their chats — add channels by @username or chat ID instead')
        dialogs = await self.client.get_dialogs(limit=limit)
        monitored = set(self.chat_ids())
        result = []
        for d in dialogs:
            kind = 'channel' if d.is_channel else 'group' if d.is_group else 'user'
            result.append({
                'id': d.id,
                'title': d.title or str(d.id),
                'type': kind,
                'username': getattr(d.entity, 'username', None),
                'monitored': d.id in monitored,
            })
        result.sort(key=lambda x: (x['type'] == 'user', x['title'].lower()))
        return result

    async def refresh_channel_titles(self):
        """Best-effort: replace numeric placeholder titles with real chat
        titles, and normalize IDs to the marked (-100...) form so event
        filtering matches."""
        changed = False
        for c in self.channels:
            if c.get('title') and not c['title'].lstrip('-').isdigit():
                continue
            try:
                entity = await self._resolve_entity(c['id'])
                marked = tg_utils.get_peer_id(entity)
                if marked != c['id']:
                    c['id'] = marked
                    changed = True
                title = getattr(entity, 'title', None) or getattr(entity, 'username', None)
                if title:
                    c['title'] = title
                    changed = True
            except Exception as e:
                logging.error(f"Could not resolve title for chat {c['id']}: {e}")
        if changed:
            self._save_channels()
            self._register_handler()

    # ------------------------------------------------------------------
    # Web-based authentication
    # ------------------------------------------------------------------

    async def get_status(self):
        """Connection/authorization status for the settings UI."""
        connected = bool(self.client) and self.client.is_connected()
        status = {
            'api_configured': bool(self.client),
            'connected': connected,
            'authorized': False,
            'awaiting_code': bool(self._login_code_hash),
            'user': None,
        }
        if not connected:
            return status
        try:
            status['authorized'] = await self.client.is_user_authorized()
            if status['authorized']:
                me = await self.client.get_me()
                if me:
                    status['user'] = {
                        'id': me.id,
                        'username': me.username,
                        'first_name': me.first_name,
                        'last_name': me.last_name,
                        'phone': me.phone,
                        'is_bot': bool(getattr(me, 'bot', False)),
                    }
        except Exception as e:
            logging.error(f"Telegram status check failed: {e}")
        return status

    async def send_login_code(self, phone):
        """Step 1: send the login code to the user's Telegram app/SMS."""
        if self.client is None:
            return {'error': 'Configure the API ID and hash first'}
        if not self.client.is_connected():
            await self.client.connect()
        sent = await self.client.send_code_request(phone)
        self._login_phone = phone
        self._login_code_hash = sent.phone_code_hash
        return {'status': 'code_sent'}

    async def submit_login_code(self, code):
        """Step 2: verify the code. May require a 2FA password afterwards."""
        if not self._login_phone or not self._login_code_hash:
            return {'error': 'No pending login. Request a code first.'}
        try:
            await self.client.sign_in(
                phone=self._login_phone,
                code=code,
                phone_code_hash=self._login_code_hash,
            )
        except SessionPasswordNeededError:
            return {'status': 'password_required'}
        await self._on_authorized()
        return {'status': 'authorized'}

    async def submit_password(self, password):
        """Step 3 (only with 2FA enabled): verify the cloud password."""
        await self.client.sign_in(password=password)
        await self._on_authorized()
        return {'status': 'authorized'}

    async def submit_bot_token(self, token):
        """Alternative login: sign in as a bot account. The bot must be a
        member of every monitored group (admin, or privacy mode disabled
        via BotFather) to see other members' messages."""
        if self.client is None:
            return {'error': 'Configure the API ID and hash first'}
        if not self.client.is_connected():
            await self.client.connect()
        await self.client.sign_in(bot_token=token.strip())
        await self._on_authorized()
        return {'status': 'authorized'}

    async def logout(self):
        """Log out and invalidate the session file. The client reconnects
        unauthorized and waits for a new web login."""
        self.authorized = False
        self._login_phone = None
        self._login_code_hash = None
        if self.client:
            await self.client.log_out()
        return {'status': 'logged_out'}

    async def _on_authorized(self):
        """Called once a login completes (at startup or via the web flow)."""
        self.authorized = True
        self._login_phone = None
        self._login_code_hash = None
        await self.refresh_channel_titles()
        await self.send_startup_greeting()

    def emit_progress(self, message_id: int, progress: float, downloaded_bytes: int,
                       total_bytes: int, speed: float, pending_time: float | None):
        """Emit progress update for a specific download (throttled)"""
        now = datetime.now().timestamp()
        if now - self.last_broadcast >= 1:
            self.last_broadcast = now
            socketio = get_socketio()
            if socketio:
                socketio.emit('download:progress', {
                    'message_id': str(message_id),  # String to avoid JS precision loss
                    'progress': progress,
                    'downloaded_bytes': downloaded_bytes,
                    'total_bytes': total_bytes,
                    'speed': speed,
                    'pending_time': pending_time
                })
                # Also emit updated stats
                from backend.web_app import get_web_app
                web_app = get_web_app()
                if web_app:
                    web_app.emit_stats()

    def emit_status(self, message_id: int, status: str, error: str | None = None):
        """Emit status change for a specific download"""
        socketio = get_socketio()
        if socketio:
            data = {'message_id': str(message_id), 'status': status}  # String to avoid JS precision loss
            if error:
                data['error'] = error
            socketio.emit('download:status', data)

    def emit_new_download(self, download: dict):
        """Emit new download added event (message_id already stringified in to_dict)"""
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:new', download)
            # Also emit updated stats
            from backend.web_app import get_web_app
            web_app = get_web_app()
            if web_app:
                web_app.emit_stats()

    def emit_deleted(self, message_id: int):
        """Emit download deleted event"""
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:deleted', {'message_id': str(message_id)})

    async def edit_status_message(self, event, entry, status=None):
        """Edits the Telegram message with the current download status."""
        try:
            client = event.client
            if not entry.get("_status_msg_id"):
                return
            msg = await client.get_messages(event.chat_id, ids=entry["_status_msg_id"])
            emoji_map = {"Downloading": "⬇️", "Downloaded": "✅", "Failed": "❌", "Stopped": "🛑", "Paused": "⏸️"}
            if status is None:
                text = f"⬇️ Status: Downloading {entry.get('progress', 0)}% ({human_readable_size(entry.get('downloaded_bytes', 0))}/{human_readable_size(entry.get('total_bytes', 0))})"
            else:
                text = f"{emoji_map.get(status, '')} Status: {status}"
            await msg.edit(text)
        except Exception as e:
            logging.error(f"Failed to edit status message: {e}")

    async def update_status_message(self, message_id: int, status: str):
        """Update the Telegram status message for a download by looking up status_msg_id from DB."""
        db = get_db()
        download = db.get_download_by_message_id(message_id)
        if not download or not download.get("status_msg_id"):
            return
        emoji_map = {"Downloading": "⬇️", "Downloaded": "✅", "Failed": "❌", "Stopped": "🛑", "Paused": "⏸️"}
        text = f"{emoji_map.get(status, '')} Status: {status}"
        chat_id = int(download['chat_id']) if download.get('chat_id') else self.default_chat_id()
        try:
            msg = await self.client.get_messages(chat_id, ids=download["status_msg_id"])
            await msg.edit(text)
        except Exception as e:
            logging.error(f"Failed to update status message: {e}")

    def pause_download(self, message_id: int):
        """Cancel the active download task so it can be restarted later."""
        task = self.download_tasks.get(message_id)
        if task and not task.done():
            task.cancel()

    async def restart_download(self, message_id: int):
        """Re-fetch a Telegram message and restart the download (resumes from partial file)."""
        db = get_db()
        download = db.get_download_by_message_id(message_id)
        if not download:
            logging.error(f"No DB record for message_id={message_id}")
            return False

        chat_id = int(download['chat_id']) if download.get('chat_id') else self.default_chat_id()
        try:
            msg = await self.client.get_messages(chat_id, ids=message_id)
        except Exception as e:
            logging.error(f"Failed to fetch Telegram message {message_id}: {e}")
            return False

        if not msg or not msg.file:
            logging.error(f"Message {message_id} has no file attachment")
            return False

        # Determine download path from DB record
        filename = download.get("file")
        if not filename:
            logging.error(f"No filename in DB for message_id={message_id}")
            return False

        kind = get_media_folder(msg.file.mime_type)

        # Route to the 'telegram' source's configured folder, else DOWNLOAD_DIR/<kind>
        from backend.utils import resolve_spec, spec_folder
        spec = resolve_spec('telegram')
        folder = spec_folder(spec, DOWNLOAD_DIR / kind)
        folder.mkdir(parents=True, exist_ok=True)

        path = folder / filename

        entry = {
            "file": filename,
            "message_id": message_id,
            "_status_msg_id": None
        }

        task = asyncio.create_task(self.safe_download(msg, str(path), entry, is_restart=True))
        self.download_tasks[message_id] = task

        # Start background metadata extraction for video files
        if is_video_file(filename):
            asyncio.create_task(self._post_restart_meta(message_id, task))

        logging.info(f"Restarted download for message_id={message_id}")
        return True

    async def _post_restart_meta(self, message_id: int, download_task):
        """After a restarted download completes, extract meta + generate thumbnails if missing."""
        from backend.file_meta import extract_and_store_meta, generate_thumbnails, find_file
        try:
            await download_task
        except (asyncio.CancelledError, Exception):
            return

        db = get_db()
        download = db.get_download_by_message_id(message_id)
        if not download or download.get('status') != 'done':
            return

        # Extract meta if missing
        if not download.get('file_meta'):
            await extract_and_store_meta(str(message_id))
            download = db.get_download_by_message_id(message_id)
            if not download:
                return

        # Generate thumbnails if missing
        if not download.get('thumb_count'):
            file_meta = download.get('file_meta')
            duration = file_meta.get('duration') if isinstance(file_meta, dict) else None
            if duration:
                filename = download.get('file')
                file_path = find_file(filename, download.get('downloaded_from'))
                if file_path:
                    await generate_thumbnails(download.get('id'), str(file_path), duration)

    async def safe_download(self, event, path, entry, is_restart=False):
        """Downloads the media safely with live progress using chunk-based iteration."""
        db = get_db()
        message_id = entry["message_id"]
        download_start_time = datetime.now()

        # Record download started
        metrics.record_download_started('telegram')

        # Send initial "Downloading" message, or recover existing one on restart
        if is_restart:
            # Recover status message ID from DB
            download = db.get_download_by_message_id(message_id)
            entry["_status_msg_id"] = download.get("status_msg_id") if download else None
            if entry["_status_msg_id"]:
                try:
                    await self.edit_status_message(event, entry, "Downloading")
                except Exception as e:
                    logging.error(f"Failed to update existing status message: {e}")
        else:
            try:
                msg = await event.reply("⬇️ Status: Downloading")
                entry["_status_msg_id"] = msg.id
                db.update_download_by_message_id(message_id, status_msg_id=msg.id)
            except Exception as e:
                logging.error(f"Failed to send initial status message: {e}")
                entry["_status_msg_id"] = None

        try:
            total_bytes = event.file.size or 0

            for attempt in range(1, MAX_RETRIES + 1):
                if attempt > 1:
                    metrics.record_retry('telegram')

                try:
                    # Determine resume offset from partial file
                    from pathlib import Path
                    partial = Path(path)
                    resume_offset = partial.stat().st_size if partial.exists() else 0
                    downloaded = resume_offset
                    last_bytes = downloaded
                    start_time = datetime.now()
                    last_update = 0
                    last_emit = 0

                    mode = 'ab' if resume_offset > 0 else 'wb'
                    with open(path, mode) as f:
                        async for chunk in self.client.iter_download(
                            event.media,
                            offset=resume_offset,
                            file_size=total_bytes,
                            request_size=524288,  # 512KB chunks
                        ):
                            f.write(chunk)
                            downloaded += len(chunk)

                            # Progress reporting (throttled to 1/sec)
                            now = datetime.now()
                            timestamp = now.timestamp()
                            if timestamp - last_emit < 1:
                                continue
                            last_emit = timestamp

                            delta = (now - start_time).total_seconds()
                            speed = round((downloaded - last_bytes) / 1024 / delta, 1) if delta > 0 else 0
                            last_bytes = downloaded
                            start_time = now

                            progress = round(downloaded / total_bytes * 100, 1) if total_bytes > 0 else 0
                            pending_time = (total_bytes - downloaded) / (speed * 1024) if speed > 0 else None

                            entry["progress"] = progress
                            entry["downloaded_bytes"] = downloaded
                            entry["total_bytes"] = total_bytes
                            entry["speed"] = speed
                            entry["pending_time"] = pending_time

                            db.update_download_by_message_id(
                                message_id,
                                progress=progress,
                                downloaded_bytes=downloaded,
                                total_bytes=total_bytes,
                                speed=speed,
                                pending_time=pending_time
                            )
                            self.emit_progress(message_id, progress, downloaded, total_bytes, speed, pending_time)

                            if entry.get("_status_msg_id") and timestamp - last_update >= 20:
                                last_update = timestamp
                                asyncio.create_task(self.edit_status_message(event, entry))

                    # Download complete
                    db.update_download_by_message_id(
                        message_id,
                        status='done',
                        progress=100,
                        speed=0,
                        pending_time=0
                    )
                    self.emit_status(message_id, 'done')
                    if entry.get("_status_msg_id"):
                        await self.edit_status_message(event, entry, "Downloaded")

                    duration = (datetime.now() - download_start_time).total_seconds()
                    metrics.record_download_completed('telegram', total_bytes, duration)
                    return

                except asyncio.CancelledError:
                    # Status already set by the API handler (stop or pause)
                    metrics.record_download_stopped('telegram')
                    return
                except Exception as e:
                    error_msg = f"Attempt {attempt}/{MAX_RETRIES} failed: {str(e)}"
                    db.update_download_by_message_id(message_id, error=error_msg)
                    logging.error(error_msg)
                    await asyncio.sleep(5)

            # All retries exhausted
            db.update_download_by_message_id(message_id, status='failed', speed=0, pending_time=None)
            self.emit_status(message_id, 'failed')
            if entry.get("_status_msg_id"):
                await self.edit_status_message(event, entry, "Failed")
            metrics.record_download_failed('telegram', 'max_retries')
        finally:
            self.download_tasks.pop(message_id, None)

    async def _handle_new_file(self, event):
        """Handle new file messages from Telegram"""
        if not event.file:
            return

        kind = get_media_folder(event.file.mime_type)

        db = get_db()

        # Route to the 'telegram' source's configured folder, else DOWNLOAD_DIR/<kind>
        from backend.utils import resolve_spec, spec_folder
        spec = resolve_spec('telegram')
        folder = spec_folder(spec, DOWNLOAD_DIR / kind)
        folder.mkdir(parents=True, exist_ok=True)

        filename = event.file.name or f"{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        path = folder / filename

        # Extract author info (username:id) from the sender
        author = None
        try:
            sender = await event.get_sender()
            if sender:
                username = getattr(sender, 'username', None) or getattr(sender, 'first_name', None) or ''
                sender_id = getattr(sender, 'id', '')
                author = f"{username}:{sender_id}" if username else str(sender_id)
            elif event.message.post_author:
                author = event.message.post_author
        except Exception as e:
            logging.error(f"Failed to get sender info: {e}")

        # Add to database with Telegram message ID
        new_download = db.add_download(
            file=filename,
            status='downloading',
            progress=0,
            speed=0,
            error=None,
            downloaded_bytes=0,
            total_bytes=0,
            pending_time=None,
            message_id=event.id,
            author=author,
            chat_id=event.chat_id,
        )

        # Emit new download event
        self.emit_new_download(new_download)

        # Create entry dict for status message tracking
        entry = {
            "file": filename,
            "message_id": event.id,
            "_status_msg_id": None
        }

        # Start the download task
        task = asyncio.create_task(self.safe_download(event, str(path), entry))
        self.download_tasks[event.id] = task  # Use message_id as key

        # Start background metadata extraction for video files
        if is_video_file(filename):
            asyncio.create_task(poll_and_extract_meta(event.id))

    # ------------------------------------------------------------------
    # Chat queries (key -> shell snippet, managed in Settings -> Queries)
    # ------------------------------------------------------------------

    def get_queries(self):
        """Load the configured queries, seeding a 'health' example once."""
        db = get_db()
        raw = db.get_setting(QUERIES_SETTING_KEY)
        if raw is None:
            db.set_setting(QUERIES_SETTING_KEY, json.dumps(DEFAULT_QUERIES))
            return [dict(q) for q in DEFAULT_QUERIES]
        try:
            queries = json.loads(raw)
            return queries if isinstance(queries, list) else []
        except Exception as e:
            logging.error(f"Failed to parse {QUERIES_SETTING_KEY}: {e}")
            return []

    @staticmethod
    def _query_env(extra_env=None):
        env = dict(os.environ)
        env['DOWNLOAD_DIR'] = str(DOWNLOAD_DIR)
        # The systemd unit pins PATH to the venv only — make sure snippets can
        # still find standard tools (df, awk, lsblk, smartctl, ...)
        parts = [p for p in env.get('PATH', '').split(':') if p]
        for p in ('/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'):
            if p not in parts:
                parts.append(p)
        env['PATH'] = ':'.join(parts)
        if extra_env:
            env.update({k: str(v) for k, v in extra_env.items() if v is not None})
        return env

    @staticmethod
    def _format_query_output(stdout, stderr, returncode):
        output = ((stdout or '') + (stderr or '')).strip()
        if returncode != 0:
            output = f'{output}\n(exit code {returncode})'.strip()
        return output or '(no output)'

    @classmethod
    def run_query_sync(cls, command, extra_env=None):
        """Run a query snippet in a shell (used by the UI test button)."""
        try:
            proc = subprocess.run(command, shell=True, capture_output=True,
                                  text=True, timeout=QUERY_TIMEOUT, env=cls._query_env(extra_env))
        except subprocess.TimeoutExpired:
            return f'⏱️ Timed out after {QUERY_TIMEOUT}s'
        return cls._format_query_output(proc.stdout, proc.stderr, proc.returncode)

    @classmethod
    async def run_query_command(cls, command, extra_env=None):
        """Async variant of run_query_sync for the Telegram event loop."""
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=cls._query_env(extra_env),
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=QUERY_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            return f'⏱️ Timed out after {QUERY_TIMEOUT}s'
        return cls._format_query_output((out or b'').decode(errors='replace'), '', proc.returncode)

    async def _handle_mention(self, event):
        """Run a configured query when a message tagging the account (or a DM)
        matches a query key. 'help' lists the available keys."""
        try:
            if not (event.mentioned or event.is_private):
                return
            text = event.raw_text or ''
            # Strip the @username tag so "@DownLeeBot health" becomes "health"
            me = await self.client.get_me()
            username = getattr(me, 'username', None)
            if username:
                text = re.sub(rf'@{re.escape(username)}', '', text, flags=re.IGNORECASE)
            key = text.strip().lower()
            if not key or len(key) > 64:
                return

            queries = self.get_queries()
            query = next((q for q in queries
                          if (q.get('key') or '').strip().lower() == key), None)
            if query:
                # Expose the invoker and chat to the snippet as env vars
                extra_env = {}
                try:
                    sender = await event.get_sender()
                    if sender:
                        name = ' '.join(filter(None, [getattr(sender, 'first_name', None),
                                                      getattr(sender, 'last_name', None)]))
                        extra_env['SENDER_NAME'] = name or getattr(sender, 'username', None) or ''
                        extra_env['SENDER_USERNAME'] = getattr(sender, 'username', None) or ''
                        extra_env['SENDER_ID'] = str(getattr(sender, 'id', ''))
                    chat = await event.get_chat()
                    extra_env['CHAT_TITLE'] = getattr(chat, 'title', None) or ''
                except Exception as e:
                    logging.error(f"Could not resolve query sender info: {e}")
                reply = await self.run_query_command(query.get('command') or '', extra_env)
                # Telegram message limit is 4096 chars; no markdown parsing so
                # arbitrary command output can't break the reply
                await event.reply(reply[:4000], parse_mode=None)
            elif key == 'help':
                keys = ', '.join(sorted((q.get('key') or '') for q in queries))
                await event.reply(f'Available queries: {keys or "(none configured)"}', parse_mode=None)
        except Exception as e:
            logging.error(f"Mention command handler failed: {e}")

    async def send_startup_greeting(self):
        """Send a greeting message to each monitored chat when service starts"""
        hour = datetime.now().hour
        if 5 <= hour < 12:
            greeting = "Good Morning"
        elif 12 <= hour < 17:
            greeting = "Good Afternoon"
        else:
            greeting = "Good Evening"

        for chat_id in self.chat_ids():
            try:
                await self.client.send_message(chat_id, f"{greeting}, reporting for duty 🫡")
            except Exception as e:
                logging.error(f"Failed to send startup greeting to {chat_id}: {e}")

    def start(self):
        """Start the Telegram client without prompting on the terminal.

        Connects and, if the saved session is valid, starts handling updates
        immediately. Otherwise it stays connected (or waits for API
        credentials) until a login completes via the web UI
        (Settings -> Telegram)."""
        print("🚀 DownLee running...")
        try:
            self.loop = asyncio.get_event_loop()  # For cross-thread scheduling
        except RuntimeError:
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._run())

    async def _run(self):
        warned_no_api = False
        while not self._stopping:
            client = self.client
            if client is None:
                if not warned_no_api:
                    warned_no_api = True
                    print("⚠️  Telegram API credentials not set — add them via the web UI (Settings → Telegram)")
                await asyncio.sleep(2)
                continue
            warned_no_api = False
            try:
                if not client.is_connected():
                    await client.connect()
                if await client.is_user_authorized():
                    await self._on_authorized()
                else:
                    print("⚠️  Telegram not authorized — log in via the web UI (Settings → Telegram)")
                # Returns on explicit disconnect, logout, or credential swap;
                # web login happens in-flight on this same connection.
                await client.run_until_disconnected()
            except Exception as e:
                logging.error(f"Telegram client error: {e}")
            self.authorized = False
            if not self._stopping:
                await asyncio.sleep(2)

    def stop(self):
        """Stop the Telegram client"""
        self._stopping = True
        if self.client:
            self.client.disconnect()

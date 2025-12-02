"""
Telegram client and download handler
"""
import asyncio
import logging
from datetime import datetime
from telethon import TelegramClient, events
from backend.config import API_ID, API_HASH, CHAT_ID, DOWNLOAD_DIR, MAX_RETRIES, SESSION_FILE
from backend.database import get_db
from backend.utils import human_readable_size, get_media_folder
from backend.web_app import get_socketio


class TelegramDownloader:
    def __init__(self, download_tasks):
        self.download_tasks = download_tasks

        # Get credentials from config (env file)
        self.api_id = API_ID
        self.api_hash = API_HASH
        self.chat_id = CHAT_ID

        self.client = TelegramClient(str(SESSION_FILE), self.api_id, self.api_hash)
        self.last_broadcast = 0
        self.setup_event_handlers()

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

    def emit_deleted(self, message_id: int):
        """Emit download deleted event"""
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:deleted', {'message_id': str(message_id)})

    def setup_event_handlers(self):
        """Setup Telegram event handlers"""
        print(f"📡 Setting up event handler for chat_id: {self.chat_id}")

        @self.client.on(events.NewMessage(chats=self.chat_id))
        async def handle_new_file(event):
            await self._handle_new_file(event)

    async def edit_status_message(self, event, entry, status=None):
        """Edits the Telegram message with the current download status."""
        try:
            client = event.client
            if not entry.get("_status_msg_id"):
                return
            msg = await client.get_messages(event.chat_id, ids=entry["_status_msg_id"])
            emoji_map = {"Downloading": "⬇️", "Downloaded": "✅", "Failed": "❌", "Stopped": "🛑"}
            if status is None:
                text = f"⬇️ Status: Downloading {entry.get('progress', 0)}% ({human_readable_size(entry.get('downloaded_bytes', 0))}/{human_readable_size(entry.get('total_bytes', 0))})"
            else:
                text = f"{emoji_map.get(status, '')} Status: {status}"
            await msg.edit(text)
        except Exception as e:
            logging.error(f"Failed to edit status message: {e}")

    async def safe_download(self, event, path, entry):
        """Downloads the media safely with live progress."""
        last_bytes = 0
        start_time = datetime.now()
        last_update = 0  # timestamp of last message edit
        db = get_db()
        message_id = entry["message_id"]

        # Send initial "Downloading" message
        try:
            msg = await event.reply("⬇️ Status: Downloading")
            entry["_status_msg_id"] = msg.id
        except Exception as e:
            logging.error(f"Failed to send initial status message: {e}")
            entry["_status_msg_id"] = None

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                def progress_callback(current, total):
                    nonlocal last_bytes, start_time, last_update
                    now = datetime.now()
                    delta = (now - start_time).total_seconds()
                    speed = 0
                    if delta > 0:
                        speed = round((current - last_bytes) / 1024 / delta, 1)
                    last_bytes = current
                    start_time = now

                    progress = round(current / total * 100, 1)
                    pending_time = None
                    if speed > 0:
                        remaining_bytes = total - current
                        pending_time = remaining_bytes / (speed * 1024)

                    # Update entry dict for status message
                    entry["progress"] = progress
                    entry["downloaded_bytes"] = current
                    entry["total_bytes"] = total
                    entry["speed"] = speed
                    entry["pending_time"] = pending_time

                    # Save to database using message_id
                    db.update_download_by_message_id(
                        message_id,
                        progress=progress,
                        downloaded_bytes=current,
                        total_bytes=total,
                        speed=speed,
                        pending_time=pending_time
                    )

                    # Emit only changed fields
                    self.emit_progress(message_id, progress, current, total, speed, pending_time)

                    # Throttle edits: 1 per 20 seconds
                    timestamp = now.timestamp()
                    if entry.get("_status_msg_id") and timestamp - last_update >= 20:
                        last_update = timestamp
                        asyncio.create_task(self.edit_status_message(event, entry))

                await event.download_media(file=path, progress_callback=progress_callback)

                # Final update - download complete
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
                return

            except asyncio.CancelledError:
                db.update_download_by_message_id(message_id, status='stopped', speed=0)
                self.emit_status(message_id, 'stopped')
                if entry.get("_status_msg_id"):
                    await self.edit_status_message(event, entry, "Stopped")
                return
            except Exception as e:
                error_msg = f"Attempt {attempt}/{MAX_RETRIES} failed: {str(e)}"
                db.update_download_by_message_id(message_id, error=error_msg)
                logging.error(error_msg)
                await asyncio.sleep(5)

        # All retries exhausted - mark as failed
        db.update_download_by_message_id(message_id, status='failed', speed=0, pending_time=None)
        self.emit_status(message_id, 'failed')
        if entry.get("_status_msg_id"):
            await self.edit_status_message(event, entry, "Failed")

    async def _handle_new_file(self, event):
        """Handle new file messages from Telegram"""
        if not event.file:
            return

        kind = get_media_folder(event.file.mime_type)

        folder = DOWNLOAD_DIR / kind
        folder.mkdir(exist_ok=True)

        filename = event.file.name or f"{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        path = folder / filename

        db = get_db()

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
            message_id=event.id
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

    def start(self):
        """Start the Telegram client"""
        print("🚀 DownloadLee running...")
        self.client.start()
        self.client.run_until_disconnected()

    def stop(self):
        """Stop the Telegram client"""
        self.client.disconnect()

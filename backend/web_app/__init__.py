"""
Flask REST API with WebSocket support for DownLee
"""
import os
import json
import jwt
import asyncio
import posixpath
from datetime import datetime, timedelta
from pathlib import Path
from functools import wraps
from flask import Flask, jsonify, request, send_from_directory, Response
from flask_cors import CORS
from flask_socketio import SocketIO
from backend.config import WEB_PORT, WEB_HOST, JWT_SECRET
from backend.database import get_db
from backend import metrics

JWT_EXPIRY_DAYS = 30  # Keep signed in for 30 days

# Global socketio instance for broadcasting from other modules
socketio = None

# Global web app instance for accessing methods from other modules
_web_app = None

# Frontend dist directory
FRONTEND_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"


def get_socketio():
    """Get the global socketio instance"""
    return socketio


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


def candidate_file_paths(download, file_name):
    """Possible on-disk locations for a download's file, most specific first
    (the source's configured destination folder, then the defaults)."""
    from backend.config import DOWNLOAD_DIR
    from backend.utils import resolve_spec
    source = download.get("downloaded_from") or 'telegram'
    paths = [
        DOWNLOAD_DIR / file_name,
        DOWNLOAD_DIR / "Videos" / file_name,
    ]
    if source == 'vps':
        paths.insert(0, DOWNLOAD_DIR / "VPS" / file_name)
    spec = resolve_spec(source, path=download.get("url") if source == 'vps' else None)
    if spec.get("folder"):
        paths.insert(0, Path(spec["folder"]) / file_name)
    return paths


def get_web_app():
    """Get the global web app instance"""
    return _web_app


# Routes still usable while a forced password change is pending
PASSWORD_CHANGE_ALLOWED_PATHS = {'/api/auth/verify', '/api/auth/password'}


def token_required(f):
    """Decorator to require valid JWT token.

    While the user's `must_change_password` flag is set (default credentials),
    the token only grants access to /api/auth/verify and /api/auth/password —
    everything else returns 403 with code 'password_change_required'.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        auth_header = request.headers.get('Authorization')
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ')[1]

        if not token:
            return jsonify({'error': 'Token is missing'}), 401

        try:
            data = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
            request.user = data
        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Token has expired'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'error': 'Invalid token'}), 401

        # Checked in the DB (not the token) so the lockdown lifts immediately
        # after the password change without re-issuing the JWT.
        request.must_change_password = get_db().user_must_change_password(data.get('user_id'))
        if request.must_change_password and request.path not in PASSWORD_CHANGE_ALLOWED_PATHS:
            return jsonify({'error': 'Password change required',
                            'code': 'password_change_required'}), 403

        return f(*args, **kwargs)
    return decorated


class WebApp:
    def __init__(self, download_tasks, ytdlp_downloader=None, event_loop=None, telegram_downloader=None, vps_downloader=None):
        global socketio, _web_app
        self.download_tasks = download_tasks
        self.ytdlp_downloader = ytdlp_downloader
        self.telegram_downloader = telegram_downloader
        self.vps_downloader = vps_downloader
        self.event_loop = event_loop
        self.app = Flask(__name__, static_folder=str(FRONTEND_DIST), static_url_path='')
        CORS(self.app, resources={r"/*": {"origins": "*"}})
        socketio = SocketIO(self.app, cors_allowed_origins="*", async_mode='threading')
        self.socketio = socketio
        _web_app = self  # Set global web app instance
        self.setup_routes()
        self.setup_socketio()

    def setup_socketio(self):
        """Setup WebSocket event handlers"""

        @self.socketio.on('connect')
        def handle_connect():
            print("Client connected")
            # Don't send initial data - client will fetch via REST API

        @self.socketio.on('disconnect')
        def handle_disconnect():
            print("Client disconnected")

    def _annotate_downloads(self, downloads):
        """Stamp each download with computed `hidden` and `dest_folder` from
        the per-source mappings and per-VPS-watchfolder specs. Computed at
        query time so spec changes apply to existing downloads too."""
        db = get_db()
        maps = {m['downloaded_from']: m for m in db.get_all_download_type_maps()}
        vps_folders = (
            db.get_vps_watch_folders()
            if any(d.get('downloaded_from') == 'vps' for d in downloads) else []
        )
        for d in downloads:
            source = d.get('downloaded_from') or 'telegram'
            mapping = maps.get(source, {})
            hidden = bool(mapping.get('is_secured'))
            folder = mapping.get('folder')
            if source == 'vps':
                # Longest-prefix watched folder match on the remote path
                path = d.get('url') or ''
                best, best_len = None, -1
                for wf in vps_folders:
                    base = (wf.get('path') or '').rstrip('/')
                    if base and (path == wf.get('path') or path == base or path.startswith(base + '/')):
                        if len(base) > best_len:
                            best_len, best = len(base), wf
                if best:
                    folder = best.get('folder') or folder
                    hidden = hidden or bool(best.get('is_secured'))
            d['hidden'] = hidden
            d['dest_folder'] = folder
        return downloads

    def get_downloads_data(self, search='', filter_type='all', sort_by='created_at', sort_order='desc',
                           limit=30, offset=0, author=None, include_hidden=False):
        """Get downloads data (paginated)

        Args:
            search: Search query to filter by filename
            filter_type: 'all' for all downloads, 'active' for non-done downloads
            sort_by: Field to sort by ('created_at', 'file', 'status', 'progress')
            sort_order: 'asc' or 'desc'
            limit: Number of items to return (default 30)
            offset: Number of items to skip (default 0)
            author: Filter by specific author
            include_hidden: Include downloads from secured sources/folders
        """
        db = get_db()
        all_downloads = self._annotate_downloads(db.get_all_downloads())

        query = search.lower().strip()
        if query:
            filtered_list = []
            for d in all_downloads:
                # Check filename
                file_name = (d.get("file") or "").lower()
                # Check downloaded_from source
                downloaded_from = (d.get("downloaded_from") or "").lower()
                # Check URL
                url = (d.get("url") or "").lower()
                # Check author
                d_author = (d.get("author") or "").lower()

                # Exact substring match first
                if query in file_name or query in downloaded_from or query in url or query in d_author:
                    filtered_list.append(d)
                    continue

                # Fuzzy search: check if all query words appear in any field
                query_words = query.split()
                searchable_text = f"{file_name} {downloaded_from} {url} {d_author}"
                if all(word in searchable_text for word in query_words):
                    filtered_list.append(d)
        else:
            filtered_list = all_downloads

        # Filter out downloads from secured sources/folders
        if not include_hidden:
            filtered_list = [d for d in filtered_list if not d.get("hidden")]

        # Filter by author
        if author:
            filtered_list = [d for d in filtered_list if d.get("author") == author]

        # Apply filter_type
        if filter_type == 'active':
            filtered_list = [d for d in filtered_list if d.get("status") != "done"]

        # Apply sorting
        reverse = sort_order == 'desc'
        if sort_by == 'created_at':
            sorted_list = sorted(filtered_list, key=lambda x: x.get("created_at") or "", reverse=reverse)
        elif sort_by == 'file':
            sorted_list = sorted(filtered_list, key=lambda x: x.get("file", "").lower(), reverse=reverse)
        elif sort_by == 'status':
            sorted_list = sorted(filtered_list, key=lambda x: x.get("status", ""), reverse=reverse)
        elif sort_by == 'progress':
            sorted_list = sorted(filtered_list, key=lambda x: x.get("progress", 0), reverse=reverse)
        else:
            sorted_list = filtered_list

        filtered_list = sorted_list
        total_count = len(filtered_list)

        # Apply pagination
        paginated_list = filtered_list[offset:offset + limit]
        has_more = (offset + limit) < total_count

        return {
            "downloads": paginated_list,
            "has_more": has_more,
            "total": total_count
        }

    def get_stats(self):
        """Get stats only (without downloads list)"""
        db = get_db()
        all_downloads = db.get_all_downloads()

        # For completed downloads, count total_bytes (full file size)
        # For active downloads, count downloaded_bytes (current progress)
        total_downloaded = sum(
            d.get("total_bytes", 0) or 0 if d.get("status") == "done"
            else d.get("downloaded_bytes", 0) or 0
            for d in all_downloads
        )

        # Total size is sum of all total_bytes
        total_size = sum(d.get("total_bytes", 0) or 0 for d in all_downloads)

        # Pending is for active and paused downloads
        pending_bytes = sum(
            (d.get("total_bytes", 0) or 0) - (d.get("downloaded_bytes", 0) or 0)
            for d in all_downloads
            if d.get("status") in ("downloading", "paused")
        )

        total_speed = sum(d.get("speed", 0) or 0 for d in all_downloads)
        downloaded_count = sum(1 for d in all_downloads if d.get("status") == "done")
        total_count = len(all_downloads)
        active_count = sum(1 for d in all_downloads if d.get("status") != "done")

        return {
            "total_downloaded": total_downloaded,
            "total_size": total_size,
            "pending_bytes": pending_bytes,
            "total_speed": total_speed,
            "downloaded_count": downloaded_count,
            "total_count": total_count,
            "all_count": total_count,
            "active_count": active_count
        }

    def emit_stats(self):
        """Emit current stats to all clients"""
        stats = self.get_stats()
        self.socketio.emit('stats', stats)

    def emit_status(self, message_id, status: str):
        """Emit status change for a specific download"""
        # Ensure message_id is sent as string to avoid JS precision loss
        msg_id_str = str(message_id) if message_id else None
        self.socketio.emit('download:status', {'message_id': msg_id_str, 'status': status})
        # Also emit updated stats
        self.emit_stats()

    def emit_deleted(self, message_id):
        """Emit download deleted event"""
        # Ensure message_id is sent as string to avoid JS precision loss
        msg_id_str = str(message_id) if message_id else None
        self.socketio.emit('download:deleted', {'message_id': msg_id_str})
        # Also emit updated stats
        self.emit_stats()

    def _update_prometheus_metrics(self):
        """Update Prometheus metrics from current database state"""
        db = get_db()
        all_downloads = db.get_all_downloads()

        # Count by status
        status_counts = {}
        author_status_counts = {}
        speed_by_source = {}
        total_speed = 0
        pending_bytes = 0
        active_count = 0

        for d in all_downloads:
            status = d.get('status', 'unknown')
            source = d.get('downloaded_from', 'unknown')
            author = d.get('author') or 'unknown'

            # Count by status
            status_counts[status] = status_counts.get(status, 0) + 1

            # Count by author + status
            key = (author, status)
            author_status_counts[key] = author_status_counts.get(key, 0) + 1

            # Active downloads speed
            if status == 'downloading':
                active_count += 1
                speed = d.get('speed', 0) or 0
                total_speed += speed
                speed_by_source[source] = speed_by_source.get(source, 0) + speed

                # Pending bytes
                total_bytes = d.get('total_bytes', 0) or 0
                downloaded_bytes = d.get('downloaded_bytes', 0) or 0
                pending_bytes += max(0, total_bytes - downloaded_bytes)

        # Update metrics
        metrics.update_db_stats(status_counts, author_status_counts)
        metrics.update_speed(total_speed, speed_by_source)
        metrics.update_pending_bytes(pending_bytes)
        metrics.update_queue_size(active_count)

    def _telegram_call(self, coro, timeout=60):
        """Run a coroutine on the Telegram client's event loop (lives in the
        main thread) and wait for its result."""
        td = self.telegram_downloader
        loop = getattr(td, 'loop', None) if td else None
        if loop is None:
            raise RuntimeError("Telegram client is not running yet")
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=timeout)

    def setup_routes(self):
        """Setup Flask API routes"""

        # Auth routes
        @self.app.route("/api/auth/login", methods=["POST"])
        def login():
            data = request.json
            username = data.get("username")
            password = data.get("password")

            if not username or not password:
                return jsonify({"error": "Username and password required"}), 400

            db = get_db()
            user = db.authenticate_user(username, password)

            if not user:
                return jsonify({"error": "Invalid credentials"}), 401

            # Generate JWT token
            token = jwt.encode({
                'user_id': user['id'],
                'username': user['username'],
                'exp': datetime.utcnow() + timedelta(days=JWT_EXPIRY_DAYS)
            }, JWT_SECRET, algorithm='HS256')

            return jsonify({
                "token": token,
                "user": user,
                "must_change_password": bool(user.get('must_change_password'))
            })

        @self.app.route("/api/auth/verify", methods=["GET"])
        @token_required
        def verify_token():
            return jsonify({
                "user": request.user,
                "must_change_password": bool(getattr(request, 'must_change_password', False))
            })

        @self.app.route("/api/auth/password", methods=["POST"])
        @token_required
        def update_password():
            data = request.json
            current_password = data.get("current_password")
            new_password = data.get("new_password")

            if not current_password or not new_password:
                return jsonify({"error": "Current and new password required"}), 400

            if new_password == 'admin':
                return jsonify({"error": "The default password 'admin' is not allowed"}), 400

            db = get_db()
            result = db.update_user_password(request.user['user_id'], current_password, new_password)

            if 'error' in result:
                return jsonify(result), 400

            return jsonify({"success": True})

        @self.app.route("/api/downloads", methods=["GET"])
        @token_required
        def get_downloads():
            search = request.args.get("search", "")
            filter_type = request.args.get("filter", "all")  # 'all' or 'active'
            sort_by = request.args.get("sort_by", "created_at")  # 'created_at', 'file', 'status', 'progress'
            sort_order = request.args.get("sort_order", "desc")  # 'asc' or 'desc'
            limit = request.args.get("limit", 30, type=int)
            offset = request.args.get("offset", 0, type=int)
            include_hidden = request.args.get("include_hidden", "false").lower() == "true"
            author = request.args.get("author", "").strip() or None
            return jsonify(self.get_downloads_data(search, filter_type, sort_by, sort_order, limit, offset,
                                                   author=author, include_hidden=include_hidden))

        @self.app.route("/api/authors", methods=["GET"])
        @token_required
        def get_authors():
            """Get distinct author values"""
            db = get_db()
            all_downloads = db.get_all_downloads()
            authors = sorted(set(d.get("author") for d in all_downloads if d.get("author")))
            return jsonify(authors)

        @self.app.route("/api/stats", methods=["GET"])
        @token_required
        def get_stats():
            return jsonify(self.get_stats())

        @self.app.route("/metrics", methods=["GET"])
        def prometheus_metrics():
            """Prometheus metrics endpoint (no auth required for scraping)"""
            # Update database stats before returning metrics
            self._update_prometheus_metrics()
            return Response(metrics.get_metrics(), mimetype=metrics.get_content_type())

        @self.app.route("/api/retry", methods=["POST"])
        @token_required
        def api_retry():
            data = request.json
            download_id = data.get("id")
            if download_id is not None:
                db = get_db()
                download = db.get_download_by_id(download_id)
                if download and download["status"] in ["failed", "stopped"]:
                    # VPS download - resume the SFTP transfer from where it stopped
                    if download.get("downloaded_from") == "vps" and self.vps_downloader:
                        self.vps_downloader.resume_download(download.get("message_id"))
                    # Check if it's a yt-dlp download (has URL)
                    elif download.get("url") and self.ytdlp_downloader and self.event_loop:
                        # Resume yt-dlp download (yt-dlp will continue from partial file)
                        message_id = download.get("message_id")
                        url = download.get("url")

                        # Extract custom title from filename (remove extension)
                        custom_title = None
                        if download.get("file"):
                            # Remove extension to get the title
                            filename = download["file"]
                            print(f"[Retry] filename from db: {filename}")
                            if '.' in filename:
                                custom_title = filename.rsplit('.', 1)[0]
                            else:
                                custom_title = filename
                            print(f"[Retry] custom_title extracted: {custom_title}")

                        # Update status but keep progress (yt-dlp will resume)
                        db.update_download_by_id(
                            download_id,
                            status='downloading',
                            speed=0,
                            error=None,
                            updated_at=datetime.utcnow()
                        )
                        self.emit_status(message_id, 'downloading')

                        # Start the download task (yt-dlp -c flag will resume)
                        future = asyncio.run_coroutine_threadsafe(
                            self.ytdlp_downloader.download(url, message_id, None, custom_title),
                            self.event_loop
                        )
                        self.download_tasks[message_id] = future
                    else:
                        # Telegram download - just update status (Telegram handler will pick it up)
                        db.update_download_by_id(
                            download_id,
                            status='downloading',
                            progress=0,
                            speed=0,
                            error=None,
                            updated_at=datetime.utcnow()
                        )
                        if download.get("message_id"):
                            self.emit_status(download["message_id"], 'downloading')
            return jsonify({"status": "ok"})

        @self.app.route("/api/stop", methods=["POST"])
        @token_required
        def api_stop():
            data = request.json
            message_id = data.get("message_id")  # Now always a string
            db = get_db()

            # Check if it's a yt-dlp download (UUID format) or Telegram (numeric string)
            is_uuid = message_id and '-' in message_id

            if is_uuid:
                # VPS and yt-dlp both use UUIDs - distinguish by source
                download = db.get_download_by_message_id(message_id)
                if download and download.get("downloaded_from") == "vps" and self.vps_downloader:
                    # Blocks until the transfer thread has actually exited
                    if not self.vps_downloader.stop_download(message_id):
                        return jsonify({"error": "Download did not stop in time"}), 500
                elif self.ytdlp_downloader:
                    # yt-dlp download - stop via ytdlp_downloader
                    self.ytdlp_downloader.stop_download(message_id)
                # Also try to cancel from download_tasks (yt-dlp futures)
                task = self.download_tasks.get(message_id)
                if task and hasattr(task, 'cancel'):
                    task.cancel()
            else:
                # Telegram download - convert to int for task lookup
                telegram_id = int(message_id) if message_id else None
                task = self.download_tasks.get(telegram_id)
                if task and not task.done():
                    task.cancel()
                # Update Telegram status message
                if self.telegram_downloader and telegram_id:
                    asyncio.run_coroutine_threadsafe(
                        self.telegram_downloader.update_status_message(telegram_id, "Stopped"),
                        self.telegram_downloader.loop
                    )

            # Update database status to stopped
            db.update_download_by_message_id(message_id, status='stopped', speed=0)
            self.emit_status(message_id, 'stopped')
            return jsonify({"status": "stopped"})

        @self.app.route("/api/pause", methods=["POST"])
        @token_required
        def api_pause():
            data = request.json
            message_id = data.get("message_id")
            db = get_db()

            is_uuid = message_id and '-' in message_id
            if is_uuid:
                return jsonify({"error": "Pause not supported for this download type"}), 400

            telegram_id = int(message_id) if message_id else None
            if self.telegram_downloader and telegram_id:
                self.telegram_downloader.pause_download(telegram_id)
                # Update Telegram status message to show paused
                asyncio.run_coroutine_threadsafe(
                    self.telegram_downloader.update_status_message(telegram_id, "Paused"),
                    self.telegram_downloader.loop
                )

            db.update_download_by_message_id(message_id, status='paused', speed=0, pending_time=None)
            self.emit_status(message_id, 'paused')
            return jsonify({"status": "paused"})

        @self.app.route("/api/resume", methods=["POST"])
        @token_required
        def api_resume():
            data = request.json
            message_id = data.get("message_id")
            db = get_db()

            is_uuid = message_id and '-' in message_id
            if is_uuid:
                return jsonify({"error": "Resume not supported for this download type"}), 400

            telegram_id = int(message_id) if message_id else None
            if self.telegram_downloader and telegram_id:
                future = asyncio.run_coroutine_threadsafe(
                    self.telegram_downloader.restart_download(telegram_id),
                    self.telegram_downloader.loop
                )
                try:
                    success = future.result(timeout=30)
                    if not success:
                        return jsonify({"error": "Failed to restart download from Telegram"}), 500
                except Exception as e:
                    return jsonify({"error": f"Failed to restart download: {str(e)}"}), 500

            db.update_download_by_message_id(message_id, status='downloading', speed=0)
            self.emit_status(message_id, 'downloading')
            return jsonify({"status": "downloading"})

        @self.app.route("/api/delete", methods=["POST"])
        @token_required
        def api_delete():
            data = request.json
            message_id = data.get("message_id")  # Now always a string
            delete_file = data.get("delete_file", False)
            db = get_db()

            # Check if it's a yt-dlp download (UUID format) or Telegram (numeric string)
            is_uuid = message_id and '-' in message_id

            if is_uuid:
                # VPS and yt-dlp both use UUIDs - distinguish by source
                download = db.get_download_by_message_id(message_id)
                if download and download.get("downloaded_from") == "vps" and self.vps_downloader:
                    # Wait for the transfer thread to fully exit so the partial
                    # file can't be re-created after it is deleted below
                    if not self.vps_downloader.stop_download(message_id):
                        return jsonify({"error": "Download did not stop in time"}), 500
                elif self.ytdlp_downloader:
                    # yt-dlp download - stop via ytdlp_downloader
                    self.ytdlp_downloader.stop_download(message_id)
                # Also try to cancel from download_tasks (yt-dlp futures)
                task = self.download_tasks.get(message_id)
                if task and hasattr(task, 'cancel'):
                    task.cancel()
                self.download_tasks.pop(message_id, None)
            else:
                # Telegram download - convert to int for task lookup
                telegram_id = int(message_id) if message_id else None
                task = self.download_tasks.get(telegram_id)
                if task and not task.done():
                    task.cancel()
                    db.update_download_by_message_id(message_id, status='stopped', speed=0)
                self.download_tasks.pop(telegram_id, None)

            # Delete the physical file if requested
            if delete_file:
                download = db.get_download_by_message_id(message_id)
                if download and download.get("file"):
                    file_name = download["file"]
                    possible_paths = candidate_file_paths(download, file_name)

                    import shutil
                    for file_path in possible_paths:
                        if file_path.exists() or file_path.is_symlink():
                            try:
                                if file_path.is_dir() and not file_path.is_symlink():
                                    # VPS folder downloads land as a directory
                                    shutil.rmtree(file_path)
                                else:
                                    file_path.unlink()
                            except OSError as e:
                                print(f"[Delete] Failed to delete {file_path}: {e}")
                            break

            # Delete thumbnails (uses download id for folder name)
            from backend.file_meta import delete_thumbnails
            dl_for_thumbs = db.get_download_by_message_id(message_id)
            if dl_for_thumbs and dl_for_thumbs.get('id'):
                delete_thumbnails(dl_for_thumbs['id'])

            # Soft delete from database
            db.delete_download_by_message_id(message_id)
            self.emit_deleted(message_id)
            return jsonify({"status": "deleted"})

        @self.app.route("/api/url/check", methods=["POST"])
        @token_required
        def api_check_url():
            """Check if a URL is supported by yt-dlp"""
            data = request.json
            url = data.get("url")

            if not url:
                return jsonify({"error": "URL is required"}), 400

            if not self.ytdlp_downloader:
                return jsonify({"error": "yt-dlp downloader not available"}), 500

            result = self.ytdlp_downloader.check_url(url)
            return jsonify(result)

        @self.app.route("/api/url/download", methods=["POST"])
        @token_required
        def api_download_url():
            """Start a download from URL using yt-dlp"""
            data = request.json
            url = data.get("url")
            format_id = data.get("format_id")
            title = data.get("title")
            ext = data.get("ext")
            filesize = data.get("filesize")
            resolution = data.get("resolution")

            if not url:
                return jsonify({"error": "URL is required"}), 400

            if not self.ytdlp_downloader:
                return jsonify({"error": "yt-dlp downloader not available"}), 500

            if not self.event_loop:
                return jsonify({"error": "Event loop not available"}), 500

            # Get the logged-in user's username as the author
            author = request.user.get('username') if hasattr(request, 'user') else None

            result = self.ytdlp_downloader.start_download(
                url, self.event_loop,
                format_id=format_id,
                title=title,
                ext=ext,
                filesize=filesize,
                resolution=resolution,
                author=author,
            )

            if 'error' in result:
                return jsonify(result), 400

            return jsonify(result)

        # --- Per-source download specs (mappings) ---
        @self.app.route("/api/mappings", methods=["GET"])
        @token_required
        def get_mappings():
            """All per-source download specs."""
            return jsonify(get_db().get_all_download_type_maps())

        @self.app.route("/api/mappings", methods=["POST"])
        @token_required
        def add_mapping():
            """Create a source spec. Body: {downloaded_from, folder?, quality?, is_secured?}."""
            data = request.json or {}
            source = (data.get("downloaded_from") or "").strip().lower()
            if not source:
                return jsonify({"error": "downloaded_from is required"}), 400
            result = get_db().add_download_type_map(
                source,
                is_secured=bool(data.get("is_secured", False)),
                folder=(data.get("folder") or None),
                quality=(data.get("quality") or None),
            )
            if isinstance(result, dict) and result.get("error"):
                return jsonify(result), 400
            return jsonify(result)

        @self.app.route("/api/mappings/<int:map_id>", methods=["PUT"])
        @token_required
        def update_mapping(map_id):
            """Update a source spec. Body may include downloaded_from/folder/quality/is_secured."""
            data = request.json or {}
            update = {}
            for key in ("downloaded_from", "folder", "quality", "is_secured"):
                if key in data:
                    update[key] = data[key]
            result = get_db().update_download_type_map(map_id, **update)
            if isinstance(result, dict) and result.get("error"):
                return jsonify(result), 400
            return jsonify(result)

        @self.app.route("/api/mappings/<int:map_id>", methods=["DELETE"])
        @token_required
        def delete_mapping(map_id):
            """Delete a source spec."""
            if not get_db().delete_download_type_map(map_id):
                return jsonify({"error": "Mapping not found"}), 404
            return jsonify({"status": "deleted"})

        # Analytics API
        @self.app.route("/api/analytics", methods=["GET"])
        @token_required
        def get_analytics():
            """Get download analytics data for charts"""
            db = get_db()
            include_deleted = request.args.get("include_deleted", "false").lower() == "true"
            all_downloads = db.get_all_downloads(include_deleted=include_deleted)

            # Get date range from query params (default: last 30 days, 0 = all time)
            days = int(request.args.get("days", 30))
            group_by = request.args.get("group_by", "day")  # 'day' or 'hour'

            from datetime import datetime, timedelta
            from collections import defaultdict

            now = datetime.utcnow()
            cutoff = now - timedelta(days=days) if days > 0 else None

            # Filter downloads within date range
            recent_downloads = []
            for d in all_downloads:
                created = d.get("created_at")
                if created:
                    try:
                        dt = datetime.fromisoformat(created.replace('Z', '+00:00')) if isinstance(created, str) else created
                        dt_naive = dt.replace(tzinfo=None)
                        if cutoff is None or dt_naive >= cutoff:
                            recent_downloads.append({**d, '_dt': dt_naive})
                    except:
                        pass

            # Group by time period
            downloads_by_time = defaultdict(lambda: {'count': 0, 'size': 0})
            downloads_by_source = defaultdict(lambda: {'count': 0, 'size': 0})
            downloads_by_author = defaultdict(lambda: {'count': 0, 'size': 0})
            downloads_by_status = defaultdict(int)
            hourly_distribution = defaultdict(int)  # Downloads by hour of day (0-23)

            for d in recent_downloads:
                dt = d['_dt']
                source = d.get('downloaded_from', 'unknown')
                status = d.get('status', 'unknown')
                size = d.get('total_bytes', 0) or 0

                # Group by day or hour
                if group_by == 'hour':
                    key = dt.strftime('%Y-%m-%d %H:00')
                else:
                    key = dt.strftime('%Y-%m-%d')

                downloads_by_time[key]['count'] += 1
                downloads_by_time[key]['size'] += size

                # By source
                downloads_by_source[source]['count'] += 1
                downloads_by_source[source]['size'] += size

                # By author
                author = d.get('author') or 'unknown'
                downloads_by_author[author]['count'] += 1
                downloads_by_author[author]['size'] += size

                # By status
                downloads_by_status[status] += 1

                # Hourly distribution (regardless of date)
                hourly_distribution[dt.hour] += 1

            # Convert to sorted lists for charts
            time_labels = sorted(downloads_by_time.keys())
            time_data = [
                {
                    'label': label,
                    'count': downloads_by_time[label]['count'],
                    'size': downloads_by_time[label]['size']
                }
                for label in time_labels
            ]

            # Fill in missing dates/hours
            if group_by == 'day' and time_labels:
                filled_data = []
                if cutoff is not None:
                    start_date = cutoff.date()
                else:
                    start_date = datetime.strptime(time_labels[0], '%Y-%m-%d').date()
                end = now.date()
                current = start_date
                while current <= end:
                    key = current.strftime('%Y-%m-%d')
                    if key in downloads_by_time:
                        filled_data.append({
                            'label': key,
                            'count': downloads_by_time[key]['count'],
                            'size': downloads_by_time[key]['size']
                        })
                    else:
                        filled_data.append({'label': key, 'count': 0, 'size': 0})
                    current += timedelta(days=1)
                time_data = filled_data

            # Sort sources by count
            source_data = [
                {'source': source, 'count': data['count'], 'size': data['size']}
                for source, data in sorted(downloads_by_source.items(), key=lambda x: -x[1]['count'])
            ]

            # Hourly distribution (0-23)
            hourly_data = [
                {'hour': h, 'count': hourly_distribution.get(h, 0)}
                for h in range(24)
            ]

            # Sort authors by count
            author_data = [
                {'author': author, 'count': data['count'], 'size': data['size']}
                for author, data in sorted(downloads_by_author.items(), key=lambda x: -x[1]['count'])
            ]

            # Summary stats
            total_downloads = len(recent_downloads)
            total_size = sum(d.get('total_bytes', 0) or 0 for d in recent_downloads)
            completed = sum(1 for d in recent_downloads if d.get('status') == 'done')
            failed = sum(1 for d in recent_downloads if d.get('status') == 'failed')

            return jsonify({
                'time_series': time_data,
                'by_source': source_data,
                'by_author': author_data,
                'by_status': dict(downloads_by_status),
                'hourly_distribution': hourly_data,
                'summary': {
                    'total_downloads': total_downloads,
                    'total_size': total_size,
                    'completed': completed,
                    'failed': failed,
                    'success_rate': round(completed / total_downloads * 100, 1) if total_downloads > 0 else 0
                },
                'period_days': days,
                'group_by': group_by
            })

        # Cookies API for yt-dlp authentication
        @self.app.route("/api/settings/cookies", methods=["GET"])
        @token_required
        def get_cookies():
            """Get current cookies content"""
            cookies_path = Path(__file__).parent.parent.parent / 'cookies.txt'
            if cookies_path.exists():
                return jsonify({"cookies": cookies_path.read_text()})
            return jsonify({"cookies": ""})

        @self.app.route("/api/settings/cookies", methods=["POST"])
        @token_required
        def save_cookies():
            """Save cookies content"""
            data = request.json
            cookies_content = data.get("cookies", "")
            cookies_path = Path(__file__).parent.parent.parent / 'cookies.txt'

            try:
                if cookies_content.strip():
                    cookies_path.write_text(cookies_content)
                else:
                    # Delete file if empty
                    if cookies_path.exists():
                        cookies_path.unlink()
                return jsonify({"status": "saved"})
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        # Telegram API credentials (api_id/api_hash from my.telegram.org)
        @self.app.route("/api/settings/telegram/api", methods=["GET"])
        @token_required
        def get_telegram_api():
            """Current API credential state (hash never exposed)."""
            if not self.telegram_downloader:
                return jsonify({"configured": False, "api_id": None, "has_hash": False, "source": None})
            return jsonify(self.telegram_downloader.get_api_config())

        @self.app.route("/api/settings/telegram/api", methods=["POST"])
        @token_required
        def save_telegram_api():
            """Save API credentials; a blank api_hash keeps the saved one.
            The client is swapped live — no service restart needed."""
            data = request.json or {}
            try:
                api_id = int(data.get("api_id") or 0)
            except (TypeError, ValueError):
                return jsonify({"error": "API ID must be a number"}), 400
            if not api_id:
                return jsonify({"error": "API ID is required"}), 400
            api_hash = (data.get("api_hash") or "").strip()
            try:
                result = self._telegram_call(
                    self.telegram_downloader.set_api_credentials(api_id, api_hash))
                if result.get("error"):
                    return jsonify(result), 400
                return jsonify(result)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        # Telegram account connection & monitored channels
        @self.app.route("/api/settings/telegram/status", methods=["GET"])
        @token_required
        def telegram_status():
            """Connection/authorization status + monitored channels."""
            try:
                status = self._telegram_call(self.telegram_downloader.get_status(), timeout=20)
            except Exception as e:
                return jsonify({
                    "connected": False, "authorized": False,
                    "awaiting_code": False, "user": None,
                    "channels": [], "error": str(e),
                })
            status["channels"] = self.telegram_downloader.get_channels()
            return jsonify(status)

        @self.app.route("/api/settings/telegram/send-code", methods=["POST"])
        @token_required
        def telegram_send_code():
            """Step 1 of web login: send the code to the phone number."""
            phone = ((request.json or {}).get("phone") or "").strip()
            if not phone:
                return jsonify({"error": "Phone number is required"}), 400
            try:
                return jsonify(self._telegram_call(self.telegram_downloader.send_login_code(phone)))
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/verify-code", methods=["POST"])
        @token_required
        def telegram_verify_code():
            """Step 2 of web login: verify the received code."""
            code = ((request.json or {}).get("code") or "").strip().replace(" ", "")
            if not code:
                return jsonify({"error": "Code is required"}), 400
            try:
                result = self._telegram_call(self.telegram_downloader.submit_login_code(code))
                if result.get("error"):
                    return jsonify(result), 400
                return jsonify(result)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/verify-password", methods=["POST"])
        @token_required
        def telegram_verify_password():
            """Step 3 of web login (accounts with 2FA): the cloud password."""
            password = (request.json or {}).get("password") or ""
            if not password:
                return jsonify({"error": "Password is required"}), 400
            try:
                return jsonify(self._telegram_call(self.telegram_downloader.submit_password(password)))
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/bot-login", methods=["POST"])
        @token_required
        def telegram_bot_login():
            """Alternative login: sign in with a BotFather bot token."""
            token = ((request.json or {}).get("token") or "").strip()
            if not token:
                return jsonify({"error": "Bot token is required"}), 400
            try:
                result = self._telegram_call(self.telegram_downloader.submit_bot_token(token))
                if result.get("error"):
                    return jsonify(result), 400
                return jsonify(result)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/logout", methods=["POST"])
        @token_required
        def telegram_logout():
            """Invalidate the Telegram session; a new web login is required."""
            try:
                return jsonify(self._telegram_call(self.telegram_downloader.logout()))
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/channels", methods=["GET"])
        @token_required
        def telegram_channels():
            return jsonify({"channels": self.telegram_downloader.get_channels()
                            if self.telegram_downloader else []})

        @self.app.route("/api/settings/telegram/channels", methods=["POST"])
        @token_required
        def telegram_add_channel():
            """Add a channel by @username, t.me link, or numeric chat ID."""
            identifier = ((request.json or {}).get("chat") or "").strip()
            if not identifier:
                return jsonify({"error": "Channel username or ID is required"}), 400
            try:
                result = self._telegram_call(self.telegram_downloader.add_channel(identifier))
                if result.get("error"):
                    return jsonify(result), 400
                return jsonify(result)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/channels/<chat_id>", methods=["DELETE"])
        @token_required
        def telegram_remove_channel(chat_id):
            # Plain converter: Telegram channel IDs are negative, <int:> won't match
            try:
                chat_id = int(chat_id)
            except ValueError:
                return jsonify({"error": "Invalid chat ID"}), 400
            try:
                return jsonify(self._telegram_call(self.telegram_downloader.remove_channel(chat_id)))
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/dialogs", methods=["GET"])
        @token_required
        def telegram_dialogs():
            """List the account's channels/groups for the channel picker."""
            try:
                return jsonify({"dialogs": self._telegram_call(self.telegram_downloader.list_dialogs())})
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        # Users (web logins + Telegram users who interacted with the bot)
        @self.app.route("/api/users", methods=["GET"])
        @token_required
        def list_users():
            return jsonify({"users": get_db().get_users()})

        @self.app.route("/api/users/sync", methods=["POST"])
        @token_required
        def sync_users():
            """Pull the member lists of all monitored groups into the users table."""
            try:
                synced = self._telegram_call(
                    self.telegram_downloader.sync_channel_members(), timeout=120)
                return jsonify({"synced": synced, "users": get_db().get_users()})
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/users/<int:user_id>", methods=["PATCH"])
        @token_required
        def update_user(user_id):
            """Change a user's role (admin/user). Web-login users stay admin."""
            role = ((request.json or {}).get("role") or "").strip().lower()
            if role not in ("admin", "user"):
                return jsonify({"error": "Role must be 'admin' or 'user'"}), 400
            db = get_db()
            target = next((u for u in db.get_users() if u["id"] == user_id), None)
            if not target:
                return jsonify({"error": "User not found"}), 404
            if target.get("is_web") and role != "admin":
                return jsonify({"error": "Web login users are always admins"}), 400
            updated = db.update_user_role(user_id, role)
            return jsonify({"user": updated})

        # Bot queries (key -> shell snippet, triggered by tagging the bot)
        @self.app.route("/api/settings/queries", methods=["GET"])
        @token_required
        def get_bot_queries():
            return jsonify({"queries": self.telegram_downloader.get_queries()
                            if self.telegram_downloader else []})

        @self.app.route("/api/settings/queries", methods=["POST"])
        @token_required
        def save_bot_query():
            """Add or update a query (upsert by key; original_key supports renames)."""
            data = request.json or {}
            key = (data.get("key") or "").strip().lower()
            command = (data.get("command") or "").strip()
            original_key = (data.get("original_key") or key).strip().lower()
            if not key or not command:
                return jsonify({"error": "Key and command are required"}), 400
            if ' ' in key or len(key) > 64:
                return jsonify({"error": "Key must be a single word (max 64 chars)"}), 400
            if key == 'help':
                return jsonify({"error": "'help' is reserved for listing the available queries"}), 400
            db = get_db()
            db.upsert_bot_query(key, command, original_key=original_key)
            return jsonify({"queries": db.get_bot_queries()})

        @self.app.route("/api/settings/queries/<key>", methods=["DELETE"])
        @token_required
        def delete_bot_query(key):
            db = get_db()
            db.delete_bot_query(key)
            return jsonify({"queries": db.get_bot_queries()})

        @self.app.route("/api/settings/queries/test", methods=["POST"])
        @token_required
        def test_bot_query():
            """Run a snippet now and return its output (same env as chat triggers)."""
            command = ((request.json or {}).get("command") or "").strip()
            if not command:
                return jsonify({"error": "Command is required"}), 400
            from backend.telegram_handler import TelegramDownloader
            # Stand in for the chat sender with the logged-in web user
            username = (getattr(request, 'user', None) or {}).get('username', 'admin')
            extra_env = {'SENDER_NAME': username, 'SENDER_USERNAME': username, 'SENDER_ID': '', 'CHAT_TITLE': ''}
            return jsonify({"output": TelegramDownloader.run_query_sync(command, extra_env)})

        # VPS (SSH/SFTP) connection settings
        @self.app.route("/api/settings/vps", methods=["GET"])
        @token_required
        def get_vps_config():
            """Return the saved VPS connection config (password never exposed)."""
            from backend.utils import decrypt_secret
            db = get_db()
            raw = db.get_setting("vps_config")
            if not raw:
                return jsonify({
                    "configured": False, "host": "", "port": 22,
                    "username": "", "remote_path": "", "has_password": False,
                })
            try:
                cfg = json.loads(raw)
            except Exception:
                cfg = {}
            has_password = bool(decrypt_secret(cfg.get("password_enc", "")))
            return jsonify({
                "configured": bool(cfg.get("host")),
                "host": cfg.get("host", ""),
                "port": cfg.get("port", 22),
                "username": cfg.get("username", ""),
                "remote_path": cfg.get("remote_path", ""),
                "has_password": has_password,
            })

        @self.app.route("/api/settings/vps", methods=["POST"])
        @token_required
        def save_vps_config():
            """Save VPS connection config. Password is encrypted at rest.

            If the password field is omitted/blank, the previously saved
            password is preserved.
            """
            from backend.utils import encrypt_secret, decrypt_secret
            data = request.json or {}
            host = (data.get("host") or "").strip()
            username = (data.get("username") or "").strip()
            if not host or not username:
                return jsonify({"error": "Host and username are required"}), 400
            try:
                port = int(data.get("port") or 22)
            except (TypeError, ValueError):
                return jsonify({"error": "Port must be a number"}), 400

            db = get_db()
            # Preserve existing password if a new one wasn't provided
            password = data.get("password")
            if password:
                password_enc = encrypt_secret(password)
            else:
                prev = db.get_setting("vps_config")
                password_enc = ""
                if prev:
                    try:
                        password_enc = json.loads(prev).get("password_enc", "")
                    except Exception:
                        password_enc = ""

            cfg = {
                "host": host,
                "port": port,
                "username": username,
                "remote_path": (data.get("remote_path") or "").strip(),
                "password_enc": password_enc,
            }
            db.set_setting("vps_config", json.dumps(cfg))
            return jsonify({
                "status": "saved",
                "configured": True,
                "has_password": bool(decrypt_secret(password_enc)),
            })

        @self.app.route("/api/settings/vps", methods=["DELETE"])
        @token_required
        def delete_vps_config():
            """Remove the saved VPS connection (credentials). Watched folders are kept."""
            get_db().delete_setting("vps_config")
            return jsonify({"status": "deleted", "configured": False})

        @self.app.route("/api/settings/vps/test", methods=["POST"])
        @token_required
        def test_vps_connection():
            """Test an SSH connection. Uses posted form values, falling back
            to the saved password when the password field is blank."""
            from backend.utils import decrypt_secret
            import paramiko

            data = request.json or {}
            host = (data.get("host") or "").strip()
            username = (data.get("username") or "").strip()
            remote_path = (data.get("remote_path") or "").strip()
            try:
                port = int(data.get("port") or 22)
            except (TypeError, ValueError):
                return jsonify({"success": False, "error": "Port must be a number"}), 400

            if not host or not username:
                return jsonify({"success": False, "error": "Host and username are required"}), 400

            password = data.get("password")
            if not password:
                # Fall back to the saved password
                raw = get_db().get_setting("vps_config")
                if raw:
                    try:
                        password = decrypt_secret(json.loads(raw).get("password_enc", ""))
                    except Exception:
                        password = ""
            if not password:
                return jsonify({"success": False, "error": "No password provided or saved"}), 400

            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                client.connect(
                    hostname=host, port=port, username=username,
                    password=password, timeout=10, allow_agent=False, look_for_keys=False,
                )
                message = f"Connected to {host}:{port} as {username}"
                # If a watch folder is set, confirm it's reachable/listable
                if remote_path:
                    sftp = client.open_sftp()
                    try:
                        entries = sftp.listdir(remote_path)
                        message += f" — {len(entries)} item(s) in {remote_path}"
                    except Exception as e:
                        sftp.close()
                        return jsonify({
                            "success": False,
                            "error": f"Connected, but cannot access '{remote_path}': {e}",
                        })
                    sftp.close()
                return jsonify({"success": True, "message": message})
            except paramiko.AuthenticationException:
                return jsonify({"success": False, "error": "Authentication failed — check username/password"})
            except Exception as e:
                return jsonify({"success": False, "error": str(e)})
            finally:
                client.close()

        # Torrent client (Transmission) settings + magnet handoff
        @self.app.route("/api/settings/torrent", methods=["GET"])
        @token_required
        def get_torrent_config():
            """Return the saved torrent client config (password never exposed)."""
            from backend.utils import decrypt_secret
            raw = get_db().get_setting("torrent_config")
            if not raw:
                return jsonify({"configured": False, "url": "", "username": "", "has_password": False, "incomplete_dir": ""})
            try:
                cfg = json.loads(raw)
            except Exception:
                cfg = {}
            return jsonify({
                "configured": bool(cfg.get("url")),
                "url": cfg.get("url", ""),
                "username": cfg.get("username", ""),
                "has_password": bool(decrypt_secret(cfg.get("password_enc", ""))),
                "incomplete_dir": cfg.get("incomplete_dir", ""),
            })

        @self.app.route("/api/settings/torrent", methods=["POST"])
        @token_required
        def save_torrent_config():
            """Save the torrent client config. Password is encrypted at rest;
            if omitted/blank, the previously saved password is preserved."""
            from backend.utils import encrypt_secret, decrypt_secret
            data = request.json or {}
            url = normalize_transmission_url(data.get("url") or "")
            if not url.startswith(("http://", "https://")):
                return jsonify({"error": "A valid http(s) URL is required"}), 400

            db = get_db()
            password = data.get("password")
            if password:
                password_enc = encrypt_secret(password)
            else:
                prev = db.get_setting("torrent_config")
                password_enc = ""
                if prev:
                    try:
                        password_enc = json.loads(prev).get("password_enc", "")
                    except Exception:
                        password_enc = ""

            incomplete_dir = (data.get("incomplete_dir") or "").strip()
            cfg = {
                "url": url,
                "username": (data.get("username") or "").strip(),
                "password_enc": password_enc,
                "incomplete_dir": incomplete_dir,
            }
            db.set_setting("torrent_config", json.dumps(cfg))

            # Push the incomplete (temp) dir to Transmission immediately so it
            # takes effect for the whole instance. Best-effort: a save still
            # succeeds if Transmission is unreachable — it is re-applied on add.
            warning = None
            try:
                apply_torrent_session({
                    "url": url,
                    "username": cfg["username"],
                    "password": decrypt_secret(password_enc),
                    "incomplete_dir": incomplete_dir,
                })
            except ValueError as e:
                warning = f"Saved, but could not apply temp folder to Transmission: {e}"

            return jsonify({
                "status": "saved",
                "configured": True,
                "url": url,
                "has_password": bool(decrypt_secret(password_enc)),
                "incomplete_dir": incomplete_dir,
                "warning": warning,
            })

        @self.app.route("/api/settings/torrent", methods=["DELETE"])
        @token_required
        def delete_torrent_config():
            """Remove the saved torrent client config."""
            get_db().delete_setting("torrent_config")
            return jsonify({"status": "deleted", "configured": False})

        @self.app.route("/api/settings/torrent/test", methods=["POST"])
        @token_required
        def test_torrent_connection():
            """Test the Transmission connection. Uses posted form values,
            falling back to the saved password when the password field is blank."""
            from backend.utils import decrypt_secret
            data = request.json or {}
            url = normalize_transmission_url(data.get("url") or "")
            if not url.startswith(("http://", "https://")):
                return jsonify({"success": False, "error": "A valid http(s) URL is required"}), 400
            password = data.get("password")
            if not password:
                raw = get_db().get_setting("torrent_config")
                if raw:
                    try:
                        password = decrypt_secret(json.loads(raw).get("password_enc", ""))
                    except Exception:
                        password = ""
            cfg = {"url": url, "username": (data.get("username") or "").strip(), "password": password or ""}
            try:
                session = transmission_rpc("session-get", config=cfg)
                version = session.get("version", "unknown version")
                return jsonify({"success": True, "message": f"Connected to Transmission {version}"})
            except ValueError as e:
                return jsonify({"success": False, "error": str(e)})

        @self.app.route("/api/torrent/add", methods=["POST"])
        @token_required
        def add_torrent():
            """Send a magnet link to the VPS torrent client.
            Body: {magnet, download_dir?} — download_dir is a remote path
            (e.g. a watched folder, so autoSync picks up the result)."""
            data = request.json or {}
            magnet = (data.get("magnet") or "").strip()
            if not magnet.lower().startswith("magnet:"):
                return jsonify({"error": "Not a magnet link"}), 400
            args = {"filename": magnet}
            download_dir = (data.get("download_dir") or "").strip()
            if download_dir:
                args["download-dir"] = download_dir
            cfg = load_torrent_config()
            try:
                # Ensure the temp folder is in effect (survives Transmission restarts)
                if cfg and cfg.get("incomplete_dir"):
                    apply_torrent_session(cfg)
                result = transmission_rpc("torrent-add", args, config=cfg)
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            added = result.get("torrent-added")
            duplicate = result.get("torrent-duplicate")
            torrent = added or duplicate or {}
            return jsonify({
                "status": "duplicate" if duplicate else "added",
                "name": torrent.get("name"),
                "hash": torrent.get("hashString"),
                "download_dir": download_dir or None,
            })

        @self.app.route("/api/torrent/list", methods=["GET"])
        @token_required
        def list_torrents():
            """List the torrents currently known to the VPS Transmission, with
            live download status. Returns {configured, torrents:[...]}."""
            # Transmission status codes -> readable labels
            STATUS_LABELS = {
                0: "stopped", 1: "check-wait", 2: "checking",
                3: "download-wait", 4: "downloading", 5: "seed-wait", 6: "seeding",
            }
            if not load_torrent_config():
                return jsonify({"configured": False, "torrents": []})
            fields = [
                "id", "name", "hashString", "status", "percentDone",
                "rateDownload", "rateUpload", "totalSize", "eta",
                "downloadDir", "errorString",
            ]
            try:
                result = transmission_rpc("torrent-get", {"fields": fields})
            except ValueError as e:
                return jsonify({"configured": True, "error": str(e)}), 502
            torrents = []
            for t in result.get("torrents", []):
                eta = t.get("eta")
                torrents.append({
                    "id": t.get("id"),
                    "name": t.get("name"),
                    "hash": t.get("hashString"),
                    "status": STATUS_LABELS.get(t.get("status"), "unknown"),
                    "percent_done": round((t.get("percentDone") or 0) * 100, 1),
                    "rate_download": t.get("rateDownload") or 0,
                    "rate_upload": t.get("rateUpload") or 0,
                    "total_size": t.get("totalSize") or 0,
                    "eta": eta if isinstance(eta, int) and eta >= 0 else None,
                    "download_dir": t.get("downloadDir"),
                    "error": t.get("errorString") or None,
                })
            return jsonify({"configured": True, "torrents": torrents})

        @self.app.route("/api/torrent/action", methods=["POST"])
        @token_required
        def torrent_action():
            """Control a torrent on the VPS Transmission.
            Body: {action: start|stop|remove, ids: [int], delete_data?: bool}.
            'stop' covers pause; 'remove' deletes the torrent (and its data on
            the VPS when delete_data is true)."""
            data = request.json or {}
            action = (data.get("action") or "").strip()
            ids = data.get("ids")
            if not isinstance(ids, list) or not ids:
                return jsonify({"error": "ids must be a non-empty list"}), 400
            method_map = {
                "start": "torrent-start",
                "stop": "torrent-stop",
                "remove": "torrent-remove",
            }
            method = method_map.get(action)
            if not method:
                return jsonify({"error": f"Unknown action: {action}"}), 400
            args = {"ids": ids}
            if action == "remove" and data.get("delete_data"):
                args["delete-local-data"] = True
            try:
                transmission_rpc(method, args)
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            return jsonify({"status": "ok", "action": action, "ids": ids})

        @self.app.route("/api/settings/vps/browse", methods=["POST"])
        @token_required
        def browse_vps():
            """List the contents of a remote directory over SFTP (on demand).

            Body: {path?} — absolute path to list; defaults to the login home.
            Returns {path, parent, entries:[{name, path, is_dir}]} with
            directories first. Uses the saved VPS credentials.
            """
            import stat as stat_module
            import posixpath
            data = request.json or {}
            req_path = (data.get("path") or "").strip()

            client = None
            try:
                client, sftp = open_vps_sftp()
                # Resolve target path (default to login home directory)
                path = sftp.normalize(req_path) if req_path else sftp.normalize(".")
                entries = []
                for attr in sftp.listdir_attr(path):
                    name = attr.filename
                    if name in (".", ".."):
                        continue
                    is_dir = stat_module.S_ISDIR(attr.st_mode)
                    entries.append({
                        "name": name,
                        "path": posixpath.join(path, name),
                        "is_dir": is_dir,
                    })
                entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
                parent = posixpath.dirname(path.rstrip("/")) or "/"
                return jsonify({
                    "path": path,
                    "parent": None if path in ("/", "") else parent,
                    "entries": entries,
                })
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            except Exception as e:
                return jsonify({"error": str(e)}), 500
            finally:
                if client:
                    client.close()

        @self.app.route("/api/settings/local/browse", methods=["POST"])
        @token_required
        def browse_local():
            """List the contents of a local directory on the home server (on demand).

            Body: {path?} — absolute path to list; defaults to DOWNLOAD_DIR.
            Returns {path, parent, entries:[{name, path, is_dir}]} with
            directories first. Used by the folder picker (e.g. destination folders).
            """
            from backend.config import DOWNLOAD_DIR
            data = request.json or {}
            req_path = (data.get("path") or "").strip()

            try:
                target = Path(req_path).expanduser() if req_path else Path(DOWNLOAD_DIR)
                target = target.resolve()
                if not target.is_dir():
                    return jsonify({"error": "Not a directory"}), 400

                entries = []
                with os.scandir(target) as it:
                    for de in it:
                        try:
                            is_dir = de.is_dir(follow_symlinks=True)
                        except OSError:
                            is_dir = False
                        entries.append({
                            "name": de.name,
                            "path": str(target / de.name),
                            "is_dir": is_dir,
                        })
                entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
                parent = str(target.parent)
                return jsonify({
                    "path": str(target),
                    "parent": None if target.parent == target else parent,
                    "entries": entries,
                })
            except PermissionError:
                return jsonify({"error": "Permission denied"}), 403
            except FileNotFoundError:
                return jsonify({"error": "Path not found"}), 404
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        @self.app.route("/api/settings/vps/folders", methods=["GET"])
        @token_required
        def get_vps_folders():
            """List the watched VPS folders, tagged active for the current connection."""
            return jsonify({"folders": annotate_vps_folders(get_db().get_vps_watch_folders())})

        @self.app.route("/api/settings/vps/folders", methods=["POST"])
        @token_required
        def add_vps_folders():
            """Add one or more watched folders for the currently saved connection.
            Body: {paths: [...]} or {path}."""
            data = request.json or {}
            creds = load_vps_credentials()
            if not creds:
                return jsonify({"error": "Configure and save a VPS connection first"}), 400
            paths = data.get("paths")
            if paths is None and data.get("path"):
                paths = [data.get("path")]
            if not paths or not isinstance(paths, list):
                return jsonify({"error": "Provide 'paths' (list) or 'path'"}), 400
            db = get_db()
            added = []
            for p in paths:
                p = (p or "").strip()
                if p:
                    added.append(db.add_vps_watch_folder(
                        p, host=creds["host"], port=creds["port"], username=creds["username"],
                    ))
            return jsonify({"folders": annotate_vps_folders(db.get_vps_watch_folders()), "added": added})

        @self.app.route("/api/settings/vps/folders/<int:folder_id>", methods=["DELETE"])
        @token_required
        def delete_vps_folder(folder_id):
            """Remove a watched folder by id."""
            db = get_db()
            folder = next((f for f in db.get_vps_watch_folders() if f["id"] == folder_id), None)
            ok = db.delete_vps_watch_folder(folder_id)
            if not ok:
                return jsonify({"error": "Folder not found"}), 404
            if folder and self.vps_downloader:
                self.vps_downloader.forget_folder(folder["path"])
            return jsonify({"status": "deleted", "folders": annotate_vps_folders(db.get_vps_watch_folders())})

        @self.app.route("/api/settings/vps/folders/<int:folder_id>", methods=["PATCH"])
        @token_required
        def update_vps_folder(folder_id):
            """Update a watched folder's specs. Body: {auto_sync?, folder?, is_secured?}."""
            data = request.json or {}
            update = {k: data[k] for k in ("auto_sync", "folder", "is_secured") if k in data}
            if not update:
                return jsonify({"error": "Nothing to update"}), 400
            db = get_db()
            updated = db.update_vps_watch_folder(folder_id, **update)
            if not updated:
                return jsonify({"error": "Folder not found"}), 404
            # Snapshot current files as baseline when enabling autoSync so only new files sync
            if "auto_sync" in update and self.vps_downloader:
                if updated["auto_sync"]:
                    self.vps_downloader.snapshot_folder(updated["path"])
                else:
                    self.vps_downloader.forget_folder(updated["path"])
            return jsonify({"folder": updated, "folders": annotate_vps_folders(db.get_vps_watch_folders())})

        @self.app.route("/api/vps/files", methods=["GET"])
        @token_required
        def list_vps_files():
            """List live contents (non-recursive) of every watched folder over SFTP.

            Returns {folders:[{path, error?, entries:[{name, path, folder, is_dir,
            size, modified, downloaded, message_id?, status?}]}]}.
            """
            import stat as stat_module
            db = get_db()
            include_hidden = request.args.get("include_hidden", "false").lower() == "true"
            watch_folders = annotate_vps_folders(db.get_vps_watch_folders())
            if not include_hidden:
                watch_folders = [wf for wf in watch_folders if not wf.get("is_secured")]
            # Map existing VPS downloads by remote path for live status
            existing = {}
            for d in db.get_all_downloads():
                if d.get("downloaded_from") == "vps" and d.get("url"):
                    existing[d["url"]] = d

            if not watch_folders:
                return jsonify({"folders": []})

            # Active folders (current connection) are fetched & shown first;
            # inactive ones (other VPS connections) are listed but not fetched.
            active_groups = []
            inactive_groups = []
            for wf in watch_folders:
                base = {
                    "path": wf["path"], "auto_sync": wf.get("auto_sync", False),
                    "active": wf.get("active", False), "host": wf.get("host"),
                    "username": wf.get("username"), "entries": [],
                }
                if wf.get("active"):
                    active_groups.append((wf, base))
                else:
                    base["error"] = "Belongs to a different VPS connection"
                    inactive_groups.append(base)

            if not active_groups:
                return jsonify({"folders": inactive_groups})

            client = None
            try:
                client, sftp = open_vps_sftp()
                for wf, group in active_groups:
                    path = wf["path"]
                    try:
                        for attr in sftp.listdir_attr(path):
                            name = attr.filename
                            if name in (".", ".."):
                                continue
                            is_dir = stat_module.S_ISDIR(attr.st_mode)
                            full = posixpath.join(path, name)
                            entry = {
                                "name": name,
                                "path": full,
                                "folder": path,
                                "is_dir": is_dir,
                                "size": attr.st_size,
                                "modified": (
                                    f"{datetime.utcfromtimestamp(attr.st_mtime).isoformat()}Z"
                                    if attr.st_mtime else None
                                ),
                            }
                            dl = existing.get(full)
                            if dl:
                                entry["downloaded"] = True
                                entry["message_id"] = dl.get("message_id")
                                entry["status"] = dl.get("status")
                            else:
                                entry["downloaded"] = False
                            group["entries"].append(entry)
                        group["entries"].sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
                    except Exception as e:
                        group["error"] = str(e)
                return jsonify({"folders": [g for _, g in active_groups] + inactive_groups})
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            except Exception as e:
                return jsonify({"error": str(e)}), 500
            finally:
                if client:
                    client.close()

        @self.app.route("/api/vps/download", methods=["POST"])
        @token_required
        def download_vps_file():
            """Start downloading a single VPS file/folder. Body: {path, size?}."""
            if not self.vps_downloader:
                return jsonify({"error": "VPS downloader not available"}), 503
            data = request.json or {}
            path = (data.get("path") or "").strip()
            if not path:
                return jsonify({"error": "path is required"}), 400
            result = self.vps_downloader.start_download(path, int(data.get("size") or 0))
            if result.get("error"):
                return jsonify(result), 400
            return jsonify(result)

        @self.app.route("/api/vps/delete-remote", methods=["POST"])
        @token_required
        def delete_vps_remote():
            """Permanently delete a file/folder ON the VPS over SFTP. Body: {path}."""
            if not self.vps_downloader:
                return jsonify({"error": "VPS downloader not available"}), 503
            data = request.json or {}
            path = (data.get("path") or "").strip()
            if not path:
                return jsonify({"error": "path is required"}), 400
            try:
                self.vps_downloader.delete_remote(path)
                return jsonify({"status": "deleted"})
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        # Video file API for playback
        @self.app.route("/api/video/check/<int:download_id>", methods=["GET"])
        @token_required
        def check_video_file(download_id):
            """Check if a video file exists for a download"""
            db = get_db()
            download = db.get_download_by_id(download_id)

            if not download:
                return jsonify({"exists": False, "error": "Download not found"}), 404

            if download.get("status") != "done":
                return jsonify({"exists": False, "error": "Download not complete"})

            # Get the file path from the download record
            file_name = download.get("file")
            if not file_name:
                return jsonify({"exists": False, "error": "No file name"})

            # Check the source's destination folder + common download locations
            possible_paths = candidate_file_paths(download, file_name)

            for file_path in possible_paths:
                if file_path.exists():
                    # Check if it's a video file
                    video_extensions = {'.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv', '.wmv'}
                    if file_path.suffix.lower() in video_extensions:
                        # Reset file_deleted flag if file exists
                        db.update_download_by_id(download_id, file_deleted=False)
                        return jsonify({
                            "exists": True,
                            "path": str(file_path),
                            "size": file_path.stat().st_size,
                            "name": file_name
                        })

            # Mark file as deleted in database
            db.update_download_by_id(download_id, file_deleted=True)
            return jsonify({"exists": False, "error": "File not found"})

        @self.app.route("/api/video/stream/<int:download_id>", methods=["GET"])
        def stream_video(download_id):
            """Stream a video file for playback"""
            from flask import Response, request
            import mimetypes

            # Accept token from query param (for video element) or header
            token = request.args.get('token')
            if not token:
                auth_header = request.headers.get('Authorization')
                if auth_header and auth_header.startswith('Bearer '):
                    token = auth_header.split(' ')[1]

            if not token:
                return jsonify({'error': 'Token is missing'}), 401

            try:
                jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
            except jwt.ExpiredSignatureError:
                return jsonify({'error': 'Token has expired'}), 401
            except jwt.InvalidTokenError:
                return jsonify({'error': 'Invalid token'}), 401

            db = get_db()
            download = db.get_download_by_id(download_id)

            if not download or download.get("status") != "done":
                return jsonify({"error": "Video not available"}), 404

            file_name = download.get("file")
            if not file_name:
                return jsonify({"error": "No file name"}), 404

            # Find the file
            file_path = None
            possible_paths = candidate_file_paths(download, file_name)

            for path in possible_paths:
                if path.exists():
                    file_path = path
                    break

            if not file_path:
                return jsonify({"error": "File not found"}), 404

            # Get file size and mime type
            file_size = file_path.stat().st_size
            mime_type = mimetypes.guess_type(str(file_path))[0] or 'video/mp4'

            # Handle range requests for seeking
            range_header = request.headers.get('Range')

            if range_header:
                # Parse range header
                byte_start = 0
                byte_end = file_size - 1

                range_match = range_header.replace('bytes=', '').split('-')
                if range_match[0]:
                    byte_start = int(range_match[0])
                if len(range_match) > 1 and range_match[1]:
                    byte_end = int(range_match[1])

                content_length = byte_end - byte_start + 1

                def generate():
                    with open(file_path, 'rb') as f:
                        f.seek(byte_start)
                        remaining = content_length
                        chunk_size = 1024 * 1024  # 1MB chunks
                        while remaining > 0:
                            chunk = f.read(min(chunk_size, remaining))
                            if not chunk:
                                break
                            remaining -= len(chunk)
                            yield chunk

                response = Response(
                    generate(),
                    status=206,
                    mimetype=mime_type,
                    direct_passthrough=True
                )
                response.headers['Content-Range'] = f'bytes {byte_start}-{byte_end}/{file_size}'
                response.headers['Accept-Ranges'] = 'bytes'
                response.headers['Content-Length'] = content_length
                return response
            else:
                # Full file request
                def generate():
                    with open(file_path, 'rb') as f:
                        chunk_size = 1024 * 1024  # 1MB chunks
                        while True:
                            chunk = f.read(chunk_size)
                            if not chunk:
                                break
                            yield chunk

                response = Response(
                    generate(),
                    status=200,
                    mimetype=mime_type,
                    direct_passthrough=True
                )
                response.headers['Accept-Ranges'] = 'bytes'
                response.headers['Content-Length'] = file_size
                return response

        # Thumbnail API
        @self.app.route("/api/thumbs/<int:download_id>", methods=["GET"])
        @token_required
        def get_thumbs(download_id):
            """Get list of available thumbnails for a download"""
            from backend.file_meta import get_thumbs_dir
            thumb_dir = get_thumbs_dir() / str(download_id)
            if not thumb_dir.exists():
                return jsonify({"thumbs": []})
            thumbs = sorted([f.name for f in thumb_dir.iterdir() if f.suffix == '.jpg'])
            return jsonify({"thumbs": thumbs})

        @self.app.route("/api/thumbs/<int:download_id>/<filename>", methods=["GET"])
        def serve_thumb(download_id, filename):
            """Serve a thumbnail image"""
            # Accept token from query param or header
            token = request.args.get('token')
            if not token:
                auth_header = request.headers.get('Authorization')
                if auth_header and auth_header.startswith('Bearer '):
                    token = auth_header.split(' ')[1]
            if not token:
                return jsonify({'error': 'Token is missing'}), 401
            try:
                jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
            except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
                return jsonify({'error': 'Invalid token'}), 401

            # Sanitize filename to prevent directory traversal
            if '/' in filename or '\\' in filename or '..' in filename:
                return jsonify({'error': 'Invalid filename'}), 400

            from backend.file_meta import get_thumbs_dir
            thumb_dir = get_thumbs_dir() / str(download_id)
            thumb_path = thumb_dir / filename
            if not thumb_path.exists():
                return jsonify({'error': 'Thumbnail not found'}), 404

            return send_from_directory(str(thumb_dir), filename, mimetype='image/jpeg')

        # Jobs API
        @self.app.route("/api/jobs/ytdlp-version", methods=["GET"])
        @token_required
        def api_ytdlp_version():
            """Get current yt-dlp version"""
            import subprocess
            try:
                result = subprocess.run(
                    [self.ytdlp_downloader.YTDLP_PATH, '--version'],
                    capture_output=True, text=True, timeout=10
                )
                return jsonify({"version": result.stdout.strip()})
            except Exception as e:
                return jsonify({"version": None, "error": str(e)})

        @self.app.route("/api/jobs/ytdlp-upgrade", methods=["POST"])
        @token_required
        def api_ytdlp_upgrade():
            """Upgrade yt-dlp in the venv"""
            import subprocess
            venv_pip = str(Path(__file__).parent.parent.parent / 'venv' / 'bin' / 'pip')
            try:
                # Get current version
                old_ver = subprocess.run(
                    [self.ytdlp_downloader.YTDLP_PATH, '--version'],
                    capture_output=True, text=True, timeout=10
                ).stdout.strip()

                # Run pip upgrade
                result = subprocess.run(
                    [venv_pip, 'install', '--upgrade', 'yt-dlp'],
                    capture_output=True, text=True, timeout=120
                )
                if result.returncode != 0:
                    return jsonify({"error": result.stderr.strip()[:500]}), 500

                # Get new version
                new_ver = subprocess.run(
                    [self.ytdlp_downloader.YTDLP_PATH, '--version'],
                    capture_output=True, text=True, timeout=10
                ).stdout.strip()

                return jsonify({
                    "old_version": old_ver,
                    "new_version": new_ver,
                    "upgraded": old_ver != new_ver,
                })
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        @self.app.route("/api/jobs/sync-thumbnails", methods=["POST"])
        @token_required
        def api_sync_thumbnails():
            """Run thumbnail sync job - generates missing thumbnails, cleans orphans."""
            import json as _json
            import shutil
            from backend.config import SCREENSHOTS_DIR
            from backend.file_meta import (
                find_file, is_video_file, generate_thumbnails as gen_thumbs,
                probe_video, extract_meta
            )

            db = get_db()
            downloads = db.get_all_downloads()
            completed = [d for d in downloads if d['status'] == 'done' and not d.get('deleted_at')]

            stats = {
                'generated': 0,
                'skipped': 0,
                'orphan_deleted': 0,
                'db_count_fixed': 0,
                'meta_extracted': 0,
                'no_duration': 0,
                'not_video': 0,
                'failed': 0,
            }

            import asyncio as _asyncio
            loop = _asyncio.new_event_loop()

            for dl in completed:
                file_name = dl.get('file')
                if not file_name or not is_video_file(file_name):
                    stats['not_video'] += 1
                    continue

                dl_id = dl['id']
                thumb_dir = SCREENSHOTS_DIR / str(dl_id)
                has_thumbs = thumb_dir.exists() and any(thumb_dir.glob('*.jpg'))
                file_path = find_file(file_name, dl.get('downloaded_from'), dl.get('url'))

                # File missing, thumbnails exist → delete orphans
                if not file_path and has_thumbs:
                    shutil.rmtree(thumb_dir, ignore_errors=True)
                    db.update_download_by_id(dl_id, thumb_count=0)
                    stats['orphan_deleted'] += 1
                    continue

                # File missing, no thumbnails → skip
                if not file_path:
                    continue

                # File exists, thumbnails exist → sync DB count
                if has_thumbs:
                    actual_count = len([f for f in thumb_dir.iterdir() if f.suffix == '.jpg'])
                    if dl.get('thumb_count') != actual_count:
                        db.update_download_by_id(dl_id, thumb_count=actual_count)
                        stats['db_count_fixed'] += 1
                    stats['skipped'] += 1
                    continue

                # File exists, thumbnails missing → generate
                duration = None
                file_meta = dl.get('file_meta')
                if file_meta:
                    duration = file_meta.get('duration') if isinstance(file_meta, dict) else None

                if not duration:
                    probe_data = loop.run_until_complete(probe_video(str(file_path)))
                    if probe_data:
                        meta = extract_meta(probe_data)
                        if meta.get('video'):
                            db.update_download_by_id(dl_id, file_meta=_json.dumps(meta))
                            duration = meta.get('duration')
                            stats['meta_extracted'] += 1

                if not duration or duration <= 0:
                    stats['no_duration'] += 1
                    continue

                count = loop.run_until_complete(gen_thumbs(dl_id, str(file_path), duration))
                if count:
                    stats['generated'] += 1
                else:
                    stats['failed'] += 1

            loop.close()
            return jsonify(stats)

        # Serve frontend
        @self.app.route('/')
        def serve_index():
            return send_from_directory(self.app.static_folder, 'index.html')

        @self.app.errorhandler(404)
        def not_found(e):
            # Return JSON 404 for API routes, serve index.html for SPA routes
            if request.path.startswith('/api/') or request.path == '/metrics':
                return jsonify({'error': 'Not found'}), 404
            return send_from_directory(self.app.static_folder, 'index.html')

    def run(self):
        """Run the Flask application with WebSocket support"""
        self.socketio.run(self.app, host=WEB_HOST, port=WEB_PORT, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)

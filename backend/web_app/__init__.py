"""
Flask REST API with WebSocket support for DownLee
"""
import os
import jwt
import asyncio
from datetime import datetime, timedelta
from pathlib import Path
from functools import wraps
from flask import Flask, jsonify, request, send_from_directory, Response
from flask_cors import CORS
from flask_socketio import SocketIO
from backend.config import WEB_PORT, WEB_HOST
from backend.database import get_db
from backend import metrics

# JWT secret key
JWT_SECRET = os.environ.get('JWT_SECRET', 'telegram-downloader-secret-key-change-in-prod')
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


def get_web_app():
    """Get the global web app instance"""
    return _web_app


def token_required(f):
    """Decorator to require valid JWT token"""
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

        return f(*args, **kwargs)
    return decorated


class WebApp:
    def __init__(self, download_tasks, ytdlp_downloader=None, event_loop=None, telegram_downloader=None):
        global socketio, _web_app
        self.download_tasks = download_tasks
        self.ytdlp_downloader = ytdlp_downloader
        self.telegram_downloader = telegram_downloader
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

    def get_downloads_data(self, search='', filter_type='all', sort_by='created_at', sort_order='desc',
                           limit=30, offset=0, exclude_mapping_ids=None, author=None):
        """Get downloads data (paginated)

        Args:
            search: Search query to filter by filename
            filter_type: 'all' for all downloads, 'active' for non-done downloads
            sort_by: Field to sort by ('created_at', 'file', 'status', 'progress')
            sort_order: 'asc' or 'desc'
            limit: Number of items to return (default 30)
            offset: Number of items to skip (default 0)
            exclude_mapping_ids: List of mapping IDs to exclude from results
            author: Filter by specific author
        """
        db = get_db()
        all_downloads = db.get_all_downloads()

        # Get sources to exclude based on mapping IDs
        excluded_sources = []
        if exclude_mapping_ids:
            all_mappings = db.get_all_download_type_maps()
            mapping_by_id = {m['id']: m for m in all_mappings}
            excluded_sources = [mapping_by_id[mid]['downloaded_from'] for mid in exclude_mapping_ids if mid in mapping_by_id]

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

        # Filter out excluded sources
        if excluded_sources:
            filtered_list = [d for d in filtered_list if d.get("downloaded_from") not in excluded_sources]

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
                "user": user
            })

        @self.app.route("/api/auth/verify", methods=["GET"])
        @token_required
        def verify_token():
            return jsonify({"user": request.user})

        @self.app.route("/api/auth/password", methods=["POST"])
        @token_required
        def update_password():
            data = request.json
            current_password = data.get("current_password")
            new_password = data.get("new_password")

            if not current_password or not new_password:
                return jsonify({"error": "Current and new password required"}), 400

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
            # Parse exclude_mapping_ids as comma-separated list of integers
            exclude_ids_str = request.args.get("exclude_mapping_ids", "")
            exclude_mapping_ids = [int(x) for x in exclude_ids_str.split(",") if x.strip().isdigit()] if exclude_ids_str else None
            author = request.args.get("author", "").strip() or None
            return jsonify(self.get_downloads_data(search, filter_type, sort_by, sort_order, limit, offset, exclude_mapping_ids, author))

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
                    # Check if it's a yt-dlp download (has URL)
                    if download.get("url") and self.ytdlp_downloader and self.event_loop:
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
                # yt-dlp download - stop via ytdlp_downloader
                if self.ytdlp_downloader:
                    self.ytdlp_downloader.stop_download(message_id)
                # Also try to cancel from download_tasks
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
                # yt-dlp download - stop via ytdlp_downloader
                if self.ytdlp_downloader:
                    self.ytdlp_downloader.stop_download(message_id)
                # Also try to cancel from download_tasks
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
                    from backend.config import DOWNLOAD_DIR
                    file_name = download["file"]
                    downloaded_from = download.get("downloaded_from")

                    possible_paths = [
                        DOWNLOAD_DIR / file_name,
                        DOWNLOAD_DIR / "Videos" / file_name,
                    ]
                    if downloaded_from:
                        mapping = db.get_download_type_map(downloaded_from)
                        if mapping and mapping.get("folder"):
                            possible_paths.insert(0, Path(mapping["folder"]) / file_name)

                    for file_path in possible_paths:
                        if file_path.exists():
                            file_path.unlink()
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
                author=author
            )

            if 'error' in result:
                return jsonify(result), 400

            return jsonify(result)

        # Download type mappings API
        @self.app.route("/api/mappings", methods=["GET"])
        @token_required
        def get_mappings():
            """Get all download type mappings"""
            db = get_db()
            return jsonify(db.get_all_download_type_maps())

        @self.app.route("/api/mappings/secured", methods=["GET"])
        @token_required
        def get_secured_sources():
            """Get list of secured source types"""
            db = get_db()
            return jsonify(db.get_secured_sources())

        @self.app.route("/api/mappings/secured-ids", methods=["GET"])
        @token_required
        def get_secured_mapping_ids():
            """Get list of secured mapping IDs"""
            db = get_db()
            return jsonify(db.get_secured_mapping_ids())

        @self.app.route("/api/mappings/source/<source>", methods=["GET"])
        @token_required
        def get_mapping_by_source(source):
            """Get mapping for a specific source"""
            from backend.config import DOWNLOAD_DIR
            db = get_db()
            mapping = db.get_download_type_map(source)
            if mapping:
                mapping["download_folder"] = mapping.get("folder") or str(DOWNLOAD_DIR / "Videos")
                return jsonify(mapping)
            return jsonify({"download_folder": str(DOWNLOAD_DIR / "Videos")})

        @self.app.route("/api/mappings", methods=["POST"])
        @token_required
        def add_mapping():
            """Add a new download type mapping"""
            data = request.json
            downloaded_from = data.get("downloaded_from")
            is_secured = data.get("is_secured", False)
            folder = data.get("folder")
            quality = data.get("quality")

            if not downloaded_from:
                return jsonify({"error": "downloaded_from is required"}), 400

            db = get_db()
            result = db.add_download_type_map(downloaded_from, is_secured, folder, quality)

            if 'error' in result:
                return jsonify(result), 400

            return jsonify(result)

        @self.app.route("/api/mappings/<int:map_id>", methods=["PUT"])
        @token_required
        def update_mapping(map_id):
            """Update a download type mapping"""
            data = request.json
            db = get_db()

            update_data = {}
            if "downloaded_from" in data:
                update_data["downloaded_from"] = data["downloaded_from"]
            if "is_secured" in data:
                update_data["is_secured"] = data["is_secured"]
            if "folder" in data:
                update_data["folder"] = data["folder"]
            if "quality" in data:
                update_data["quality"] = data["quality"]

            result = db.update_download_type_map(map_id, **update_data)

            if isinstance(result, dict) and 'error' in result:
                return jsonify(result), 400

            return jsonify(result)

        @self.app.route("/api/mappings/<int:map_id>", methods=["DELETE"])
        @token_required
        def delete_mapping(map_id):
            """Delete a download type mapping"""
            db = get_db()
            success = db.delete_download_type_map(map_id)

            if not success:
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

            # Check common download locations
            from backend.config import DOWNLOAD_DIR
            possible_paths = [
                DOWNLOAD_DIR / file_name,
                DOWNLOAD_DIR / "Videos" / file_name,
            ]

            # Also check if there's a custom folder mapping
            downloaded_from = download.get("downloaded_from")
            if downloaded_from:
                mapping = db.get_download_type_map(downloaded_from)
                if mapping and mapping.get("folder"):
                    possible_paths.insert(0, Path(mapping["folder"]) / file_name)

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
            from backend.config import DOWNLOAD_DIR
            file_path = None
            possible_paths = [
                DOWNLOAD_DIR / file_name,
                DOWNLOAD_DIR / "Videos" / file_name,
            ]

            downloaded_from = download.get("downloaded_from")
            if downloaded_from:
                mapping = db.get_download_type_map(downloaded_from)
                if mapping and mapping.get("folder"):
                    possible_paths.insert(0, Path(mapping["folder"]) / file_name)

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
                file_path = find_file(file_name, dl.get('downloaded_from'))

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
            # For SPA routing, serve index.html for non-API routes
            return send_from_directory(self.app.static_folder, 'index.html')

    def run(self):
        """Run the Flask application with WebSocket support"""
        self.socketio.run(self.app, host=WEB_HOST, port=WEB_PORT, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)

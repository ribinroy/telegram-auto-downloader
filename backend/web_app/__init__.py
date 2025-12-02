"""
Flask REST API with WebSocket support for DownloadLee
"""
import os
import jwt
import asyncio
from datetime import datetime, timedelta
from pathlib import Path
from functools import wraps
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO
from backend.config import WEB_PORT, WEB_HOST
from backend.database import get_db

# JWT secret key
JWT_SECRET = os.environ.get('JWT_SECRET', 'telegram-downloader-secret-key-change-in-prod')
JWT_EXPIRY_DAYS = 30  # Keep signed in for 30 days

# Global socketio instance for broadcasting from other modules
socketio = None

# Frontend dist directory
FRONTEND_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"


def get_socketio():
    """Get the global socketio instance"""
    return socketio


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
    def __init__(self, download_tasks, ytdlp_downloader=None, event_loop=None):
        global socketio
        self.download_tasks = download_tasks
        self.ytdlp_downloader = ytdlp_downloader
        self.event_loop = event_loop
        self.app = Flask(__name__, static_folder=str(FRONTEND_DIST), static_url_path='')
        CORS(self.app, resources={r"/*": {"origins": "*"}})
        socketio = SocketIO(self.app, cors_allowed_origins="*", async_mode='threading')
        self.socketio = socketio
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
                           limit=30, offset=0, exclude_mapping_ids=None):
        """Get downloads data (paginated)

        Args:
            search: Search query to filter by filename
            filter_type: 'all' for all downloads, 'active' for non-done downloads
            sort_by: Field to sort by ('created_at', 'file', 'status', 'progress')
            sort_order: 'asc' or 'desc'
            limit: Number of items to return (default 30)
            offset: Number of items to skip (default 0)
            exclude_mapping_ids: List of mapping IDs to exclude from results
        """
        db = get_db()
        all_downloads = db.get_all_downloads()

        # Get sources to exclude based on mapping IDs
        excluded_sources = []
        if exclude_mapping_ids:
            all_mappings = db.get_all_download_type_maps()
            mapping_by_id = {m['id']: m for m in all_mappings}
            excluded_sources = [mapping_by_id[mid]['downloaded_from'] for mid in exclude_mapping_ids if mid in mapping_by_id]

        query = search.lower()
        filtered_list = [d for d in all_downloads if query in d.get("file", "").lower()] if query else all_downloads

        # Filter out excluded sources
        if excluded_sources:
            filtered_list = [d for d in filtered_list if d.get("downloaded_from") not in excluded_sources]

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

        total_downloaded = sum(d.get("downloaded_bytes", 0) or 0 for d in all_downloads)
        total_size = sum(d.get("total_bytes", 0) or 0 for d in all_downloads)
        pending_bytes = total_size - total_downloaded
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
            return jsonify(self.get_downloads_data(search, filter_type, sort_by, sort_order, limit, offset, exclude_mapping_ids))

        @self.app.route("/api/stats", methods=["GET"])
        @token_required
        def get_stats():
            return jsonify(self.get_stats())

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
                            self.ytdlp_downloader.download(url, message_id),
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

            # Update database status to stopped
            db.update_download_by_message_id(message_id, status='stopped', speed=0)
            self.emit_status(message_id, 'stopped')
            return jsonify({"status": "stopped"})

        @self.app.route("/api/delete", methods=["POST"])
        @token_required
        def api_delete():
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
                self.download_tasks.pop(message_id, None)
            else:
                # Telegram download - convert to int for task lookup
                telegram_id = int(message_id) if message_id else None
                task = self.download_tasks.get(telegram_id)
                if task and not task.done():
                    task.cancel()
                    db.update_download_by_message_id(message_id, status='stopped', speed=0)
                self.download_tasks.pop(telegram_id, None)

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

            result = self.ytdlp_downloader.start_download(
                url, self.event_loop,
                format_id=format_id,
                title=title,
                ext=ext,
                filesize=filesize,
                resolution=resolution
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
            db = get_db()
            mapping = db.get_download_type_map(source)
            if mapping:
                return jsonify(mapping)
            return jsonify(None)

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
            all_downloads = db.get_all_downloads()

            # Get date range from query params (default: last 30 days)
            days = int(request.args.get("days", 30))
            group_by = request.args.get("group_by", "day")  # 'day' or 'hour'

            from datetime import datetime, timedelta
            from collections import defaultdict

            now = datetime.utcnow()
            cutoff = now - timedelta(days=days)

            # Filter downloads within date range
            recent_downloads = []
            for d in all_downloads:
                created = d.get("created_at")
                if created:
                    try:
                        dt = datetime.fromisoformat(created.replace('Z', '+00:00')) if isinstance(created, str) else created
                        if dt.replace(tzinfo=None) >= cutoff:
                            recent_downloads.append({**d, '_dt': dt.replace(tzinfo=None)})
                    except:
                        pass

            # Group by time period
            downloads_by_time = defaultdict(lambda: {'count': 0, 'size': 0})
            downloads_by_source = defaultdict(lambda: {'count': 0, 'size': 0})
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
                current = cutoff.date()
                end = now.date()
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

            # Summary stats
            total_downloads = len(recent_downloads)
            total_size = sum(d.get('total_bytes', 0) or 0 for d in recent_downloads)
            completed = sum(1 for d in recent_downloads if d.get('status') == 'done')
            failed = sum(1 for d in recent_downloads if d.get('status') == 'failed')

            return jsonify({
                'time_series': time_data,
                'by_source': source_data,
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

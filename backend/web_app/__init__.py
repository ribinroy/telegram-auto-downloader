"""
Flask REST API with WebSocket support for Telegram Downloader
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

    def get_downloads_data(self, search='', filter_type='all', sort_by='created_at', sort_order='desc'):
        """Get downloads data with stats

        Args:
            search: Search query to filter by filename
            filter_type: 'all' for all downloads, 'active' for non-done downloads
            sort_by: Field to sort by ('created_at', 'file', 'status', 'progress')
            sort_order: 'asc' or 'desc'
        """
        db = get_db()
        all_downloads = db.get_all_downloads()

        query = search.lower()
        filtered_list = [d for d in all_downloads if query in d.get("file", "").lower()] if query else all_downloads

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

        total_downloaded = sum(d.get("downloaded_bytes", 0) or 0 for d in filtered_list)
        total_size = sum(d.get("total_bytes", 0) or 0 for d in filtered_list)
        pending_bytes = total_size - total_downloaded
        total_speed = sum(d.get("speed", 0) or 0 for d in filtered_list)
        downloaded_count = sum(1 for d in filtered_list if d.get("status") == "done")
        total_count = len(filtered_list)

        # Calculate counts from unfiltered list for tab display
        all_count = len(sorted_list)
        active_count = sum(1 for d in sorted_list if d.get("status") != "done")

        return {
            "downloads": filtered_list,
            "stats": {
                "total_downloaded": total_downloaded,
                "total_size": total_size,
                "pending_bytes": pending_bytes,
                "total_speed": total_speed,
                "downloaded_count": downloaded_count,
                "total_count": total_count,
                "all_count": all_count,
                "active_count": active_count
            }
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

    def emit_status(self, message_id, status: str):
        """Emit status change for a specific download"""
        # Ensure message_id is sent as string to avoid JS precision loss
        msg_id_str = str(message_id) if message_id else None
        self.socketio.emit('download:status', {'message_id': msg_id_str, 'status': status})

    def emit_deleted(self, message_id):
        """Emit download deleted event"""
        # Ensure message_id is sent as string to avoid JS precision loss
        msg_id_str = str(message_id) if message_id else None
        self.socketio.emit('download:deleted', {'message_id': msg_id_str})

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
            return jsonify(self.get_downloads_data(search, filter_type, sort_by, sort_order))

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

            if not url:
                return jsonify({"error": "URL is required"}), 400

            if not self.ytdlp_downloader:
                return jsonify({"error": "yt-dlp downloader not available"}), 500

            if not self.event_loop:
                return jsonify({"error": "Event loop not available"}), 500

            result = self.ytdlp_downloader.start_download(url, self.event_loop)

            if 'error' in result:
                return jsonify(result), 400

            return jsonify(result)

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

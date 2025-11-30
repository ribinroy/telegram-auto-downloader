"""
Flask REST API with WebSocket support for Telegram Downloader
"""
import os
from datetime import datetime
from pathlib import Path
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from backend.config import WEB_PORT, WEB_HOST
from backend.database import get_db

# Global socketio instance for broadcasting from other modules
socketio = None

# Frontend dist directory
FRONTEND_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"


def get_socketio():
    """Get the global socketio instance"""
    return socketio


class WebApp:
    def __init__(self, download_tasks):
        global socketio
        self.download_tasks = download_tasks
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

    def broadcast_update(self):
        """Broadcast download update to all clients"""
        data = self.get_downloads_data()
        self.socketio.emit('downloads_update', data)

    def setup_routes(self):
        """Setup Flask API routes"""

        @self.app.route("/api/downloads", methods=["GET"])
        def get_downloads():
            search = request.args.get("search", "")
            filter_type = request.args.get("filter", "all")  # 'all' or 'active'
            sort_by = request.args.get("sort_by", "created_at")  # 'created_at', 'file', 'status', 'progress'
            sort_order = request.args.get("sort_order", "desc")  # 'asc' or 'desc'
            return jsonify(self.get_downloads_data(search, filter_type, sort_by, sort_order))

        @self.app.route("/api/stats", methods=["GET"])
        def get_stats():
            return jsonify(self.get_stats())

        @self.app.route("/api/retry", methods=["POST"])
        def api_retry():
            data = request.json
            download_id = data.get("id")
            if download_id is not None:
                db = get_db()
                download = db.get_download_by_id(download_id)
                if download and download["status"] in ["failed", "stopped"]:
                    db.update_download_by_id(
                        download_id,
                        status='downloading',
                        progress=0,
                        speed=0,
                        error=None,
                        updated_at=datetime.utcnow()
                    )
                    self.broadcast_update()
            return jsonify({"status": "ok"})

        @self.app.route("/api/stop", methods=["POST"])
        def api_stop():
            data = request.json
            file = data.get("file")
            db = get_db()

            # Cancel the running task
            task = self.download_tasks.get(file)
            if task and not task.done():
                task.cancel()

            # Update database status to stopped
            db.update_download(file, status='stopped', speed=0)

            self.broadcast_update()
            return jsonify({"status": "stopped"})

        @self.app.route("/api/delete", methods=["POST"])
        def api_delete():
            data = request.json
            file = data.get("file")
            db = get_db()

            # Cancel task if running
            task = self.download_tasks.get(file)
            if task and not task.done():
                task.cancel()
            self.download_tasks.pop(file, None)

            # Delete from database
            db.delete_download(file)
            self.broadcast_update()
            return jsonify({"status": "deleted"})

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

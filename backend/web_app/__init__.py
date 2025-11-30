"""
Flask REST API with WebSocket support for Telegram Downloader
"""
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from backend.config import WEB_PORT, WEB_HOST
from backend.database import get_db

# Global socketio instance for broadcasting from other modules
socketio = None


def get_socketio():
    """Get the global socketio instance"""
    return socketio


class WebApp:
    def __init__(self, download_tasks):
        global socketio
        self.download_tasks = download_tasks
        self.app = Flask(__name__)
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

    def get_downloads_data(self, search='', filter_type='all'):
        """Get downloads data with stats

        Args:
            search: Search query to filter by filename
            filter_type: 'all' for all downloads, 'active' for non-done downloads
        """
        db = get_db()
        all_downloads = db.get_all_downloads()

        query = search.lower()
        sorted_list = sorted(all_downloads, key=lambda x: 0 if x["status"] == "downloading" else 1)
        filtered_list = [d for d in sorted_list if query in d.get("file", "").lower()] if query else sorted_list

        # Apply filter_type
        if filter_type == 'active':
            filtered_list = [d for d in filtered_list if d.get("status") != "done"]

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
            return jsonify(self.get_downloads_data(search, filter_type))

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
            task = self.download_tasks.get(file)
            if task and not task.done():
                task.cancel()
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

    def run(self):
        """Run the Flask application with WebSocket support"""
        self.socketio.run(self.app, host=WEB_HOST, port=WEB_PORT, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)

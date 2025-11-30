"""
Flask REST API for Telegram Downloader
"""
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS
from backend.config import WEB_PORT, WEB_HOST
from backend.database import get_db
from backend.utils import human_readable_size, format_time


class WebApp:
    def __init__(self, download_tasks):
        self.download_tasks = download_tasks
        self.app = Flask(__name__)
        CORS(self.app)  # Enable CORS for React frontend
        self.setup_routes()

    def setup_routes(self):
        """Setup Flask API routes"""

        @self.app.route("/api/downloads", methods=["GET"])
        def get_downloads():
            db = get_db()
            all_downloads = db.get_all_downloads()

            query = request.args.get("search", "").lower()
            # Sort: downloading first, then others
            sorted_list = sorted(all_downloads, key=lambda x: 0 if x["status"] == "downloading" else 1)
            filtered_list = [d for d in sorted_list if query in d.get("file", "").lower()] if query else sorted_list

            total_downloaded = sum(d.get("downloaded_bytes", 0) or 0 for d in filtered_list)
            total_size = sum(d.get("total_bytes", 0) or 0 for d in filtered_list)
            pending_bytes = total_size - total_downloaded
            total_speed = sum(d.get("speed", 0) or 0 for d in filtered_list)
            downloaded_count = sum(1 for d in filtered_list if d.get("status") == "done")
            total_count = len(filtered_list)

            return jsonify({
                "downloads": filtered_list,
                "stats": {
                    "total_downloaded": total_downloaded,
                    "total_size": total_size,
                    "pending_bytes": pending_bytes,
                    "total_speed": total_speed,
                    "downloaded_count": downloaded_count,
                    "total_count": total_count
                }
            })

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
                        timestamp=datetime.utcnow()
                    )
            return jsonify({"status": "ok"})

        @self.app.route("/api/stop", methods=["POST"])
        def api_stop():
            data = request.json
            file = data.get("file")
            task = self.download_tasks.get(file)
            if task and not task.done():
                task.cancel()
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
            return jsonify({"status": "deleted"})

    def run(self):
        """Run the Flask application"""
        self.app.run(host=WEB_HOST, port=WEB_PORT, debug=False, use_reloader=False)

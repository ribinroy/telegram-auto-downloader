import os
import json
import asyncio
import posixpath
import jwt
from datetime import datetime, timedelta
from pathlib import Path
from flask import jsonify, request, send_from_directory, Response
from backend.config import JWT_SECRET
from backend.database import get_db
from backend import metrics
from backend.web_app.base import (
    token_required, media_token_required, get_socketio, get_web_app,
    JWT_EXPIRY_DAYS, PASSWORD_CHANGE_ALLOWED_PATHS, FRONTEND_DIST,
)
from backend.web_app.torrent import (
    load_torrent_config, apply_torrent_session, transmission_add_magnet,
    transmission_rpc, normalize_transmission_url,
)
from backend.web_app.vps import load_vps_credentials, annotate_vps_folders, open_vps_sftp
from backend.web_app.helpers import candidate_file_paths, range_response
from backend.jobs import JOBS, read_schedules, save_schedule, next_run, run_job


class MediaRoutesMixin:
    def register_media_routes(self):
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
        @media_token_required
        def stream_video(download_id):
            """Stream a video file for playback"""
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

            return range_response(file_path)

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
        @media_token_required
        def serve_thumb(download_id, filename):
            """Serve a thumbnail image"""

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
            """Upgrade yt-dlp in the venv (same body the scheduler runs)."""
            try:
                return jsonify(run_job('ytdlp_upgrade'))
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        @self.app.route("/api/jobs/sync-thumbnails", methods=["POST"])
        @token_required
        def api_sync_thumbnails():
            """Thumbnail sync job - same body the scheduler runs."""
            try:
                return jsonify(run_job('sync_thumbnails'))
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        # --- Job schedules ---------------------------------------------

        @self.app.route("/api/jobs/schedules", methods=["GET"])
        @token_required
        def api_job_schedules():
            """Every job with its schedule, last outcome and next fire time.

            Times are the server's local wall clock, which is what `tz` names
            so the UI can say so rather than implying the browser's zone.
            """
            schedules = read_schedules()
            for entry in schedules.values():
                upcoming = next_run(entry)
                entry['next_run'] = upcoming.isoformat() if upcoming else None
            return jsonify({
                "jobs": [{"id": job_id, "label": job["label"]} for job_id, job in JOBS.items()],
                "schedules": schedules,
                "tz": datetime.now().astimezone().tzname(),
                "server_time": datetime.now().isoformat(),
            })

        @self.app.route("/api/jobs/schedules/<job_id>", methods=["PUT"])
        @token_required
        def api_save_job_schedule(job_id):
            """Body: {enabled?, time? 'HH:MM', days?: [0-6]} (Monday = 0)."""
            data = request.json or {}
            try:
                entry = save_schedule(
                    job_id,
                    enabled=data.get("enabled"),
                    at=data.get("time"),
                    days=data.get("days"),
                )
            except KeyError:
                return jsonify({"error": "Unknown job"}), 404
            except (ValueError, TypeError) as e:
                return jsonify({"error": str(e)}), 400
            upcoming = next_run(entry)
            entry['next_run'] = upcoming.isoformat() if upcoming else None
            return jsonify({"schedule": entry})


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
    token_required, get_socketio, get_web_app,
    JWT_EXPIRY_DAYS, PASSWORD_CHANGE_ALLOWED_PATHS, FRONTEND_DIST,
)
from backend.web_app.torrent import (
    load_torrent_config, apply_torrent_session, transmission_add_magnet,
    transmission_rpc, normalize_transmission_url,
)
from backend.web_app.vps import load_vps_credentials, annotate_vps_folders, open_vps_sftp
from backend.web_app.helpers import candidate_file_paths


class DownloadRoutesMixin:
    def register_download_routes(self):
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


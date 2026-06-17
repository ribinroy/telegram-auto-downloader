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


class UrlRoutesMixin:
    def register_url_routes(self):
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

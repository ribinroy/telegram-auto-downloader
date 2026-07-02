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
            venv_pip = str(Path(__file__).parent.parent.parent.parent / 'venv' / 'bin' / 'pip')
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


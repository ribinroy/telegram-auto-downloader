"""
Flask REST API with WebSocket support for DownLee

This package is split by concern:
  base.py      - shared globals (socketio/web_app), JWT auth decorator
  torrent.py   - Transmission RPC helpers
  vps.py       - VPS SSH/SFTP connection helpers
  helpers.py   - misc helpers
  routes/      - per-domain Flask route mixins composed onto WebApp

Public names (get_socketio, get_web_app, token_required, the transmission_*
helpers, WebApp, ...) are re-exported here so existing
`from backend.web_app import X` imports keep working.
"""
import asyncio
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO
from backend.config import WEB_PORT, WEB_HOST
from backend.database import get_db
from backend import metrics

from backend.web_app import base as _base
from backend.web_app.base import (
    get_socketio, get_web_app, token_required,
    JWT_EXPIRY_DAYS, FRONTEND_DIST, PASSWORD_CHANGE_ALLOWED_PATHS,
)
from backend.web_app.torrent import (
    normalize_transmission_url, load_torrent_config, apply_torrent_session,
    transmission_add_magnet, transmission_telegram_dirs, transmission_rpc,
    transmission_get_torrent, TELEGRAM_TORRENT_SUBDIR, TELEGRAM_PROGRESS_SUBDIR,
)
from backend.web_app.vps import load_vps_credentials, annotate_vps_folders, open_vps_sftp
from backend.web_app.helpers import candidate_file_paths
from backend.web_app.routes.auth import AuthRoutesMixin
from backend.web_app.routes.downloads import DownloadRoutesMixin
from backend.web_app.routes.url import UrlRoutesMixin
from backend.web_app.routes.analytics import AnalyticsRoutesMixin
from backend.web_app.routes.settings import SettingsRoutesMixin
from backend.web_app.routes.vps_settings import VpsSettingsRoutesMixin
from backend.web_app.routes.torrent import TorrentRoutesMixin
from backend.web_app.routes.vps_browse import VpsBrowseRoutesMixin
from backend.web_app.routes.media import MediaRoutesMixin


class WebApp(
    AuthRoutesMixin, DownloadRoutesMixin, UrlRoutesMixin, AnalyticsRoutesMixin,
    SettingsRoutesMixin, VpsSettingsRoutesMixin, TorrentRoutesMixin,
    VpsBrowseRoutesMixin, MediaRoutesMixin,
):
    def __init__(self, download_tasks, ytdlp_downloader=None, event_loop=None, telegram_downloader=None, vps_downloader=None):
        self.download_tasks = download_tasks
        self.ytdlp_downloader = ytdlp_downloader
        self.telegram_downloader = telegram_downloader
        self.vps_downloader = vps_downloader
        self.event_loop = event_loop
        self.app = Flask(__name__, static_folder=str(FRONTEND_DIST), static_url_path='')
        CORS(self.app, resources={r"/*": {"origins": "*"}})
        # socketio/_web_app live on the shared base module so other modules can
        # reach them via get_socketio()/get_web_app().
        _base.socketio = SocketIO(self.app, cors_allowed_origins="*", async_mode='threading')
        self.socketio = _base.socketio
        _base._web_app = self
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

    def _annotate_downloads(self, downloads):
        """Stamp each download with computed `hidden` and `dest_folder` from
        the per-source mappings and per-VPS-watchfolder specs. Computed at
        query time so spec changes apply to existing downloads too."""
        db = get_db()
        maps = {m['downloaded_from']: m for m in db.get_all_download_type_maps()}
        vps_folders = (
            db.get_vps_watch_folders()
            if any(d.get('downloaded_from') == 'vps' for d in downloads) else []
        )
        for d in downloads:
            source = d.get('downloaded_from') or 'telegram'
            mapping = maps.get(source, {})
            hidden = bool(mapping.get('is_secured'))
            folder = mapping.get('folder')
            if source == 'vps':
                # Longest-prefix watched folder match on the remote path
                path = d.get('url') or ''
                best, best_len = None, -1
                for wf in vps_folders:
                    base = (wf.get('path') or '').rstrip('/')
                    if base and (path == wf.get('path') or path == base or path.startswith(base + '/')):
                        if len(base) > best_len:
                            best_len, best = len(base), wf
                if best:
                    folder = best.get('folder') or folder
                    hidden = hidden or bool(best.get('is_secured'))
            d['hidden'] = hidden
            d['dest_folder'] = folder
        return downloads

    def get_downloads_data(self, search='', filter_type='all', sort_by='created_at', sort_order='desc',
                           limit=30, offset=0, author=None, include_hidden=False):
        """Get downloads data (paginated)

        Args:
            search: Search query to filter by filename
            filter_type: 'all' for all downloads, 'active' for non-done downloads
            sort_by: Field to sort by ('created_at', 'file', 'status', 'progress')
            sort_order: 'asc' or 'desc'
            limit: Number of items to return (default 30)
            offset: Number of items to skip (default 0)
            author: Filter by specific author
            include_hidden: Include downloads from secured sources/folders
        """
        db = get_db()
        all_downloads = self._annotate_downloads(db.get_all_downloads())

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

        # Filter out downloads from secured sources/folders
        if not include_hidden:
            filtered_list = [d for d in filtered_list if not d.get("hidden")]

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

    def _telegram_call(self, coro, timeout=60):
        """Run a coroutine on the Telegram client's event loop (lives in the
        main thread) and wait for its result."""
        td = self.telegram_downloader
        loop = getattr(td, 'loop', None) if td else None
        if loop is None:
            raise RuntimeError("Telegram client is not running yet")
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=timeout)

    def setup_routes(self):
        """Register all Flask routes (grouped per-domain via mixins)."""
        self.register_auth_routes()
        self.register_download_routes()
        self.register_url_routes()
        self.register_analytics_routes()
        self.register_settings_routes()
        self.register_vps_settings_routes()
        self.register_torrent_routes()
        self.register_vps_browse_routes()
        self.register_media_routes()

        # Serve frontend
        @self.app.route('/')
        def serve_index():
            return send_from_directory(self.app.static_folder, 'index.html')

        @self.app.errorhandler(404)
        def not_found(e):
            # Return JSON 404 for API routes, serve index.html for SPA routes
            if request.path.startswith('/api/') or request.path == '/metrics':
                return jsonify({'error': 'Not found'}), 404
            return send_from_directory(self.app.static_folder, 'index.html')

    def run(self):
        """Run the Flask application with WebSocket support"""
        self.socketio.run(self.app, host=WEB_HOST, port=WEB_PORT, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)

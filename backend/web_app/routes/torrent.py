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
    CLIENTS, read_torrent_settings, write_torrent_settings, load_torrent_config,
    apply_torrent_session, normalize_transmission_url,
    torrent_test, torrent_add_magnet, torrent_list, torrent_control,
)
from backend.web_app.vps import load_vps_credentials, annotate_vps_folders, open_vps_sftp
from backend.web_app.helpers import candidate_file_paths


class TorrentRoutesMixin:
    def register_torrent_routes(self):
        def _client_summary(settings, client):
            from backend.utils import decrypt_secret
            sub = settings.get(client) or {}
            return {
                "configured": bool(sub.get("url")),
                "url": sub.get("url", ""),
                "username": sub.get("username", ""),
                "has_password": bool(decrypt_secret(sub.get("password_enc", ""))),
                "download_dir": sub.get("download_dir", ""),
                "incomplete_dir": sub.get("incomplete_dir", ""),
            }

        @self.app.route("/api/settings/torrent", methods=["GET"])
        @token_required
        def get_torrent_config():
            """Return both clients' saved config (passwords never exposed) and
            the Telegram-magnet default client."""
            settings = read_torrent_settings()
            return jsonify({
                "transmission": _client_summary(settings, "transmission"),
                "qbittorrent": _client_summary(settings, "qbittorrent"),
                "telegram_default": settings.get("telegram_default"),
            })

        @self.app.route("/api/settings/torrent", methods=["POST"])
        @token_required
        def save_torrent_config():
            """Save one client's config. Body: {client, url, username, password?,
            download_dir?, incomplete_dir?}. Password is encrypted at rest; blank
            preserves the previously saved one."""
            from backend.utils import encrypt_secret, decrypt_secret
            data = request.json or {}
            client = (data.get("client") or "").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            url = (data.get("url") or "").strip()
            if client == "transmission":
                url = normalize_transmission_url(url)
            else:
                url = url.rstrip("/")
            if not url.startswith(("http://", "https://")):
                return jsonify({"error": "A valid http(s) URL is required"}), 400

            settings = read_torrent_settings()
            prev = settings.get(client) or {}
            password = data.get("password")
            password_enc = encrypt_secret(password) if password else prev.get("password_enc", "")

            download_dir = (data.get("download_dir") or "").strip()
            incomplete_dir = (data.get("incomplete_dir") or "").strip()
            settings[client] = {
                "url": url,
                "username": (data.get("username") or "").strip(),
                "password_enc": password_enc,
                "download_dir": download_dir,
                "incomplete_dir": incomplete_dir,
            }
            # If this is the only configured client and no Telegram default is
            # set yet, make it the default so Telegram magnets work out of the box.
            other = "qbittorrent" if client == "transmission" else "transmission"
            if not settings.get("telegram_default") and not (settings.get(other) or {}).get("url"):
                settings["telegram_default"] = client
            write_torrent_settings(settings)

            # Best-effort: push the temp dir to the client now. A save still
            # succeeds if the client is unreachable — it's re-applied on add.
            warning = None
            try:
                apply_torrent_session({
                    "client": client,
                    "url": url,
                    "username": settings[client]["username"],
                    "password": decrypt_secret(password_enc),
                    "incomplete_dir": incomplete_dir,
                })
            except ValueError as e:
                warning = f"Saved, but could not apply the temp folder: {e}"

            return jsonify({"status": "saved", "warning": warning,
                            **_client_summary(settings, client)})

        @self.app.route("/api/settings/torrent", methods=["DELETE"])
        @token_required
        def delete_torrent_config():
            """Remove one client's config (?client=...). Clears the Telegram
            default when it pointed at the removed client."""
            client = (request.args.get("client") or "").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            settings = read_torrent_settings()
            settings[client] = {}
            if settings.get("telegram_default") == client:
                settings["telegram_default"] = None
            write_torrent_settings(settings)
            return jsonify({"status": "deleted", "configured": False})

        @self.app.route("/api/settings/torrent/telegram-default", methods=["POST"])
        @token_required
        def set_telegram_default():
            """Set which client receives Telegram-channel magnets. Body: {client}
            (null/empty to clear)."""
            data = request.json or {}
            client = data.get("client")
            if client in (None, "", "none"):
                client = None
            elif client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            settings = read_torrent_settings()
            if client and not (settings.get(client) or {}).get("url"):
                return jsonify({"error": f"{client} is not configured"}), 400
            settings["telegram_default"] = client
            write_torrent_settings(settings)
            return jsonify({"status": "ok", "telegram_default": client})

        @self.app.route("/api/settings/torrent/test", methods=["POST"])
        @token_required
        def test_torrent_connection():
            """Test a client connection. Body: {client, url, username, password?};
            falls back to the saved password when the field is blank."""
            from backend.utils import decrypt_secret
            data = request.json or {}
            client = (data.get("client") or "").strip()
            if client not in CLIENTS:
                return jsonify({"success": False, "error": "Unknown torrent client"}), 400
            url = (data.get("url") or "").strip()
            url = normalize_transmission_url(url) if client == "transmission" else url.rstrip("/")
            if not url.startswith(("http://", "https://")):
                return jsonify({"success": False, "error": "A valid http(s) URL is required"}), 400
            password = data.get("password")
            if not password:
                prev = read_torrent_settings().get(client) or {}
                password = decrypt_secret(prev.get("password_enc", ""))
            cfg = {"client": client, "url": url,
                   "username": (data.get("username") or "").strip(), "password": password or ""}
            try:
                return jsonify({"success": True, "message": torrent_test(client, config=cfg)})
            except ValueError as e:
                return jsonify({"success": False, "error": str(e)})

        @self.app.route("/api/torrent/add", methods=["POST"])
        @token_required
        def add_torrent():
            """Send a magnet to a VPS torrent client.
            Body: {magnet, client, download_dir?} — download_dir is a remote path
            (e.g. a watched folder, so autoSync picks up the result)."""
            data = request.json or {}
            magnet = (data.get("magnet") or "").strip()
            if not magnet.lower().startswith("magnet:"):
                return jsonify({"error": "Not a magnet link"}), 400
            client = (data.get("client") or "").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            download_dir = (data.get("download_dir") or "").strip()
            try:
                result = torrent_add_magnet(client, magnet, download_dir=download_dir or None)
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            return jsonify({
                "status": "duplicate" if result.get("duplicate") else "added",
                "name": result.get("name"),
                "hash": result.get("hash"),
                "download_dir": download_dir or None,
            })

        @self.app.route("/api/torrent/list", methods=["GET"])
        @token_required
        def list_torrents():
            """List torrents for a client (?client=...) with live status.
            Returns {configured, torrents:[...]}."""
            client = (request.args.get("client") or "transmission").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            if not load_torrent_config(client):
                return jsonify({"configured": False, "torrents": []})
            try:
                torrents = torrent_list(client)
            except ValueError as e:
                return jsonify({"configured": True, "error": str(e)}), 502
            return jsonify({"configured": True, "torrents": torrents})

        @self.app.route("/api/torrent/action", methods=["POST"])
        @token_required
        def torrent_action():
            """Control torrents on a VPS client.
            Body: {client, action: start|stop|remove|verify, hashes: [str], delete_data?}.
            'stop' covers pause; 'remove' deletes the torrent (and its data on the
            VPS when delete_data is true); 'verify' rechecks local data then starts
            (recovers "No data found"). Legacy `ids` is accepted as hashes."""
            data = request.json or {}
            client = (data.get("client") or "transmission").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            action = (data.get("action") or "").strip()
            if action not in ("start", "stop", "remove", "verify"):
                return jsonify({"error": f"Unknown action: {action}"}), 400
            hashes = data.get("hashes") or data.get("ids")
            if not isinstance(hashes, list) or not hashes:
                return jsonify({"error": "hashes must be a non-empty list"}), 400
            hashes = [str(h) for h in hashes]
            try:
                torrent_control(client, action, hashes, bool(data.get("delete_data")))
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            return jsonify({"status": "ok", "action": action, "hashes": hashes})


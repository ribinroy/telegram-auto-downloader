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


class SettingsRoutesMixin:
    def register_settings_routes(self):
        @self.app.route("/api/settings/cookies", methods=["GET"])
        @token_required
        def get_cookies():
            """Get current cookies content"""
            cookies_path = Path(__file__).parent.parent.parent / 'cookies.txt'
            if cookies_path.exists():
                return jsonify({"cookies": cookies_path.read_text()})
            return jsonify({"cookies": ""})

        @self.app.route("/api/settings/cookies", methods=["POST"])
        @token_required
        def save_cookies():
            """Save cookies content"""
            data = request.json
            cookies_content = data.get("cookies", "")
            cookies_path = Path(__file__).parent.parent.parent / 'cookies.txt'

            try:
                if cookies_content.strip():
                    cookies_path.write_text(cookies_content)
                else:
                    # Delete file if empty
                    if cookies_path.exists():
                        cookies_path.unlink()
                return jsonify({"status": "saved"})
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        # Telegram API credentials (api_id/api_hash from my.telegram.org)
        @self.app.route("/api/settings/telegram/api", methods=["GET"])
        @token_required
        def get_telegram_api():
            """Current API credential state (hash never exposed)."""
            if not self.telegram_downloader:
                return jsonify({"configured": False, "api_id": None, "has_hash": False, "source": None})
            return jsonify(self.telegram_downloader.get_api_config())

        @self.app.route("/api/settings/telegram/api", methods=["POST"])
        @token_required
        def save_telegram_api():
            """Save API credentials; a blank api_hash keeps the saved one.
            The client is swapped live — no service restart needed."""
            data = request.json or {}
            try:
                api_id = int(data.get("api_id") or 0)
            except (TypeError, ValueError):
                return jsonify({"error": "API ID must be a number"}), 400
            if not api_id:
                return jsonify({"error": "API ID is required"}), 400
            api_hash = (data.get("api_hash") or "").strip()
            try:
                result = self._telegram_call(
                    self.telegram_downloader.set_api_credentials(api_id, api_hash))
                if result.get("error"):
                    return jsonify(result), 400
                return jsonify(result)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        # Telegram account connection & monitored channels
        @self.app.route("/api/settings/telegram/status", methods=["GET"])
        @token_required
        def telegram_status():
            """Connection/authorization status + monitored channels."""
            try:
                status = self._telegram_call(self.telegram_downloader.get_status(), timeout=20)
            except Exception as e:
                return jsonify({
                    "connected": False, "authorized": False,
                    "awaiting_code": False, "user": None,
                    "channels": [], "error": str(e),
                })
            status["channels"] = self.telegram_downloader.get_channels()
            return jsonify(status)

        @self.app.route("/api/settings/telegram/send-code", methods=["POST"])
        @token_required
        def telegram_send_code():
            """Step 1 of web login: send the code to the phone number."""
            phone = ((request.json or {}).get("phone") or "").strip()
            if not phone:
                return jsonify({"error": "Phone number is required"}), 400
            try:
                return jsonify(self._telegram_call(self.telegram_downloader.send_login_code(phone)))
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/verify-code", methods=["POST"])
        @token_required
        def telegram_verify_code():
            """Step 2 of web login: verify the received code."""
            code = ((request.json or {}).get("code") or "").strip().replace(" ", "")
            if not code:
                return jsonify({"error": "Code is required"}), 400
            try:
                result = self._telegram_call(self.telegram_downloader.submit_login_code(code))
                if result.get("error"):
                    return jsonify(result), 400
                return jsonify(result)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/verify-password", methods=["POST"])
        @token_required
        def telegram_verify_password():
            """Step 3 of web login (accounts with 2FA): the cloud password."""
            password = (request.json or {}).get("password") or ""
            if not password:
                return jsonify({"error": "Password is required"}), 400
            try:
                return jsonify(self._telegram_call(self.telegram_downloader.submit_password(password)))
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/bot-login", methods=["POST"])
        @token_required
        def telegram_bot_login():
            """Alternative login: sign in with a BotFather bot token."""
            token = ((request.json or {}).get("token") or "").strip()
            if not token:
                return jsonify({"error": "Bot token is required"}), 400
            try:
                result = self._telegram_call(self.telegram_downloader.submit_bot_token(token))
                if result.get("error"):
                    return jsonify(result), 400
                return jsonify(result)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/logout", methods=["POST"])
        @token_required
        def telegram_logout():
            """Invalidate the Telegram session; a new web login is required."""
            try:
                return jsonify(self._telegram_call(self.telegram_downloader.logout()))
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/channels", methods=["GET"])
        @token_required
        def telegram_channels():
            return jsonify({"channels": self.telegram_downloader.get_channels()
                            if self.telegram_downloader else []})

        @self.app.route("/api/settings/telegram/channels", methods=["POST"])
        @token_required
        def telegram_add_channel():
            """Add a channel by @username, t.me link, or numeric chat ID."""
            identifier = ((request.json or {}).get("chat") or "").strip()
            if not identifier:
                return jsonify({"error": "Channel username or ID is required"}), 400
            try:
                result = self._telegram_call(self.telegram_downloader.add_channel(identifier))
                if result.get("error"):
                    return jsonify(result), 400
                return jsonify(result)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/channels/<chat_id>", methods=["DELETE"])
        @token_required
        def telegram_remove_channel(chat_id):
            # Plain converter: Telegram channel IDs are negative, <int:> won't match
            try:
                chat_id = int(chat_id)
            except ValueError:
                return jsonify({"error": "Invalid chat ID"}), 400
            try:
                return jsonify(self._telegram_call(self.telegram_downloader.remove_channel(chat_id)))
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/settings/telegram/channels/<chat_id>", methods=["PATCH"])
        @token_required
        def telegram_update_channel(chat_id):
            """Set which torrent client this channel's magnets go to.
            Body: {torrent_client: 'transmission'|'qbittorrent'|null}."""
            try:
                chat_id = int(chat_id)
            except ValueError:
                return jsonify({"error": "Invalid chat ID"}), 400
            if not self.telegram_downloader:
                return jsonify({"error": "Telegram is not configured"}), 400
            client = (request.json or {}).get("torrent_client")
            result = self.telegram_downloader.set_channel_torrent_client(chat_id, client)
            if result.get("error"):
                return jsonify(result), 400
            return jsonify(result)

        @self.app.route("/api/settings/telegram/dialogs", methods=["GET"])
        @token_required
        def telegram_dialogs():
            """List the account's channels/groups for the channel picker."""
            try:
                return jsonify({"dialogs": self._telegram_call(self.telegram_downloader.list_dialogs())})
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        # Users (web logins + Telegram users who interacted with the bot)
        @self.app.route("/api/users", methods=["GET"])
        @token_required
        def list_users():
            return jsonify({"users": get_db().get_users()})

        @self.app.route("/api/users/sync", methods=["POST"])
        @token_required
        def sync_users():
            """Pull the member lists of all monitored groups into the users table."""
            try:
                synced = self._telegram_call(
                    self.telegram_downloader.sync_channel_members(), timeout=120)
                return jsonify({"synced": synced, "users": get_db().get_users()})
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/users/<int:user_id>", methods=["PATCH"])
        @token_required
        def update_user(user_id):
            """Change a user's role (admin/user). Web-login users stay admin."""
            role = ((request.json or {}).get("role") or "").strip().lower()
            if role not in ("admin", "user"):
                return jsonify({"error": "Role must be 'admin' or 'user'"}), 400
            db = get_db()
            target = next((u for u in db.get_users() if u["id"] == user_id), None)
            if not target:
                return jsonify({"error": "User not found"}), 404
            if target.get("is_web") and role != "admin":
                return jsonify({"error": "Web login users are always admins"}), 400
            updated = db.update_user_role(user_id, role)
            return jsonify({"user": updated})

        # Bot queries (key -> shell snippet, triggered by tagging the bot)
        @self.app.route("/api/settings/queries", methods=["GET"])
        @token_required
        def get_bot_queries():
            return jsonify({"queries": self.telegram_downloader.get_queries()
                            if self.telegram_downloader else []})

        @self.app.route("/api/settings/queries", methods=["POST"])
        @token_required
        def save_bot_query():
            """Add or update a query (upsert by key; original_key supports renames)."""
            data = request.json or {}
            key = (data.get("key") or "").strip().lower()
            command = (data.get("command") or "").strip()
            original_key = (data.get("original_key") or key).strip().lower()
            if not key or not command:
                return jsonify({"error": "Key and command are required"}), 400
            if ' ' in key or len(key) > 64:
                return jsonify({"error": "Key must be a single word (max 64 chars)"}), 400
            if key == 'help':
                return jsonify({"error": "'help' is reserved for listing the available queries"}), 400
            db = get_db()
            db.upsert_bot_query(key, command, original_key=original_key)
            return jsonify({"queries": db.get_bot_queries()})

        @self.app.route("/api/settings/queries/<key>", methods=["DELETE"])
        @token_required
        def delete_bot_query(key):
            db = get_db()
            db.delete_bot_query(key)
            return jsonify({"queries": db.get_bot_queries()})

        @self.app.route("/api/settings/queries/test", methods=["POST"])
        @token_required
        def test_bot_query():
            """Run a snippet now and return its output (same env as chat triggers)."""
            command = ((request.json or {}).get("command") or "").strip()
            if not command:
                return jsonify({"error": "Command is required"}), 400
            from backend.telegram_handler import TelegramDownloader
            # Stand in for the chat sender with the logged-in web user
            username = (getattr(request, 'user', None) or {}).get('username', 'admin')
            extra_env = {'SENDER_NAME': username, 'SENDER_USERNAME': username, 'SENDER_ID': '', 'CHAT_TITLE': ''}
            return jsonify({"output": TelegramDownloader.run_query_sync(command, extra_env)})

        # VPS (SSH/SFTP) connection settings

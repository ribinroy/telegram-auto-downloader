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


class VpsSettingsRoutesMixin:
    def register_vps_settings_routes(self):
        @self.app.route("/api/settings/vps", methods=["GET"])
        @token_required
        def get_vps_config():
            """Return the saved VPS connection config (password never exposed)."""
            from backend.utils import decrypt_secret
            db = get_db()
            raw = db.get_setting("vps_config")
            if not raw:
                return jsonify({
                    "configured": False, "host": "", "port": 22,
                    "username": "", "remote_path": "", "has_password": False,
                })
            try:
                cfg = json.loads(raw)
            except Exception:
                cfg = {}
            has_password = bool(decrypt_secret(cfg.get("password_enc", "")))
            return jsonify({
                "configured": bool(cfg.get("host")),
                "host": cfg.get("host", ""),
                "port": cfg.get("port", 22),
                "username": cfg.get("username", ""),
                "remote_path": cfg.get("remote_path", ""),
                "has_password": has_password,
            })

        @self.app.route("/api/settings/vps", methods=["POST"])
        @token_required
        def save_vps_config():
            """Save VPS connection config. Password is encrypted at rest.

            If the password field is omitted/blank, the previously saved
            password is preserved.
            """
            from backend.utils import encrypt_secret, decrypt_secret
            data = request.json or {}
            host = (data.get("host") or "").strip()
            username = (data.get("username") or "").strip()
            if not host or not username:
                return jsonify({"error": "Host and username are required"}), 400
            try:
                port = int(data.get("port") or 22)
            except (TypeError, ValueError):
                return jsonify({"error": "Port must be a number"}), 400

            db = get_db()
            # Preserve existing password if a new one wasn't provided
            password = data.get("password")
            if password:
                password_enc = encrypt_secret(password)
            else:
                prev = db.get_setting("vps_config")
                password_enc = ""
                if prev:
                    try:
                        password_enc = json.loads(prev).get("password_enc", "")
                    except Exception:
                        password_enc = ""

            cfg = {
                "host": host,
                "port": port,
                "username": username,
                "remote_path": (data.get("remote_path") or "").strip(),
                "password_enc": password_enc,
            }
            db.set_setting("vps_config", json.dumps(cfg))
            return jsonify({
                "status": "saved",
                "configured": True,
                "has_password": bool(decrypt_secret(password_enc)),
            })

        @self.app.route("/api/settings/vps", methods=["DELETE"])
        @token_required
        def delete_vps_config():
            """Remove the saved VPS connection (credentials). Watched folders are kept."""
            get_db().delete_setting("vps_config")
            return jsonify({"status": "deleted", "configured": False})

        @self.app.route("/api/settings/vps/test", methods=["POST"])
        @token_required
        def test_vps_connection():
            """Test an SSH connection. Uses posted form values, falling back
            to the saved password when the password field is blank."""
            from backend.utils import decrypt_secret
            import paramiko

            data = request.json or {}
            host = (data.get("host") or "").strip()
            username = (data.get("username") or "").strip()
            remote_path = (data.get("remote_path") or "").strip()
            try:
                port = int(data.get("port") or 22)
            except (TypeError, ValueError):
                return jsonify({"success": False, "error": "Port must be a number"}), 400

            if not host or not username:
                return jsonify({"success": False, "error": "Host and username are required"}), 400

            password = data.get("password")
            if not password:
                # Fall back to the saved password
                raw = get_db().get_setting("vps_config")
                if raw:
                    try:
                        password = decrypt_secret(json.loads(raw).get("password_enc", ""))
                    except Exception:
                        password = ""
            if not password:
                return jsonify({"success": False, "error": "No password provided or saved"}), 400

            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                client.connect(
                    hostname=host, port=port, username=username,
                    password=password, timeout=10, allow_agent=False, look_for_keys=False,
                )
                message = f"Connected to {host}:{port} as {username}"
                # If a watch folder is set, confirm it's reachable/listable
                if remote_path:
                    sftp = client.open_sftp()
                    try:
                        entries = sftp.listdir(remote_path)
                        message += f" — {len(entries)} item(s) in {remote_path}"
                    except Exception as e:
                        sftp.close()
                        return jsonify({
                            "success": False,
                            "error": f"Connected, but cannot access '{remote_path}': {e}",
                        })
                    sftp.close()
                return jsonify({"success": True, "message": message})
            except paramiko.AuthenticationException:
                return jsonify({"success": False, "error": "Authentication failed — check username/password"})
            except Exception as e:
                return jsonify({"success": False, "error": str(e)})
            finally:
                client.close()

        # Torrent client (Transmission) settings + magnet handoff

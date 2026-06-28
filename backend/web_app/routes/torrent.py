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


class TorrentRoutesMixin:
    def register_torrent_routes(self):
        @self.app.route("/api/settings/torrent", methods=["GET"])
        @token_required
        def get_torrent_config():
            """Return the saved torrent client config (password never exposed)."""
            from backend.utils import decrypt_secret
            raw = get_db().get_setting("torrent_config")
            if not raw:
                return jsonify({"configured": False, "url": "", "username": "", "has_password": False, "incomplete_dir": ""})
            try:
                cfg = json.loads(raw)
            except Exception:
                cfg = {}
            return jsonify({
                "configured": bool(cfg.get("url")),
                "url": cfg.get("url", ""),
                "username": cfg.get("username", ""),
                "has_password": bool(decrypt_secret(cfg.get("password_enc", ""))),
                "incomplete_dir": cfg.get("incomplete_dir", ""),
            })

        @self.app.route("/api/settings/torrent", methods=["POST"])
        @token_required
        def save_torrent_config():
            """Save the torrent client config. Password is encrypted at rest;
            if omitted/blank, the previously saved password is preserved."""
            from backend.utils import encrypt_secret, decrypt_secret
            data = request.json or {}
            url = normalize_transmission_url(data.get("url") or "")
            if not url.startswith(("http://", "https://")):
                return jsonify({"error": "A valid http(s) URL is required"}), 400

            db = get_db()
            password = data.get("password")
            if password:
                password_enc = encrypt_secret(password)
            else:
                prev = db.get_setting("torrent_config")
                password_enc = ""
                if prev:
                    try:
                        password_enc = json.loads(prev).get("password_enc", "")
                    except Exception:
                        password_enc = ""

            incomplete_dir = (data.get("incomplete_dir") or "").strip()
            cfg = {
                "url": url,
                "username": (data.get("username") or "").strip(),
                "password_enc": password_enc,
                "incomplete_dir": incomplete_dir,
            }
            db.set_setting("torrent_config", json.dumps(cfg))

            # Push the incomplete (temp) dir to Transmission immediately so it
            # takes effect for the whole instance. Best-effort: a save still
            # succeeds if Transmission is unreachable — it is re-applied on add.
            warning = None
            try:
                apply_torrent_session({
                    "url": url,
                    "username": cfg["username"],
                    "password": decrypt_secret(password_enc),
                    "incomplete_dir": incomplete_dir,
                })
            except ValueError as e:
                warning = f"Saved, but could not apply temp folder to Transmission: {e}"

            return jsonify({
                "status": "saved",
                "configured": True,
                "url": url,
                "has_password": bool(decrypt_secret(password_enc)),
                "incomplete_dir": incomplete_dir,
                "warning": warning,
            })

        @self.app.route("/api/settings/torrent", methods=["DELETE"])
        @token_required
        def delete_torrent_config():
            """Remove the saved torrent client config."""
            get_db().delete_setting("torrent_config")
            return jsonify({"status": "deleted", "configured": False})

        @self.app.route("/api/settings/torrent/test", methods=["POST"])
        @token_required
        def test_torrent_connection():
            """Test the Transmission connection. Uses posted form values,
            falling back to the saved password when the password field is blank."""
            from backend.utils import decrypt_secret
            data = request.json or {}
            url = normalize_transmission_url(data.get("url") or "")
            if not url.startswith(("http://", "https://")):
                return jsonify({"success": False, "error": "A valid http(s) URL is required"}), 400
            password = data.get("password")
            if not password:
                raw = get_db().get_setting("torrent_config")
                if raw:
                    try:
                        password = decrypt_secret(json.loads(raw).get("password_enc", ""))
                    except Exception:
                        password = ""
            cfg = {"url": url, "username": (data.get("username") or "").strip(), "password": password or ""}
            try:
                session = transmission_rpc("session-get", config=cfg)
                version = session.get("version", "unknown version")
                return jsonify({"success": True, "message": f"Connected to Transmission {version}"})
            except ValueError as e:
                return jsonify({"success": False, "error": str(e)})

        @self.app.route("/api/torrent/add", methods=["POST"])
        @token_required
        def add_torrent():
            """Send a magnet link to the VPS torrent client.
            Body: {magnet, download_dir?} — download_dir is a remote path
            (e.g. a watched folder, so autoSync picks up the result)."""
            data = request.json or {}
            magnet = (data.get("magnet") or "").strip()
            if not magnet.lower().startswith("magnet:"):
                return jsonify({"error": "Not a magnet link"}), 400
            download_dir = (data.get("download_dir") or "").strip()
            try:
                result = transmission_add_magnet(magnet, download_dir=download_dir or None)
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            added = result.get("torrent-added")
            duplicate = result.get("torrent-duplicate")
            torrent = added or duplicate or {}
            return jsonify({
                "status": "duplicate" if duplicate else "added",
                "name": torrent.get("name"),
                "hash": torrent.get("hashString"),
                "download_dir": download_dir or None,
            })

        @self.app.route("/api/torrent/list", methods=["GET"])
        @token_required
        def list_torrents():
            """List the torrents currently known to the VPS Transmission, with
            live download status. Returns {configured, torrents:[...]}."""
            # Transmission status codes -> readable labels
            STATUS_LABELS = {
                0: "stopped", 1: "check-wait", 2: "checking",
                3: "download-wait", 4: "downloading", 5: "seed-wait", 6: "seeding",
            }
            if not load_torrent_config():
                return jsonify({"configured": False, "torrents": []})
            fields = [
                "id", "name", "hashString", "status", "percentDone",
                "rateDownload", "rateUpload", "totalSize", "eta",
                "downloadDir", "errorString", "addedDate",
                "peersConnected", "peersSendingToUs", "peersGettingFromUs",
                "trackerStats",
            ]
            try:
                result = transmission_rpc("torrent-get", {"fields": fields})
            except ValueError as e:
                return jsonify({"configured": True, "error": str(e)}), 502

            def tracker_max(stats, key):
                """Best (max) tracker-reported count across trackers; trackers
                that haven't reported yet use -1, which we ignore. None if
                nothing has reported."""
                vals = [s.get(key) for s in (stats or []) if isinstance(s.get(key), int) and s.get(key) >= 0]
                return max(vals) if vals else None

            torrents = []
            for t in result.get("torrents", []):
                eta = t.get("eta")
                stats = t.get("trackerStats") or []
                torrents.append({
                    "id": t.get("id"),
                    "name": t.get("name"),
                    "hash": t.get("hashString"),
                    "status": STATUS_LABELS.get(t.get("status"), "unknown"),
                    "percent_done": round((t.get("percentDone") or 0) * 100, 1),
                    "rate_download": t.get("rateDownload") or 0,
                    "rate_upload": t.get("rateUpload") or 0,
                    "total_size": t.get("totalSize") or 0,
                    "eta": eta if isinstance(eta, int) and eta >= 0 else None,
                    "download_dir": t.get("downloadDir"),
                    "error": t.get("errorString") or None,
                    # Unix epoch seconds the torrent was added to Transmission
                    "added_date": t.get("addedDate") or 0,
                    # Connected peers we're exchanging with
                    "peers_connected": t.get("peersConnected") or 0,
                    "seeds_connected": t.get("peersSendingToUs") or 0,
                    "leeches_connected": t.get("peersGettingFromUs") or 0,
                    # Swarm totals reported by trackers (may be null until reported)
                    "seeds_total": tracker_max(stats, "seederCount"),
                    "leeches_total": tracker_max(stats, "leecherCount"),
                })
            return jsonify({"configured": True, "torrents": torrents})

        @self.app.route("/api/torrent/action", methods=["POST"])
        @token_required
        def torrent_action():
            """Control a torrent on the VPS Transmission.
            Body: {action: start|stop|remove, ids: [int], delete_data?: bool}.
            'stop' covers pause; 'remove' deletes the torrent (and its data on
            the VPS when delete_data is true)."""
            data = request.json or {}
            action = (data.get("action") or "").strip()
            ids = data.get("ids")
            if not isinstance(ids, list) or not ids:
                return jsonify({"error": "ids must be a non-empty list"}), 400
            method_map = {
                "start": "torrent-start",
                "stop": "torrent-stop",
                "remove": "torrent-remove",
            }
            method = method_map.get(action)
            if not method:
                return jsonify({"error": f"Unknown action: {action}"}), 400
            args = {"ids": ids}
            if action == "remove" and data.get("delete_data"):
                args["delete-local-data"] = True
            try:
                transmission_rpc(method, args)
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            return jsonify({"status": "ok", "action": action, "ids": ids})


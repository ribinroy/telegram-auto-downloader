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


class VpsBrowseRoutesMixin:
    def register_vps_browse_routes(self):
        @self.app.route("/api/settings/vps/browse", methods=["POST"])
        @token_required
        def browse_vps():
            """List the contents of a remote directory over SFTP (on demand).

            Body: {path?} — absolute path to list; defaults to the login home.
            Returns {path, parent, entries:[{name, path, is_dir}]} with
            directories first. Uses the saved VPS credentials.
            """
            import stat as stat_module
            import posixpath
            data = request.json or {}
            req_path = (data.get("path") or "").strip()

            client = None
            try:
                client, sftp = open_vps_sftp()
                # Resolve target path (default to login home directory)
                path = sftp.normalize(req_path) if req_path else sftp.normalize(".")
                entries = []
                for attr in sftp.listdir_attr(path):
                    name = attr.filename
                    if name in (".", ".."):
                        continue
                    is_dir = stat_module.S_ISDIR(attr.st_mode)
                    entries.append({
                        "name": name,
                        "path": posixpath.join(path, name),
                        "is_dir": is_dir,
                    })
                entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
                parent = posixpath.dirname(path.rstrip("/")) or "/"
                return jsonify({
                    "path": path,
                    "parent": None if path in ("/", "") else parent,
                    "entries": entries,
                })
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            except Exception as e:
                return jsonify({"error": str(e)}), 500
            finally:
                if client:
                    client.close()

        @self.app.route("/api/settings/local/browse", methods=["POST"])
        @token_required
        def browse_local():
            """List the contents of a local directory on the home server (on demand).

            Body: {path?} — absolute path to list; defaults to DOWNLOAD_DIR.
            Returns {path, parent, entries:[{name, path, is_dir}]} with
            directories first. Used by the folder picker (e.g. destination folders).
            """
            from backend.config import DOWNLOAD_DIR
            data = request.json or {}
            req_path = (data.get("path") or "").strip()

            try:
                target = Path(req_path).expanduser() if req_path else Path(DOWNLOAD_DIR)
                target = target.resolve()
                if not target.is_dir():
                    return jsonify({"error": "Not a directory"}), 400

                entries = []
                with os.scandir(target) as it:
                    for de in it:
                        try:
                            is_dir = de.is_dir(follow_symlinks=True)
                        except OSError:
                            is_dir = False
                        entries.append({
                            "name": de.name,
                            "path": str(target / de.name),
                            "is_dir": is_dir,
                        })
                entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
                parent = str(target.parent)
                return jsonify({
                    "path": str(target),
                    "parent": None if target.parent == target else parent,
                    "entries": entries,
                })
            except PermissionError:
                return jsonify({"error": "Permission denied"}), 403
            except FileNotFoundError:
                return jsonify({"error": "Path not found"}), 404
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        @self.app.route("/api/settings/vps/folders", methods=["GET"])
        @token_required
        def get_vps_folders():
            """List the watched VPS folders, tagged active for the current connection."""
            return jsonify({"folders": annotate_vps_folders(get_db().get_vps_watch_folders())})

        @self.app.route("/api/settings/vps/folders", methods=["POST"])
        @token_required
        def add_vps_folders():
            """Add one or more watched folders for the currently saved connection.
            Body: {paths: [...]} or {path}."""
            data = request.json or {}
            creds = load_vps_credentials()
            if not creds:
                return jsonify({"error": "Configure and save a VPS connection first"}), 400
            paths = data.get("paths")
            if paths is None and data.get("path"):
                paths = [data.get("path")]
            if not paths or not isinstance(paths, list):
                return jsonify({"error": "Provide 'paths' (list) or 'path'"}), 400
            db = get_db()
            added = []
            for p in paths:
                p = (p or "").strip()
                if p:
                    added.append(db.add_vps_watch_folder(
                        p, host=creds["host"], port=creds["port"], username=creds["username"],
                    ))
            return jsonify({"folders": annotate_vps_folders(db.get_vps_watch_folders()), "added": added})

        @self.app.route("/api/settings/vps/folders/<int:folder_id>", methods=["DELETE"])
        @token_required
        def delete_vps_folder(folder_id):
            """Remove a watched folder by id."""
            db = get_db()
            folder = next((f for f in db.get_vps_watch_folders() if f["id"] == folder_id), None)
            ok = db.delete_vps_watch_folder(folder_id)
            if not ok:
                return jsonify({"error": "Folder not found"}), 404
            if folder and self.vps_downloader:
                self.vps_downloader.forget_folder(folder["path"])
            return jsonify({"status": "deleted", "folders": annotate_vps_folders(db.get_vps_watch_folders())})

        @self.app.route("/api/settings/vps/folders/<int:folder_id>", methods=["PATCH"])
        @token_required
        def update_vps_folder(folder_id):
            """Update a watched folder's specs. Body: {auto_sync?, folder?, is_secured?}."""
            data = request.json or {}
            update = {k: data[k] for k in ("auto_sync", "folder", "is_secured") if k in data}
            if not update:
                return jsonify({"error": "Nothing to update"}), 400
            db = get_db()
            updated = db.update_vps_watch_folder(folder_id, **update)
            if not updated:
                return jsonify({"error": "Folder not found"}), 404
            # Snapshot current files as baseline when enabling autoSync so only new files sync
            if "auto_sync" in update and self.vps_downloader:
                if updated["auto_sync"]:
                    self.vps_downloader.snapshot_folder(updated["path"])
                else:
                    self.vps_downloader.forget_folder(updated["path"])
            return jsonify({"folder": updated, "folders": annotate_vps_folders(db.get_vps_watch_folders())})

        @self.app.route("/api/vps/files", methods=["GET"])
        @token_required
        def list_vps_files():
            """List live contents (non-recursive) of every watched folder over SFTP.

            Returns {folders:[{path, error?, entries:[{name, path, folder, is_dir,
            size, modified, downloaded, message_id?, status?}]}]}.
            """
            import stat as stat_module
            db = get_db()
            include_hidden = request.args.get("include_hidden", "false").lower() == "true"
            watch_folders = annotate_vps_folders(db.get_vps_watch_folders())
            if not include_hidden:
                watch_folders = [wf for wf in watch_folders if not wf.get("is_secured")]
            # Map existing VPS downloads by remote path for live status
            existing = {}
            for d in db.get_all_downloads():
                if d.get("downloaded_from") == "vps" and d.get("url"):
                    existing[d["url"]] = d

            if not watch_folders:
                return jsonify({"folders": []})

            # Active folders (current connection) are fetched & shown first;
            # inactive ones (other VPS connections) are listed but not fetched.
            active_groups = []
            inactive_groups = []
            for wf in watch_folders:
                base = {
                    "path": wf["path"], "auto_sync": wf.get("auto_sync", False),
                    "active": wf.get("active", False), "host": wf.get("host"),
                    "username": wf.get("username"), "entries": [],
                }
                if wf.get("active"):
                    active_groups.append((wf, base))
                else:
                    base["error"] = "Belongs to a different VPS connection"
                    inactive_groups.append(base)

            if not active_groups:
                return jsonify({"folders": inactive_groups})

            client = None
            try:
                client, sftp = open_vps_sftp()
                for wf, group in active_groups:
                    path = wf["path"]
                    try:
                        for attr in sftp.listdir_attr(path):
                            name = attr.filename
                            if name in (".", ".."):
                                continue
                            is_dir = stat_module.S_ISDIR(attr.st_mode)
                            full = posixpath.join(path, name)
                            entry = {
                                "name": name,
                                "path": full,
                                "folder": path,
                                "is_dir": is_dir,
                                "size": attr.st_size,
                                "modified": (
                                    f"{datetime.utcfromtimestamp(attr.st_mtime).isoformat()}Z"
                                    if attr.st_mtime else None
                                ),
                            }
                            dl = existing.get(full)
                            if dl:
                                entry["downloaded"] = True
                                entry["message_id"] = dl.get("message_id")
                                entry["status"] = dl.get("status")
                            else:
                                entry["downloaded"] = False
                            group["entries"].append(entry)
                        group["entries"].sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
                    except Exception as e:
                        group["error"] = str(e)
                return jsonify({"folders": [g for _, g in active_groups] + inactive_groups})
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            except Exception as e:
                return jsonify({"error": str(e)}), 500
            finally:
                if client:
                    client.close()

        @self.app.route("/api/vps/download", methods=["POST"])
        @token_required
        def download_vps_file():
            """Start downloading a single VPS file/folder.
            Body: {path, size?, client?} — when `client` is a configured torrent
            client with a local folder set, files land there on the home server."""
            if not self.vps_downloader:
                return jsonify({"error": "VPS downloader not available"}), 503
            data = request.json or {}
            path = (data.get("path") or "").strip()
            if not path:
                return jsonify({"error": "path is required"}), 400
            # Per-client local destination override (torrent "Download to DownLee").
            dest = None
            from backend.web_app.torrent import CLIENTS, read_torrent_settings
            client = (data.get("client") or "").strip()
            if client in CLIENTS:
                dest = ((read_torrent_settings().get(client) or {}).get("local_dir") or "").strip() or None
            result = self.vps_downloader.start_download(path, int(data.get("size") or 0), dest=dest)
            if result.get("error"):
                return jsonify(result), 400
            return jsonify(result)

        @self.app.route("/api/vps/delete-remote", methods=["POST"])
        @token_required
        def delete_vps_remote():
            """Permanently delete a file/folder ON the VPS over SFTP. Body: {path}."""
            if not self.vps_downloader:
                return jsonify({"error": "VPS downloader not available"}), 503
            data = request.json or {}
            path = (data.get("path") or "").strip()
            if not path:
                return jsonify({"error": "path is required"}), 400
            try:
                self.vps_downloader.delete_remote(path)
                return jsonify({"status": "deleted"})
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            except Exception as e:
                return jsonify({"error": str(e)}), 500

        # Video file API for playback

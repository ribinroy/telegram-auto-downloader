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
    torrent_test, torrent_add_magnet, torrent_add_file, torrent_list, torrent_control,
    torrent_details, torrent_set_file_priority, torrent_rename,
    torrent_temp_dirs, torrent_file_candidates,
    stop_on_complete_enabled,
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
                "local_dir": sub.get("local_dir", ""),
                "stop_on_complete": stop_on_complete_enabled(sub),
                "hidden": bool(sub.get("hidden", False)),
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
            local_dir = (data.get("local_dir") or "").strip()
            settings[client] = {
                "url": url,
                "username": (data.get("username") or "").strip(),
                "password_enc": password_enc,
                "download_dir": download_dir,
                "incomplete_dir": incomplete_dir,
                "local_dir": local_dir,
                # A full save rewrites the sub-config, so carry the seeding
                # toggle over rather than silently resetting it to the default.
                "stop_on_complete": bool(data["stop_on_complete"]) if "stop_on_complete" in data
                                    else stop_on_complete_enabled(prev),
                "hidden": bool(data["hidden"]) if "hidden" in data
                          else bool(prev.get("hidden", False)),
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

        @self.app.route("/api/settings/torrent/stop-on-complete", methods=["POST"])
        @token_required
        def set_stop_on_complete():
            """Toggle 'stop seeding when complete' for one client:
            {client, enabled}. Its own route so flipping the switch doesn't
            round-trip (and risk clobbering) the whole client config."""
            data = request.json or {}
            client = (data.get("client") or "").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            settings = read_torrent_settings()
            sub = settings.get(client) or {}
            if not sub.get("url"):
                return jsonify({"error": f"{client} is not configured"}), 400
            sub["stop_on_complete"] = bool(data.get("enabled"))
            settings[client] = sub
            write_torrent_settings(settings)
            return jsonify({"status": "saved", **_client_summary(settings, client)})

        @self.app.route("/api/settings/torrent/hidden", methods=["POST"])
        @token_required
        def set_torrent_hidden():
            """Hide one client from the default view: {client, hidden}. A hidden
            client's VPS tab and add-dialog option only appear while secured
            items are shown (double-click the Live badge), like secured sources."""
            data = request.json or {}
            client = (data.get("client") or "").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            settings = read_torrent_settings()
            sub = settings.get(client) or {}
            if not sub.get("url"):
                return jsonify({"error": f"{client} is not configured"}), 400
            sub["hidden"] = bool(data.get("hidden"))
            settings[client] = sub
            write_torrent_settings(settings)
            return jsonify({"status": "saved", **_client_summary(settings, client)})

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

        @self.app.route("/api/torrent/add-file", methods=["POST"])
        @token_required
        def add_torrent_file():
            """Upload a .torrent file to a client. multipart/form-data:
            file=<.torrent>, client=..., download_dir? (a remote VPS path)."""
            client = (request.form.get("client") or "").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            f = request.files.get("file")
            if not f:
                return jsonify({"error": "A .torrent file is required"}), 400
            data = f.read()
            if not data:
                return jsonify({"error": "The uploaded file is empty"}), 400
            download_dir = (request.form.get("download_dir") or "").strip()
            try:
                result = torrent_add_file(client, data, download_dir=download_dir or None)
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            return jsonify({
                "status": "duplicate" if result.get("duplicate") else "added",
                "name": result.get("name"),
                "hash": result.get("hash"),
                "download_dir": download_dir or None,
            })

        def _annotate_downlee_transfers(torrents):
            """Tag each torrent with the VPS->DownLee transfer that already pulled it.

            The UI reads this to show "Downloaded" instead of offering the pull
            again. Matching is by the remote path the download button uses (the
            client's `content_path` - where the files really are, which for a
            qBittorrent torrent need not be <download_dir>/<name>), falling back
            to the basename of the recorded path: a torrent finished through the
            Telegram flow is
            pulled from whichever directory it sat in at the time (temp or
            final), so the exact path can differ from the one it has now.
            Downloads are newest-first, so the fallback picks the latest attempt."""
            by_path, by_name = {}, {}
            for d in get_db().get_all_downloads():
                if d.get("downloaded_from") != "vps" or not d.get("url"):
                    continue
                remote = d["url"]
                by_path.setdefault(remote, d)
                by_name.setdefault(posixpath.basename(remote.rstrip("/")), d)
            for t in torrents:
                name = t.get("name") or ""
                path = t.get("content_path") or posixpath.join((t.get("download_dir") or "").rstrip("/"), name)
                on_disk = posixpath.basename(path.rstrip("/"))
                dl = by_path.get(path) or by_name.get(on_disk) or by_name.get(name)
                t["downlee"] = {
                    "id": dl["id"],
                    "message_id": dl.get("message_id"),
                    "status": dl.get("status"),
                    "progress": dl.get("progress") or 0,
                } if dl else None
            return torrents

        @self.app.route("/api/torrent/list", methods=["GET"])
        @token_required
        def list_torrents():
            """List torrents for a client (?client=...) with live status.
            Returns {configured, torrents:[...]}; each torrent carries a
            `downlee` block when it has already been pulled to DownLee."""
            client = (request.args.get("client") or "transmission").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            if not load_torrent_config(client):
                return jsonify({"configured": False, "torrents": []})
            try:
                torrents = torrent_list(client)
            except ValueError as e:
                return jsonify({"configured": True, "error": str(e)}), 502
            return jsonify({"configured": True, "torrents": _annotate_downlee_transfers(torrents)})

        @self.app.route("/api/torrent/details", methods=["GET"])
        @token_required
        def torrent_details_route():
            """One torrent's files, transfer totals and trackers
            (?client=...&hash=...). See torrent_details() for the shape."""
            client = (request.args.get("client") or "transmission").strip()
            torrent_hash = (request.args.get("hash") or "").strip().lower()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            if not torrent_hash:
                return jsonify({"error": "hash is required"}), 400
            try:
                details = torrent_details(client, torrent_hash)
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            if details is None:
                return jsonify({"error": "That torrent is no longer in the client"}), 404
            # Each file's own VPS->DownLee pull, if one was started for it.
            # Exact path only: a basename fallback would light up every
            # "sample.mkv" across unrelated torrents.
            by_path = {}
            for d in get_db().get_all_downloads():
                if d.get("downloaded_from") == "vps" and d.get("url"):
                    by_path.setdefault(d["url"], d)
            dl_dir = details["torrent"].get("download_dir") or ""
            for f in details["files"]:
                dl = by_path.get(_file_remote_path(dl_dir, f["path"]))
                f["downlee"] = {
                    "id": dl["id"],
                    "message_id": dl.get("message_id"),
                    "status": dl.get("status"),
                    "progress": dl.get("progress") or 0,
                } if dl else None
            return jsonify(details)

        def _file_remote_path(download_dir, path):
            """Where one of a torrent's files sits on the VPS. Both clients
            report file paths relative to the download dir (Transmission's
            downloadDir, qBittorrent's save_path), torrent folder included."""
            return posixpath.join((download_dir or "").rstrip("/"), path or "")

        @self.app.route("/api/torrent/files/download", methods=["POST"])
        @token_required
        def torrent_file_download():
            """Pull individual finished files of a torrent to DownLee - the
            torrent itself need not be finished.
            Body: {client, hash, indices: [int]}. Each file becomes its own VPS
            download, placed where a whole-torrent pull would have put it
            (<base>/<torrent folder>/<sub dirs>/<file>), so pulling the rest
            later doesn't scatter one torrent across two layouts.

            Until the whole torrent completes, a finished file still sits in the
            client's temp dir, so each file is looked up over SFTP (final place,
            then every temp dir). The record keeps the *final* path either way:
            the client moves the file when the torrent completes, and the VPS
            handler falls back to the temp dir on "no such file" (via
            locate_torrent_file), so a resume works on both sides of the move.
            An SFTP read already open survives the move (the client renames,
            or copies and unlinks - an open handle keeps the old inode).
            -> {started: [{index, id, message_id}], errors: [{index, error}]}"""
            if not self.vps_downloader:
                return jsonify({"error": "VPS downloader not available"}), 503
            data = request.json or {}
            client = (data.get("client") or "transmission").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            torrent_hash = (data.get("hash") or "").strip().lower()
            indices = data.get("indices")
            if not torrent_hash:
                return jsonify({"error": "hash is required"}), 400
            if (not isinstance(indices, list) or not indices
                    or not all(isinstance(i, int) and not isinstance(i, bool) and i >= 0 for i in indices)):
                return jsonify({"error": "indices must be a non-empty list of file numbers"}), 400
            try:
                details = torrent_details(client, torrent_hash)
            except ValueError as e:
                return jsonify({"error": str(e)}), 502
            if details is None:
                return jsonify({"error": "That torrent is no longer in the client"}), 404
            t = details["torrent"]

            from backend.config import DOWNLOAD_DIR
            from backend.utils import resolve_spec, spec_folder
            dl_dir = t.get("download_dir") or ""
            local_dir = ((read_torrent_settings().get(client) or {}).get("local_dir") or "").strip()
            temp_dirs = torrent_temp_dirs(client, t)
            files = {f["index"]: f for f in details["files"]}
            started, errors = [], []
            try:
                ssh, sftp = open_vps_sftp()
            except Exception as e:
                return jsonify({"error": f"Couldn't reach the VPS: {e}"}), 502

            def on_vps(f):
                for cand in torrent_file_candidates(dl_dir, f["path"], temp_dirs):
                    try:
                        sftp.stat(cand)
                        return True
                    except IOError:
                        continue
                return False

            try:
                indices = list(dict.fromkeys(indices))
                resolved = {}
                for index in indices:
                    f = files.get(index)
                    if f and f.get("path") and ".." not in f["path"].split("/") and not f["path"].startswith("/"):
                        resolved[index] = f.get("wanted") and (f.get("percent_done") or 0) >= 100 and on_vps(f)
            finally:
                ssh.close()

            for index in indices:
                f = files.get(index)
                if not f:
                    errors.append({"index": index, "error": "No such file in this torrent"})
                    continue
                parts = (f.get("path") or "").split("/")
                # The path comes from the torrent's metadata and is joined onto a
                # local folder - refuse anything that could climb out of it
                if not f.get("path") or f["path"].startswith("/") or any(p in ("", ".", "..") for p in parts):
                    errors.append({"index": index, "error": "Unsafe file path"})
                    continue
                if not f.get("wanted") or (f.get("percent_done") or 0) < 100:
                    errors.append({"index": index, "error": "This file isn't downloaded on the VPS"})
                    continue
                if not resolved.get(index):
                    errors.append({"index": index, "error": "File not found on the VPS"})
                    continue
                remote = _file_remote_path(dl_dir, f["path"])
                base = Path(local_dir) if local_dir else spec_folder(
                    resolve_spec('vps', path=remote), DOWNLOAD_DIR / "VPS")
                dest = base.joinpath(*parts[:-1])
                result = self.vps_downloader.start_download(remote, f.get("size") or 0, dest=str(dest))
                if result.get("error"):
                    errors.append({"index": index, "error": result["error"]})
                else:
                    started.append({"index": index, "id": result.get("id"), "message_id": result.get("message_id")})
            return jsonify({"started": started, "errors": errors}), 200 if started or not errors else 400

        @self.app.route("/api/torrent/rename", methods=["POST"])
        @token_required
        def torrent_rename_route():
            """Rename a torrent's file, or the torrent itself.
            Body: {client, hash, name, path?} - `path` is the file's full path
            as details report it; without it the torrent is renamed."""
            data = request.json or {}
            client = (data.get("client") or "transmission").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            torrent_hash = (data.get("hash") or "").strip().lower()
            if not torrent_hash:
                return jsonify({"error": "hash is required"}), 400
            path = data.get("path")
            if path is not None and (not isinstance(path, str) or not path.strip()):
                return jsonify({"error": "path must be a file path"}), 400
            try:
                torrent_rename(client, torrent_hash, data.get("name"), path=path)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400 if str(e) == "Invalid name" else 502
            return jsonify({"status": "ok"})

        @self.app.route("/api/torrent/files/priority", methods=["POST"])
        @token_required
        def torrent_file_priority():
            """Skip files or set their priority.
            Body: {client, hash, indices: [int], priority} - priority is one of
            the client's levels (details' `priorities`; 'skip' = don't download)."""
            data = request.json or {}
            client = (data.get("client") or "transmission").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            torrent_hash = (data.get("hash") or "").strip().lower()
            indices = data.get("indices")
            if not torrent_hash:
                return jsonify({"error": "hash is required"}), 400
            if (not isinstance(indices, list) or not indices
                    or not all(isinstance(i, int) and not isinstance(i, bool) and i >= 0 for i in indices)):
                return jsonify({"error": "indices must be a non-empty list of file numbers"}), 400
            try:
                torrent_set_file_priority(client, torrent_hash, indices, (data.get("priority") or "").strip())
            except ValueError as e:
                return jsonify({"error": str(e)}), 400 if "no file priority" in str(e) else 502
            return jsonify({"status": "ok"})

        @self.app.route("/api/torrent/action", methods=["POST"])
        @token_required
        def torrent_action():
            """Control torrents on a VPS client.
            Body: {client, action: start|force-start|stop|remove|verify,
            hashes: [str], delete_data?}. 'stop' covers pause; 'force-start'
            jumps the client's download queue (Transmission torrent-start-now,
            qBittorrent setForceStart) for a torrent sitting in 'download-wait';
            'remove' deletes the torrent (and its data on the VPS when
            delete_data is true); 'verify' rechecks local data then starts
            (recovers "No data found"). Legacy `ids` is accepted as hashes."""
            data = request.json or {}
            client = (data.get("client") or "transmission").strip()
            if client not in CLIENTS:
                return jsonify({"error": "Unknown torrent client"}), 400
            action = (data.get("action") or "").strip()
            if action not in ("start", "force-start", "stop", "remove", "verify"):
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


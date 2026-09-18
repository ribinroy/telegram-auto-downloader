"""File explorer routes - live browsing of the host filesystem.

Everything is read straight from disk per request (no index, no cache), so the
UI always shows the drive's current state. The filesystem work itself lives in
backend/files.py; this module is transport only: parse, dispatch, map FsError
onto a status code.

Auth note: browsing and mutating go through @token_required, while the three
routes a browser element loads by URL (stream, thumb, download) use
@media_token_required - <video>/<img> cannot set an Authorization header, and
the media token is scoped and separately revocable.
"""
import mimetypes
from pathlib import Path

from flask import jsonify, request, send_file

from backend import files as fs
from backend.database import get_db
from backend.web_app.base import token_required, media_token_required
from backend.web_app.helpers import range_response


def _configured_roots(seen, include_hidden=False):
    """DownLee's own destination folders, as sidebar places.

    These are the folders the rest of the app already writes to - per-source
    mappings, VPS watched-folder destinations, a torrent client's local dir -
    so the explorer opens where the files actually land instead of making the
    user remember the path.

    A source or watched folder marked `is_secured` is hidden everywhere else in
    the app, so its destination stays out of this list too unless the caller
    asks for hidden entries. A folder shared by a secured and a plain source
    still shows - it is not a secret address - but the secured source is left
    out of the "what points here" note, which otherwise leaks the name.

    Never fatal: a database hiccup just means the section is empty.
    """
    contributors = {}

    def note(path, label, secured=False):
        path = (path or '').strip()
        if path:
            contributors.setdefault(path, []).append((label, bool(secured)))

    try:
        db = get_db()
        for mapping in db.get_all_download_type_maps():
            note(mapping.get('folder'), mapping.get('downloaded_from') or 'source',
                 mapping.get('is_secured'))
        for folder in db.get_vps_watch_folders():
            note(folder.get('folder'), f"VPS {folder.get('path') or ''}".strip(),
                 folder.get('is_secured'))
        from backend.web_app.torrent import read_torrent_settings
        settings = read_torrent_settings()
        for client in ('transmission', 'qbittorrent'):
            note((settings.get(client) or {}).get('local_dir'), client)
    except Exception as e:  # noqa: BLE001 - the sidebar must still render
        print(f"file explorer: could not read configured folders: {e}")

    roots = []
    for path, labels in contributors.items():
        visible = [label for label, secured in labels if include_hidden or not secured]
        if not visible:
            continue
        root = fs.describe_root(path, Path(path).name or path, 'configured',
                                'configured', ', '.join(dict.fromkeys(visible)))
        if root and root['path'] not in seen:
            seen.add(root['path'])
            roots.append(root)
    return roots


def _fs_error(e):
    return jsonify({"error": e.message}), e.status


class FilesRoutesMixin:
    def register_files_routes(self):

        # The VPS is a second, remote "drive". Paths carry a `vps:` prefix and
        # are dispatched here, so backend/files.py stays pure local filesystem.
        from backend import remote_files as rfs

        @self.app.route("/api/files/roots", methods=["GET"])
        @token_required
        def files_roots():
            """Sidebar places, grouped: every mounted disk, the general
            folders (Home, the download dir), then DownLee's own configured
            destinations. All read live.

            `include_hidden=true` also lists destinations belonging to secured
            sources and watched folders, matching the downloads list and the
            VPS page.
            """
            include_hidden = request.args.get("include_hidden", "false").lower() == "true"
            roots = fs.list_roots()
            # No SSH here: the VPS entry is built from the saved config alone,
            # so a page load never waits on a login across the internet.
            roots += rfs.list_roots()
            roots += _configured_roots({r["path"] for r in roots}, include_hidden)
            return jsonify({
                "roots": roots,
                "readonly": fs.EXPLORER_READONLY,
                "home": str(Path.home()),
                "default": str(fs.DOWNLOAD_DIR),
            })

        @self.app.route("/api/files/list", methods=["POST"])
        @token_required
        def files_list():
            """Body: {path?, show_hidden?}. Live listing of one directory."""
            data = request.json or {}
            backend = rfs if rfs.is_remote(data.get("path")) else fs
            try:
                return jsonify(backend.list_dir(data.get("path"),
                                                show_hidden=bool(data.get("show_hidden"))))
            except fs.FsError as e:
                return _fs_error(e)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/files/mkdir", methods=["POST"])
        @token_required
        def files_mkdir():
            """Body: {path, name}."""
            data = request.json or {}
            if rfs.is_remote(data.get("path")):
                return jsonify({"error": "Creating folders on the VPS isn't supported yet"}), 400
            try:
                return jsonify({"entry": fs.make_dir(data.get("path"), data.get("name"))})
            except fs.FsError as e:
                return _fs_error(e)

        @self.app.route("/api/files/rename", methods=["POST"])
        @token_required
        def files_rename():
            """Body: {path, name}."""
            data = request.json or {}
            if rfs.is_remote(data.get("path")):
                return jsonify({"error": "Renaming on the VPS isn't supported yet"}), 400
            try:
                return jsonify({"entry": fs.rename(data.get("path"), data.get("name"))})
            except fs.FsError as e:
                return _fs_error(e)

        @self.app.route("/api/files/delete", methods=["POST"])
        @token_required
        def files_delete():
            """Body: {paths:[...], permanent?}.

            Default is a move to the mount's own .downlee-trash, which keeps a
            delete a rename (instant, even for a 50 GB file) and keeps a
            mis-click recoverable. `permanent` unlinks for real.
            """
            data = request.json or {}
            paths = data.get("paths") or ([data["path"]] if data.get("path") else [])
            if not paths:
                return jsonify({"error": "paths is required"}), 400
            if rfs.any_remote(paths):
                if not all(rfs.is_remote(p) for p in paths):
                    return jsonify({"error": "Select local or VPS items, not both"}), 400
                try:
                    # Always permanent remotely - see remote_files.delete.
                    out = rfs.delete(paths)
                except fs.FsError as e:
                    return _fs_error(e)
                except ValueError as e:
                    return jsonify({"error": str(e)}), 400
                return jsonify({"results": [{"path": p} for p in out["removed"]],
                                "errors": out["errors"], "permanent": True})
            try:
                results = fs.delete(paths, permanent=bool(data.get("permanent")))
            except fs.FsError as e:
                return _fs_error(e)
            return jsonify({"results": results,
                            "errors": [r for r in results if r.get("error")]})

        @self.app.route("/api/files/transfer", methods=["POST"])
        @token_required
        def files_transfer():
            """Body: {paths:[...], dest, move?} - copy or move a selection."""
            data = request.json or {}
            paths = data.get("paths") or []
            dest = data.get("dest")
            if not paths or not dest:
                return jsonify({"error": "paths and dest are required"}), 400

            # VPS -> home server is a download, not a copy: hand it to the SFTP
            # handler, which gives a proper record with progress, resume and the
            # watchdog behind it. Doing it inline would block the request for
            # however long a 50 GB folder takes.
            if rfs.any_remote(paths):
                if rfs.is_remote(dest):
                    return jsonify({"error": "Copying within the VPS isn't supported yet"}), 400
                if not all(rfs.is_remote(p) for p in paths):
                    return jsonify({"error": "Select local or VPS items, not both"}), 400
                if data.get("move"):
                    return jsonify({"error": "Moving off the VPS isn't supported - copy, then delete"}), 400
                if not self.vps_downloader:
                    return jsonify({"error": "VPS downloader is not running"}), 503
                started, errors = [], []
                for raw in paths:
                    res = self.vps_downloader.start_download(rfs.strip(raw), dest=dest)
                    if res.get("error"):
                        errors.append({"path": raw, "error": res["error"]})
                    else:
                        started.append({"path": raw, "message_id": res.get("message_id")})
                return jsonify({"results": started, "errors": errors, "download": True})

            if rfs.is_remote(dest):
                return jsonify({"error": "Uploading to the VPS isn't supported yet"}), 400
            try:
                results = fs.transfer(paths, dest, move=bool(data.get("move")))
            except fs.FsError as e:
                return _fs_error(e)
            return jsonify({"results": results,
                            "errors": [r for r in results if r.get("error")]})

        @self.app.route("/api/files/upload", methods=["POST"])
        @token_required
        def files_upload():
            """Multipart upload into a directory. Form: path + files[]."""
            dest = (request.form.get("path") or "").strip()
            uploaded = request.files.getlist("files")
            if not dest or not uploaded:
                return jsonify({"error": "path and files are required"}), 400
            if rfs.is_remote(dest):
                return jsonify({"error": "Uploading to the VPS isn't supported yet"}), 400
            entries, errors = [], []
            for item in uploaded:
                try:
                    entries.append(fs.save_upload(dest, item.filename, item))
                except fs.FsError as e:
                    errors.append({"name": item.filename, "error": e.message})
            return jsonify({"entries": entries, "errors": errors})

        @self.app.route("/api/files/search", methods=["POST"])
        @token_required
        def files_search():
            """Body: {path, query, show_hidden?} - recursive name search,
            bounded by a result cap and a wall-clock deadline."""
            data = request.json or {}
            backend = rfs if rfs.is_remote(data.get("path")) else fs
            try:
                return jsonify(backend.search(data.get("path"), data.get("query"),
                                              show_hidden=bool(data.get("show_hidden"))))
            except fs.FsError as e:
                return _fs_error(e)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/files/size", methods=["POST"])
        @token_required
        def files_size():
            """Body: {path} - recursive size of a folder (on demand: walking a
            library is far too slow to do for every row of a listing)."""
            data = request.json or {}
            backend = rfs if rfs.is_remote(data.get("path")) else fs
            try:
                return jsonify(backend.dir_size(data.get("path")))
            except fs.FsError as e:
                return _fs_error(e)
            except (OSError, ValueError) as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/files/text", methods=["POST"])
        @token_required
        def files_text():
            """Body: {path} - decoded head of a text file for the preview."""
            data = request.json or {}
            backend = rfs if rfs.is_remote(data.get("path")) else fs
            try:
                return jsonify(backend.read_text(data.get("path")))
            except fs.FsError as e:
                return _fs_error(e)
            except (OSError, ValueError) as e:
                return jsonify({"error": str(e)}), 400

        @self.app.route("/api/files/stream", methods=["GET"])
        @media_token_required
        def files_stream():
            """Range-streamed playback of any file by path (?path=...)."""
            try:
                path = fs.resolve_path(request.args.get("path"))
            except fs.FsError as e:
                return _fs_error(e)
            if path.is_dir():
                return jsonify({"error": "Not a file"}), 400
            return range_response(path)

        @self.app.route("/api/files/download", methods=["GET"])
        @media_token_required
        def files_download():
            """Save a file to the browser (?path=...)."""
            try:
                path = fs.resolve_path(request.args.get("path"))
            except fs.FsError as e:
                return _fs_error(e)
            if path.is_dir():
                return jsonify({"error": "Cannot download a folder"}), 400
            return range_response(path, download_name=path.name)

        @self.app.route("/api/files/thumb", methods=["GET"])
        @media_token_required
        def files_thumb():
            """Cached JPEG preview for an image or video (?path=...).

            Videos get a frame pulled with ffmpeg on first request; the cache
            key includes mtime and size, so replacing a file in place
            invalidates it on its own.
            """
            try:
                thumb = fs.thumbnail(request.args.get("path"))
            except fs.FsError as e:
                return _fs_error(e)
            if not thumb:
                return jsonify({"error": "No preview available"}), 404
            mime = mimetypes.guess_type(str(thumb))[0] or 'image/jpeg'
            return send_file(str(thumb), mimetype=mime, conditional=True)

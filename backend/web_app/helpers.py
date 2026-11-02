"""Misc web helpers."""
from pathlib import Path


def candidate_file_paths(download, file_name):
    """Possible on-disk locations for a download's file, most specific first
    (the source's configured destination folder, then the defaults)."""
    from backend.config import DOWNLOAD_DIR
    from backend.utils import resolve_spec
    source = download.get("downloaded_from") or 'telegram'
    paths = [
        DOWNLOAD_DIR / file_name,
        DOWNLOAD_DIR / "Videos" / file_name,
    ]
    if source == 'vps':
        paths.insert(0, DOWNLOAD_DIR / "VPS" / file_name)
    spec = resolve_spec(source, path=download.get("url") if source == 'vps' else None)
    if spec.get("folder"):
        paths.insert(0, Path(spec["folder"]) / file_name)
    # A VPS transfer started with an explicit destination (e.g. a torrent
    # client's local_dir) can't be derived from the spec - it's on the record.
    if download.get("dest_base"):
        paths.insert(0, Path(download["dest_base"]) / file_name)
    return paths


def existing_variant(path, source='vps'):
    """`path`, or - when nothing is there - the same file under the name the
    rename rules give it, if *that* exists.

    A single-file pull renames the file itself, while a folder pull keeps the
    files inside it as they are (only its top folder is renamed). So a file
    pulled on its own first sits at `ep 01.mkv` while the folder pull of the
    same torrent looks for `ep.01.mkv` - and without this would fetch the
    whole thing again next to it."""
    path = Path(path)
    if path.exists():
        return path
    try:
        from backend.rename import rename_for_download
        alt = path.with_name(rename_for_download(path.name, source))
    except Exception:  # noqa: BLE001 - a broken rule must not break a listing
        return path
    return alt if alt != path and alt.exists() else path


def local_copy_exists(download):
    """Whether a download's file (or folder) is still on the home server.
    A finished pull whose local copy was deleted since is no longer "already
    downloaded" - it can be pulled again."""
    file_name = download.get("file")
    return bool(file_name) and any(p.exists() for p in candidate_file_paths(download, file_name))


def range_response(file_path, mime_type=None, download_name=None):
    """Serve a file with HTTP range support, streamed in 1 MB chunks.

    Seeking in a <video> is a Range request, and a 4 GB remux must never be
    buffered into memory to answer one - hence the generator. Shared by the
    per-download stream route and the file explorer's stream-by-path route.
    """
    import mimetypes
    from flask import Response, request

    file_path = Path(file_path)
    file_size = file_path.stat().st_size
    mime_type = mime_type or mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
    chunk_size = 1024 * 1024

    def body(start, length):
        def generate():
            with open(file_path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(chunk_size, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
        return generate

    range_header = request.headers.get('Range')
    if range_header:
        byte_start, byte_end = 0, file_size - 1
        spec = range_header.replace('bytes=', '').split('-')
        if spec[0]:
            byte_start = int(spec[0])
        if len(spec) > 1 and spec[1]:
            byte_end = int(spec[1])
        byte_end = min(byte_end, file_size - 1)
        byte_start = min(byte_start, max(file_size - 1, 0))
        content_length = max(byte_end - byte_start + 1, 0)
        response = Response(body(byte_start, content_length)(), status=206,
                            mimetype=mime_type, direct_passthrough=True)
        response.headers['Content-Range'] = f'bytes {byte_start}-{byte_end}/{file_size}'
    else:
        response = Response(body(0, file_size)(), status=200,
                            mimetype=mime_type, direct_passthrough=True)
        content_length = file_size

    response.headers['Accept-Ranges'] = 'bytes'
    response.headers['Content-Length'] = content_length
    if download_name:
        # RFC 5987: keep non-ASCII filenames intact for the browser's save dialog.
        from urllib.parse import quote
        response.headers['Content-Disposition'] = (
            f"attachment; filename*=UTF-8''{quote(download_name)}")
    return response

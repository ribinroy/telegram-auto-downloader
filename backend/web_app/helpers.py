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
    return paths


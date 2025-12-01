"""
yt-dlp download handler for URL-based downloads
"""
import asyncio
import subprocess
import json
import re
import os
import logging
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from backend.config import DOWNLOAD_DIR
from backend.database import get_db, generate_uuid
from backend.web_app import get_socketio

logger = logging.getLogger(__name__)


class YtdlpDownloader:
    # yt-dlp binary path
    YTDLP_PATH = str(Path(__file__).parent.parent.parent / 'venv' / 'bin' / 'yt-dlp')

    # Browser to extract cookies from for authentication/Cloudflare bypass
    # Options: 'chrome', 'firefox', 'brave', 'edge', 'chromium', 'opera', 'vivaldi', 'safari'
    # Set to None to disable cookie extraction
    COOKIES_FROM_BROWSER = None

    # Path to cookies.txt file (Netscape format) - alternative to browser cookies
    # Export from browser using "Get cookies.txt LOCALLY" extension
    # Set to None to disable
    COOKIES_FILE = str(Path(__file__).parent.parent.parent / 'cookies.txt')

    def __init__(self, download_tasks):
        self.download_tasks = download_tasks
        self.processes = {}  # Track running yt-dlp processes by message_id

    def get_domain(self, url: str) -> str:
        """Extract site name from URL (e.g., youtube.com -> youtube)"""
        try:
            parsed = urlparse(url)
            domain = parsed.netloc
            # Remove www. prefix if present
            if domain.startswith('www.'):
                domain = domain[4:]
            # Extract just the site name (remove TLD)
            # e.g., youtube.com -> youtube, x.com -> x, tiktok.com -> tiktok
            parts = domain.split('.')
            if len(parts) >= 2:
                # Handle special cases like co.uk, com.br etc.
                if parts[-2] in ('co', 'com', 'org', 'net') and len(parts) >= 3:
                    return parts[-3]
                return parts[-2]
            return domain
        except Exception:
            return 'unknown'

    def _get_cookie_args(self) -> list:
        """Get cookie arguments for yt-dlp command"""
        if self.COOKIES_FROM_BROWSER:
            return ['--cookies-from-browser', self.COOKIES_FROM_BROWSER]
        elif self.COOKIES_FILE and os.path.exists(self.COOKIES_FILE):
            return ['--cookies', self.COOKIES_FILE]
        return []

    def check_url(self, url: str) -> dict:
        """Check if URL is supported by yt-dlp and get video info with available formats"""
        try:
            cmd = [
                self.YTDLP_PATH,
                '--dump-json',
                '--no-download',
                '--extractor-args', 'generic:impersonate',  # Cloudflare bypass
            ]
            cmd.extend(self._get_cookie_args())
            cmd.append(url)

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60
            )

            if result.returncode != 0:
                error_msg = result.stderr.strip()
                # Extract meaningful error message
                if 'Unsupported URL' in error_msg:
                    return {'supported': False, 'error': 'Unsupported URL'}
                if 'Video unavailable' in error_msg:
                    return {'supported': False, 'error': 'Video unavailable'}
                if 'Private video' in error_msg:
                    return {'supported': False, 'error': 'Private video'}
                return {'supported': False, 'error': error_msg[:200] if error_msg else 'Unknown error'}

            info = json.loads(result.stdout)

            # Extract available formats
            formats = []
            seen = set()  # Track unique format combinations
            raw_formats = info.get('formats', [])

            for fmt in raw_formats:
                format_id = fmt.get('format_id', '')
                ext = fmt.get('ext', '')
                height = fmt.get('height')
                width = fmt.get('width')
                vcodec = fmt.get('vcodec', 'none')
                acodec = fmt.get('acodec', 'none')
                filesize = fmt.get('filesize') or fmt.get('filesize_approx')
                tbr = fmt.get('tbr')  # Total bitrate

                # Skip formats without video (audio-only) unless it's the only option
                has_video = vcodec and vcodec != 'none'
                has_audio = acodec and acodec != 'none'

                # Create a readable label
                if has_video and height:
                    resolution = f"{height}p"
                    # Create unique key for deduplication
                    key = (height, ext)
                    if key in seen:
                        continue
                    seen.add(key)

                    formats.append({
                        'format_id': format_id,
                        'ext': ext,
                        'resolution': resolution,
                        'height': height,
                        'width': width,
                        'filesize': filesize,
                        'has_audio': has_audio,
                        'tbr': tbr,
                        'label': f"{resolution} ({ext.upper()}){'' if has_audio else ' - no audio'}"
                    })

            # Sort by height (resolution) descending
            formats.sort(key=lambda x: (x.get('height') or 0), reverse=True)

            # If no video formats found, add a default "best" option
            if not formats:
                formats.append({
                    'format_id': 'best',
                    'ext': info.get('ext', 'mp4'),
                    'resolution': 'best',
                    'height': None,
                    'filesize': info.get('filesize') or info.get('filesize_approx'),
                    'has_audio': True,
                    'label': 'Best available'
                })

            # Get the best format (first after sorting)
            best_format_id = formats[0]['format_id'] if formats else 'best'

            return {
                'supported': True,
                'title': info.get('title', 'Unknown'),
                'duration': info.get('duration'),
                'filesize': info.get('filesize') or info.get('filesize_approx'),
                'ext': info.get('ext', 'mp4'),
                'uploader': info.get('uploader'),
                'formats': formats,
                'best_format_id': best_format_id,
            }
        except subprocess.TimeoutExpired:
            return {'supported': False, 'error': 'Request timed out'}
        except json.JSONDecodeError:
            return {'supported': False, 'error': 'Failed to parse video info'}
        except FileNotFoundError:
            return {'supported': False, 'error': 'yt-dlp is not installed'}
        except Exception as e:
            return {'supported': False, 'error': str(e)}

    def emit_progress(self, message_id: str, progress: float, downloaded_bytes: int,
                      total_bytes: int, speed: float, pending_time: float | None):
        """Emit progress update for a specific download"""
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:progress', {
                'message_id': message_id,
                'progress': progress,
                'downloaded_bytes': downloaded_bytes,
                'total_bytes': total_bytes,
                'speed': speed,
                'pending_time': pending_time
            })

    def emit_status(self, message_id: str, status: str, error: str | None = None):
        """Emit status change for a specific download"""
        socketio = get_socketio()
        if socketio:
            data = {'message_id': message_id, 'status': status}
            if error:
                data['error'] = error
            socketio.emit('download:status', data)

    def emit_new_download(self, download: dict):
        """Emit new download added event"""
        socketio = get_socketio()
        if socketio:
            socketio.emit('download:new', download)

    def parse_progress(self, line: str) -> dict | None:
        """Parse yt-dlp progress output"""
        # Match pattern like: [download]  45.2% of ~  85.48MiB at  831.64KiB/s ETA 01:01 (frag 101/247)
        # Also matches: [download]  45.2% of 150.00MiB at 2.50MiB/s ETA 00:35
        progress_pattern = r'\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*(\d+\.?\d*)\s*(Ki?B|Mi?B|Gi?B)\s+at\s+(\d+\.?\d*)\s*(Ki?B|Mi?B|Gi?B)/s\s+ETA\s+(\d+:\d+(?::\d+)?)'
        match = re.search(progress_pattern, line)

        if match:
            progress = float(match.group(1))
            size_value = float(match.group(2))
            size_unit = match.group(3)
            speed_value = float(match.group(4))
            speed_unit = match.group(5)
            eta = match.group(6)

            # Convert to bytes
            unit_multipliers = {'KiB': 1024, 'KB': 1000, 'MiB': 1024**2, 'MB': 1000**2, 'GiB': 1024**3, 'GB': 1000**3}
            total_bytes = int(size_value * unit_multipliers.get(size_unit, 1))
            speed_bytes = speed_value * unit_multipliers.get(speed_unit, 1)
            downloaded_bytes = int(total_bytes * progress / 100)

            # Parse ETA to seconds
            eta_parts = eta.split(':')
            if len(eta_parts) == 2:
                pending_time = int(eta_parts[0]) * 60 + int(eta_parts[1])
            elif len(eta_parts) == 3:
                pending_time = int(eta_parts[0]) * 3600 + int(eta_parts[1]) * 60 + int(eta_parts[2])
            else:
                pending_time = None

            return {
                'progress': progress,
                'downloaded_bytes': downloaded_bytes,
                'total_bytes': total_bytes,
                'speed': speed_bytes / 1024,  # KB/s
                'pending_time': pending_time
            }

        # Check for completion
        if '[download] 100%' in line or 'has already been downloaded' in line:
            return {'progress': 100, 'complete': True}

        return None

    async def download(self, url: str, message_id: str, format_id: str = None):
        """Download video using yt-dlp with progress tracking"""
        import sys
        db = get_db()
        print(f"[yt-dlp] Starting download: {url} (id: {message_id}, format: {format_id})", flush=True)
        sys.stdout.flush()

        # Get the source name and check for custom folder mapping
        source = self.get_domain(url)
        mapping = db.get_download_type_map(source)

        # Use custom folder from mapping if it exists and is accessible
        output_dir = None
        if mapping and mapping.get('folder'):
            custom_folder = Path(mapping['folder'])
            try:
                # Check if folder exists or can be created
                if custom_folder.exists() or custom_folder.parent.exists():
                    custom_folder.mkdir(parents=True, exist_ok=True)
                    output_dir = custom_folder
                    print(f"[yt-dlp] Using custom folder: {output_dir}")
            except (OSError, PermissionError) as e:
                print(f"[yt-dlp] Custom folder not accessible: {e}, falling back to default")

        # Fall back to default folder
        if output_dir is None:
            output_dir = DOWNLOAD_DIR / "Videos"
            output_dir.mkdir(parents=True, exist_ok=True)

        output_template = str(output_dir / "%(title)s.%(ext)s")

        try:
            print(f"[yt-dlp] Output dir: {output_dir}")

            # Build command with optional format selection
            cmd = [
                self.YTDLP_PATH,
                '--newline',  # Output progress on new lines
                '-c',  # Continue/resume partial downloads
                '-o', output_template,
                '--no-mtime',  # Don't set file modification time
                '--extractor-args', 'generic:impersonate',  # Cloudflare bypass
            ]

            # Add cookies for authentication/Cloudflare bypass
            cmd.extend(self._get_cookie_args())

            # Add format selection if specified
            if format_id and format_id != 'best':
                # Request specific format + best audio, or just the format if it has audio
                cmd.extend(['-f', f'{format_id}+bestaudio/best/{format_id}'])

            cmd.append(url)

            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT
            )
            print(f"[yt-dlp] Process started: PID {process.pid}")

            self.processes[message_id] = process
            last_update = 0

            async for line in process.stdout:
                line_str = line.decode('utf-8', errors='ignore').strip()

                if not line_str:
                    continue

                # Log all output for debugging
                print(f"[yt-dlp] {line_str}")

                # Parse progress
                progress_info = self.parse_progress(line_str)
                if progress_info:
                    now = datetime.now().timestamp()

                    # Throttle updates to once per second
                    if now - last_update >= 1:
                        last_update = now

                        if progress_info.get('complete'):
                            continue

                        db.update_download_by_message_id(
                            message_id,
                            progress=progress_info['progress'],
                            downloaded_bytes=progress_info['downloaded_bytes'],
                            total_bytes=progress_info['total_bytes'],
                            speed=progress_info['speed'],
                            pending_time=progress_info.get('pending_time')
                        )

                        self.emit_progress(
                            message_id,
                            progress_info['progress'],
                            progress_info['downloaded_bytes'],
                            progress_info['total_bytes'],
                            progress_info['speed'],
                            progress_info.get('pending_time')
                        )

                # Check for filename
                if '[download] Destination:' in line_str:
                    filename = line_str.split('[download] Destination:')[-1].strip()
                    filename = os.path.basename(filename)
                    db.update_download_by_message_id(message_id, file=filename)

                # Check for already downloaded
                if 'has already been downloaded' in line_str:
                    db.update_download_by_message_id(
                        message_id,
                        status='done',
                        progress=100,
                        speed=0,
                        pending_time=0
                    )
                    self.emit_status(message_id, 'done')
                    return

            await process.wait()
            print(f"[yt-dlp] Process exited with code: {process.returncode}")

            if process.returncode == 0:
                db.update_download_by_message_id(
                    message_id,
                    status='done',
                    progress=100,
                    speed=0,
                    pending_time=0
                )
                self.emit_status(message_id, 'done')
                print(f"[yt-dlp] Download completed: {message_id}")
            else:
                db.update_download_by_message_id(
                    message_id,
                    status='failed',
                    speed=0,
                    error='Download failed'
                )
                self.emit_status(message_id, 'failed', 'Download failed')
                print(f"[yt-dlp] Download failed: {message_id}")

        except asyncio.CancelledError:
            print(f"[yt-dlp] Download cancelled: {message_id}")
            # Kill the process if cancelled
            if message_id in self.processes:
                self.processes[message_id].terminate()
                try:
                    await asyncio.wait_for(self.processes[message_id].wait(), timeout=5)
                except asyncio.TimeoutError:
                    self.processes[message_id].kill()

            db.update_download_by_message_id(message_id, status='stopped', speed=0)
            self.emit_status(message_id, 'stopped')
        except Exception as e:
            print(f"[yt-dlp] Download error: {e}")
            import traceback
            traceback.print_exc()
            db.update_download_by_message_id(
                message_id,
                status='failed',
                speed=0,
                error=str(e)
            )
            self.emit_status(message_id, 'failed', str(e))
        finally:
            self.processes.pop(message_id, None)
            self.download_tasks.pop(message_id, None)

    def start_download(self, url: str, loop, format_id: str = None, title: str = None, ext: str = None, filesize: int = None, resolution: str = None) -> dict:
        """Start a new download and return the download info"""
        db = get_db()

        # If title/ext not provided, check URL to get info
        if not title:
            check_result = self.check_url(url)
            if not check_result['supported']:
                return {'error': check_result['error']}
            title = check_result.get('title', 'Unknown')
            ext = check_result.get('ext', 'mp4')
            filesize = check_result.get('filesize') or 0

        # Generate UUID for this download
        message_id = generate_uuid()
        domain = self.get_domain(url)

        # Create initial filename from title, append resolution if provided
        if resolution and resolution != 'best':
            filename = f"{title}-{resolution}.{ext or 'mp4'}"
        else:
            filename = f"{title}.{ext or 'mp4'}"

        # Add to database
        new_download = db.add_download(
            file=filename,
            status='downloading',
            progress=0,
            speed=0,
            error=None,
            downloaded_bytes=0,
            total_bytes=filesize or 0,
            pending_time=None,
            message_id=message_id,
            downloaded_from=domain,
            url=url
        )

        # Emit new download event
        self.emit_new_download(new_download)

        # Start download task
        import sys
        print(f"[yt-dlp] Scheduling download task for {message_id} (format: {format_id})", flush=True)
        sys.stdout.flush()
        future = asyncio.run_coroutine_threadsafe(
            self.download(url, message_id, format_id),
            loop
        )

        # Add callback to catch any errors
        def on_done(fut):
            try:
                fut.result()
            except Exception as e:
                print(f"[yt-dlp] Task error: {e}")
                import traceback
                traceback.print_exc()

        future.add_done_callback(on_done)
        self.download_tasks[message_id] = future

        return new_download

    def stop_download(self, message_id: str):
        """Stop a running download"""
        if message_id in self.processes:
            self.processes[message_id].terminate()

        if message_id in self.download_tasks:
            task = self.download_tasks[message_id]
            if hasattr(task, 'cancel'):
                task.cancel()

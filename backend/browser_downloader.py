"""
Browser-based downloader using Playwright for Cloudflare-protected sites.
This is a fallback mechanism when yt-dlp fails with 403 errors.
"""
import asyncio
import os
import re
import logging
from pathlib import Path
from urllib.parse import urlparse, unquote

logger = logging.getLogger(__name__)


class BrowserDownloader:
    """Downloads videos using a real browser to bypass Cloudflare protection."""

    def __init__(self, download_dir: Path, progress_callback=None):
        self.download_dir = download_dir
        self.progress_callback = progress_callback
        self._browser = None
        self._context = None
        self._page = None

    async def _ensure_browser(self):
        """Lazily initialize the browser."""
        if self._browser is None:
            from playwright.async_api import async_playwright
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                headless=True,
                args=[
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                ]
            )
            self._context = await self._browser.new_context(
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
                viewport={'width': 1920, 'height': 1080},
            )
            self._page = await self._context.new_page()
        return self._page

    async def close(self):
        """Close the browser."""
        if self._browser:
            await self._browser.close()
            await self._playwright.stop()
            self._browser = None
            self._context = None
            self._page = None

    async def get_video_info(self, url: str) -> dict:
        """
        Get video information by visiting the page with a real browser.
        Returns dict with title, video_urls, etc.
        """
        try:
            page = await self._ensure_browser()

            logger.info(f"[Browser] Navigating to {url}")
            await page.goto(url, wait_until='networkidle', timeout=60000)

            # Wait a bit for any Cloudflare challenge to complete
            await asyncio.sleep(2)

            # Extract video sources from the page
            video_sources = await page.evaluate('''() => {
                const sources = [];

                // Check <source> tags
                document.querySelectorAll('source[src*=".mp4"]').forEach(el => {
                    sources.push({
                        url: el.src,
                        quality: el.getAttribute('quality') || 'unknown',
                        type: el.type || 'video/mp4'
                    });
                });

                // Check <video> tags
                document.querySelectorAll('video[src*=".mp4"]').forEach(el => {
                    sources.push({
                        url: el.src,
                        quality: 'default',
                        type: 'video/mp4'
                    });
                });

                return sources;
            }''')

            # Get page title
            title = await page.title()
            title = re.sub(r'[<>:"/\\|?*]', '', title)  # Remove invalid filename chars
            title = title.strip()[:100]  # Limit length

            if not video_sources:
                return {'error': 'No video sources found on page'}

            return {
                'title': title,
                'sources': video_sources,
                'page_url': url
            }

        except Exception as e:
            logger.error(f"[Browser] Error getting video info: {e}")
            return {'error': str(e)}

    async def download(self, url: str, output_path: str = None, quality: str = None) -> dict:
        """
        Download a video using the browser to bypass Cloudflare.

        Args:
            url: The page URL containing the video
            output_path: Optional output file path
            quality: Preferred quality (e.g., '720P', '1080P', '4K')

        Returns:
            dict with 'success', 'file_path', or 'error'
        """
        try:
            page = await self._ensure_browser()

            logger.info(f"[Browser] Starting download from {url}")

            # Navigate to the page
            await page.goto(url, wait_until='networkidle', timeout=60000)
            await asyncio.sleep(2)  # Wait for Cloudflare

            # Get video sources
            video_sources = await page.evaluate('''() => {
                const sources = [];
                document.querySelectorAll('source[src*=".mp4"]').forEach(el => {
                    sources.push({
                        url: el.src,
                        quality: el.getAttribute('quality') || 'unknown'
                    });
                });
                return sources;
            }''')

            if not video_sources:
                return {'error': 'No video sources found'}

            # Select the best quality or requested quality
            video_url = None
            if quality:
                for src in video_sources:
                    if quality.lower() in src['quality'].lower():
                        video_url = src['url']
                        break

            if not video_url:
                # Default to highest quality (last in list usually) or first
                video_url = video_sources[-1]['url'] if video_sources else None

            if not video_url:
                return {'error': 'Could not determine video URL'}

            logger.info(f"[Browser] Downloading video from CDN: {video_url[:80]}...")

            # Get page title for filename
            title = await page.title()
            title = re.sub(r'[<>:"/\\|?*]', '', title).strip()[:80]

            if not output_path:
                output_path = str(self.download_dir / f"{title}.mp4")

            # Try Method 1: Navigate browser to CDN URL to solve its Cloudflare challenge
            download_result = await self._download_via_navigation(video_url, output_path)
            if download_result.get('success'):
                return download_result

            # Method 2: Try using CDP to download with all cookies
            logger.info("[Browser] Navigation method failed, trying CDP...")
            return await self._download_with_cdp(page, video_url, output_path)

        except Exception as e:
            logger.error(f"[Browser] Download error: {e}")
            import traceback
            traceback.print_exc()
            return {'error': str(e)}

    async def _download_via_navigation(self, video_url: str, output_path: str) -> dict:
        """Download by navigating browser directly to video URL to handle CDN's Cloudflare."""
        try:
            # Create a new page for downloading to not disrupt the main page
            download_page = await self._context.new_page()

            # Set up download behavior
            download_started = asyncio.Event()
            download_path = None

            async def handle_download(download):
                nonlocal download_path
                download_started.set()
                logger.info(f"[Browser] Download started: {download.suggested_filename}")
                await download.save_as(output_path)
                download_path = output_path

            download_page.on("download", handle_download)

            # Try to trigger download by navigating to the video URL
            # For video files, this should trigger a download
            logger.info(f"[Browser] Navigating to video URL to trigger download...")

            try:
                # Navigate with a longer timeout - videos take time
                response = await download_page.goto(video_url, timeout=120000, wait_until='commit')

                if response:
                    status = response.status
                    content_type = response.headers.get('content-type', '')
                    logger.info(f"[Browser] Response: {status}, Content-Type: {content_type}")

                    if status == 403:
                        # Cloudflare challenge on CDN - wait and retry
                        logger.info("[Browser] CDN returned 403, waiting for Cloudflare challenge...")
                        await asyncio.sleep(5)

                        # Check if Cloudflare challenge page
                        page_content = await download_page.content()
                        if 'challenge' in page_content.lower() or 'cloudflare' in page_content.lower():
                            logger.info("[Browser] Detected Cloudflare challenge, waiting for it to complete...")
                            await asyncio.sleep(10)
                            # Retry navigation after challenge
                            response = await download_page.goto(video_url, timeout=120000, wait_until='commit')
                            if response:
                                status = response.status

                    if status == 200 and 'video' in content_type:
                        # Stream the response body to file
                        logger.info("[Browser] Streaming video response to file...")
                        body = await response.body()
                        with open(output_path, 'wb') as f:
                            f.write(body)
                        await download_page.close()
                        return {
                            'success': True,
                            'file_path': output_path,
                            'size': len(body)
                        }

            except Exception as nav_error:
                logger.warning(f"[Browser] Navigation error: {nav_error}")

            # Wait a bit to see if download was triggered
            try:
                await asyncio.wait_for(download_started.wait(), timeout=5)
                if download_path and os.path.exists(download_path):
                    await download_page.close()
                    return {
                        'success': True,
                        'file_path': download_path,
                        'size': os.path.getsize(download_path)
                    }
            except asyncio.TimeoutError:
                pass

            await download_page.close()
            return {'error': 'Navigation download method failed'}

        except Exception as e:
            logger.warning(f"[Browser] Navigation download failed: {e}")
            return {'error': str(e)}

    async def _download_with_cdp(self, page, video_url: str, output_path: str) -> dict:
        """Download using Chrome DevTools Protocol for streaming download."""
        try:
            # Get cookies from the browser context
            cookies = await self._context.cookies()
            cookie_header = '; '.join([f"{c['name']}={c['value']}" for c in cookies])

            # Use aiohttp or httpx with the browser's cookies
            import aiohttp

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
                'Referer': page.url,
                'Cookie': cookie_header,
                'Accept': '*/*',
            }

            async with aiohttp.ClientSession() as session:
                async with session.get(video_url, headers=headers) as response:
                    if response.status != 200:
                        return {'error': f'HTTP {response.status}'}

                    total_size = int(response.headers.get('content-length', 0))
                    downloaded = 0

                    with open(output_path, 'wb') as f:
                        async for chunk in response.content.iter_chunked(8192):
                            f.write(chunk)
                            downloaded += len(chunk)

                            if self.progress_callback and total_size:
                                progress = (downloaded / total_size) * 100
                                self.progress_callback(progress, downloaded, total_size)

                    return {
                        'success': True,
                        'file_path': output_path,
                        'size': downloaded
                    }

        except Exception as e:
            logger.warning(f"[Browser] CDP download failed: {e}")
            return {'error': str(e)}


async def download_with_browser(url: str, output_dir: Path, quality: str = None, progress_callback=None) -> dict:
    """
    Convenience function to download a video using browser automation.

    Args:
        url: The page URL
        output_dir: Directory to save the video
        quality: Preferred quality
        progress_callback: Optional callback(progress, downloaded, total)

    Returns:
        dict with 'success' and 'file_path' or 'error'
    """
    downloader = BrowserDownloader(output_dir, progress_callback)
    try:
        result = await downloader.download(url, quality=quality)
        return result
    finally:
        await downloader.close()


# Test function
async def test_download():
    """Test the browser downloader."""
    from backend.config import DOWNLOAD_DIR

    test_url = "https://astalavr.com/videos/7QP36/at-king-s-service"
    output_dir = DOWNLOAD_DIR / "Videos"
    output_dir.mkdir(exist_ok=True)

    def progress(pct, downloaded, total):
        print(f"Progress: {pct:.1f}% ({downloaded}/{total})")

    result = await download_with_browser(test_url, output_dir, progress_callback=progress)
    print(f"Result: {result}")
    return result


if __name__ == "__main__":
    asyncio.run(test_download())

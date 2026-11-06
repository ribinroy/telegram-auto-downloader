"""The Playwright fallback, driven by a fake browser.

`playwright.async_api` and `aiohttp` are both replaced in sys.modules before
the module's lazy imports run, so no browser is launched and nothing is
fetched. The sleeps the module uses to wait out Cloudflare are recorded, not
slept.
"""
import asyncio
import sys
import types

import pytest

from backend import browser_downloader as bd


# --- fake Playwright ---------------------------------------------------------

class FakeResponse:
    def __init__(self, status=200, content_type='video/mp4', body=b'video-bytes'):
        self.status = status
        self.headers = {'content-type': content_type}
        self._body = body

    async def body(self):
        return self._body


class FakeDownload:
    suggested_filename = 'clip.mp4'

    def __init__(self, payload=b'saved-by-download-event'):
        self.payload = payload

    async def save_as(self, path):
        with open(path, 'wb') as f:
            f.write(self.payload)


class FakePage:
    """`responses` is what successive goto() calls answer with (a value, or an
    exception to raise); `sources` is what the evaluate() script finds."""

    def __init__(self, context, responses=(), sources=(), title='A Page', content='',
                 downloads=()):
        self.context = context
        self.responses = list(responses)
        self.sources = list(sources)
        self._title = title
        self._content = content
        self.downloads = list(downloads)
        self.handlers = {}
        self.visited = []
        self.closed = False
        self.url = 'about:blank'

    async def goto(self, url, **kwargs):
        self.visited.append((url, kwargs))
        self.url = url
        if self.downloads and 'download' in self.handlers:
            await self.handlers['download'](self.downloads.pop(0))
        if not self.responses:
            return None
        res = self.responses.pop(0)
        if isinstance(res, Exception):
            raise res
        return res

    async def evaluate(self, script):
        return self.sources

    async def title(self):
        return self._title

    async def content(self):
        return self._content

    def on(self, event, handler):
        self.handlers[event] = handler

    async def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, page_factory):
        self.page_factory = page_factory
        self.pages = []
        self.cookie_jar = [{'name': 'cf_clearance', 'value': 'abc'}, {'name': 'sid', 'value': '1'}]

    async def new_page(self):
        page = self.page_factory(self)
        if isinstance(page, Exception):
            raise page
        self.pages.append(page)
        return page

    async def cookies(self):
        return self.cookie_jar


class FakeBrowser:
    def __init__(self, context):
        self.context = context
        self.context_kwargs = None
        self.closed = False

    async def new_context(self, **kwargs):
        self.context_kwargs = kwargs
        return self.context

    async def close(self):
        self.closed = True


class FakePlaywright:
    def __init__(self, browser):
        self.browser = browser
        self.launch_kwargs = None
        self.stopped = False
        self.chromium = self

    async def launch(self, **kwargs):
        self.launch_kwargs = kwargs
        return self.browser

    async def stop(self):
        self.stopped = True


class FakeAsyncPlaywright:
    def __init__(self, pw):
        self.pw = pw

    async def start(self):
        return self.pw


@pytest.fixture
def browser(monkeypatch):
    """Install a fake Playwright. Returns a holder: set `holder.pages` to a
    list of FakePage factories (lambda ctx: FakePage(ctx, ...)) in the order
    new_page() will be called - the main page first, then a download page."""
    holder = types.SimpleNamespace(pages=[], pw=None, browser=None, context=None)

    def factory(ctx):
        if holder.pages:
            return holder.pages.pop(0)(ctx)
        return FakePage(ctx)
    holder.context = FakeContext(factory)
    holder.browser = FakeBrowser(holder.context)
    holder.pw = FakePlaywright(holder.browser)

    api = types.ModuleType('playwright.async_api')
    api.async_playwright = lambda: FakeAsyncPlaywright(holder.pw)
    pkg = types.ModuleType('playwright')
    pkg.async_api = api
    monkeypatch.setitem(sys.modules, 'playwright', pkg)
    monkeypatch.setitem(sys.modules, 'playwright.async_api', api)
    return holder


@pytest.fixture
def sleeps(monkeypatch):
    """The module waits out Cloudflare with real sleeps; record them instead."""
    recorded = []

    async def fake_sleep(seconds):
        recorded.append(seconds)
    monkeypatch.setattr(bd.asyncio, 'sleep', fake_sleep)
    return recorded


@pytest.fixture
def quick_wait(monkeypatch):
    """The 5s wait for a download event, shortened."""
    real = asyncio.wait_for
    monkeypatch.setattr(bd.asyncio, 'wait_for', lambda aw, timeout: real(aw, timeout=0.02))


def run(coro):
    return asyncio.run(coro)


SOURCES = [{'url': 'https://cdn/x_480.mp4', 'quality': '480P', 'type': 'video/mp4'},
           {'url': 'https://cdn/x_1080.mp4', 'quality': '1080P', 'type': 'video/mp4'}]


# --- lifecycle ----------------------------------------------------------------

def test_browser_is_launched_lazily_once_and_closed(browser, tmp_path):
    d = bd.BrowserDownloader(tmp_path)
    assert d._browser is None

    async def scenario():
        p1 = await d._ensure_browser()
        p2 = await d._ensure_browser()
        return p1, p2
    p1, p2 = run(scenario())
    assert p1 is p2 and len(browser.context.pages) == 1
    assert browser.pw.launch_kwargs['headless'] is True
    assert '--no-sandbox' in browser.pw.launch_kwargs['args']
    assert browser.browser.context_kwargs['viewport'] == {'width': 1920, 'height': 1080}
    assert 'Chrome/' in browser.browser.context_kwargs['user_agent']

    run(d.close())
    assert browser.browser.closed and browser.pw.stopped
    assert d._browser is None and d._context is None and d._page is None


def test_close_without_a_browser_is_a_no_op(tmp_path):
    d = bd.BrowserDownloader(tmp_path)
    run(d.close())  # nothing launched, nothing to close, nothing raised


def test_missing_playwright_surfaces_as_an_error(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, 'playwright', None)
    monkeypatch.setitem(sys.modules, 'playwright.async_api', None)
    d = bd.BrowserDownloader(tmp_path)
    with pytest.raises(ImportError):
        run(d._ensure_browser())
    # The public entry points swallow it into their error dict
    assert 'error' in run(d.get_video_info('https://site/v'))
    assert 'error' in run(d.download('https://site/v'))


# --- get_video_info -----------------------------------------------------------

def test_get_video_info_lists_sources_and_cleans_the_title(browser, sleeps, tmp_path):
    browser.pages = [lambda ctx: FakePage(ctx, sources=SOURCES, title='  Ep: 1 / "Pilot"? ' + 'x' * 200)]
    d = bd.BrowserDownloader(tmp_path)
    info = run(d.get_video_info('https://site/v'))
    assert info['sources'] == SOURCES and info['page_url'] == 'https://site/v'
    for bad in '<>:"/\\|?*':
        assert bad not in info['title']
    assert info['title'].startswith('Ep 1  Pilot') and len(info['title']) <= 100
    page = browser.context.pages[0]
    assert page.visited[0] == ('https://site/v', {'wait_until': 'networkidle', 'timeout': 60000})
    assert sleeps == [2]


def test_get_video_info_without_sources(browser, sleeps, tmp_path):
    browser.pages = [lambda ctx: FakePage(ctx, sources=[])]
    info = run(bd.BrowserDownloader(tmp_path).get_video_info('https://site/v'))
    assert info == {'error': 'No video sources found on page'}


def test_get_video_info_reports_a_navigation_failure(browser, sleeps, tmp_path):
    browser.pages = [lambda ctx: FakePage(ctx, responses=[TimeoutError('Timeout 60000ms exceeded')])]
    info = run(bd.BrowserDownloader(tmp_path).get_video_info('https://site/v'))
    assert info == {'error': 'Timeout 60000ms exceeded'}


# --- download(): choosing the source ------------------------------------------

def test_download_streams_the_video_response_to_the_title(browser, sleeps, tmp_path):
    browser.pages = [
        lambda ctx: FakePage(ctx, sources=SOURCES, title='My: Clip'),
        lambda ctx: FakePage(ctx, responses=[FakeResponse(body=b'1080-bytes')]),
    ]
    res = run(bd.BrowserDownloader(tmp_path).download('https://site/v'))
    expected = tmp_path / 'My Clip.mp4'
    assert res == {'success': True, 'file_path': str(expected), 'size': 10}
    assert expected.read_bytes() == b'1080-bytes'
    main, dl_page = browser.context.pages
    # No quality asked for: the last (highest) source is taken
    assert dl_page.visited[0][0] == 'https://cdn/x_1080.mp4'
    assert dl_page.visited[0][1] == {'timeout': 120000, 'wait_until': 'commit'}
    assert dl_page.closed and not main.closed


def test_download_honours_the_requested_quality_and_output_path(browser, sleeps, tmp_path):
    browser.pages = [
        lambda ctx: FakePage(ctx, sources=SOURCES),
        lambda ctx: FakePage(ctx, responses=[FakeResponse()]),
    ]
    out = tmp_path / 'chosen.mp4'
    res = run(bd.BrowserDownloader(tmp_path).download('https://site/v', output_path=str(out), quality='480p'))
    assert res['file_path'] == str(out) and out.exists()
    assert browser.context.pages[1].visited[0][0] == 'https://cdn/x_480.mp4'


def test_download_falls_back_to_the_best_source_for_an_unknown_quality(browser, sleeps, tmp_path):
    browser.pages = [
        lambda ctx: FakePage(ctx, sources=SOURCES),
        lambda ctx: FakePage(ctx, responses=[FakeResponse()]),
    ]
    run(bd.BrowserDownloader(tmp_path).download('https://site/v', quality='4K'))
    assert browser.context.pages[1].visited[0][0] == 'https://cdn/x_1080.mp4'


def test_download_without_sources(browser, sleeps, tmp_path):
    browser.pages = [lambda ctx: FakePage(ctx, sources=[])]
    assert run(bd.BrowserDownloader(tmp_path).download('https://site/v')) == {'error': 'No video sources found'}


def test_download_with_an_empty_source_url(browser, sleeps, tmp_path):
    browser.pages = [lambda ctx: FakePage(ctx, sources=[{'url': '', 'quality': '720P'}])]
    assert run(bd.BrowserDownloader(tmp_path).download('https://site/v')) == \
        {'error': 'Could not determine video URL'}


def test_download_reports_a_page_error(browser, sleeps, tmp_path):
    browser.pages = [lambda ctx: FakePage(ctx, responses=[RuntimeError('net::ERR_CONNECTION_RESET')])]
    assert run(bd.BrowserDownloader(tmp_path).download('https://site/v')) == \
        {'error': 'net::ERR_CONNECTION_RESET'}


# --- _download_via_navigation ---------------------------------------------------

def nav(browser, tmp_path, page_factory):
    """Run the navigation method alone on an initialised downloader."""
    d = bd.BrowserDownloader(tmp_path)
    browser.pages = [lambda ctx: FakePage(ctx), page_factory]

    async def scenario():
        await d._ensure_browser()
        return await d._download_via_navigation('https://cdn/v.mp4', str(tmp_path / 'out.mp4'))
    return run(scenario())


def test_navigation_waits_out_a_cloudflare_challenge_then_retries(browser, sleeps, tmp_path):
    res = nav(browser, tmp_path, lambda ctx: FakePage(
        ctx, responses=[FakeResponse(status=403, content_type='text/html'), FakeResponse(body=b'ok')],
        content='<html>Checking your browser... Cloudflare</html>'))
    assert res['success'] is True and (tmp_path / 'out.mp4').read_bytes() == b'ok'
    assert sleeps == [5, 10]
    assert len(browser.context.pages[1].visited) == 2


def test_navigation_gives_up_on_a_plain_403(browser, sleeps, quick_wait, tmp_path):
    res = nav(browser, tmp_path, lambda ctx: FakePage(
        ctx, responses=[FakeResponse(status=403, content_type='text/html')], content='<html>Forbidden</html>'))
    assert res == {'error': 'Navigation download method failed'}
    assert sleeps == [5]
    assert browser.context.pages[1].closed
    assert not (tmp_path / 'out.mp4').exists()


def test_navigation_ignores_a_non_video_response(browser, sleeps, quick_wait, tmp_path):
    res = nav(browser, tmp_path, lambda ctx: FakePage(ctx, responses=[FakeResponse(content_type='text/html')]))
    assert res == {'error': 'Navigation download method failed'}


def test_navigation_picks_up_a_download_event(browser, sleeps, tmp_path):
    """A CDN that answers with Content-Disposition fires Playwright's download
    event instead of a body; the saved file counts."""
    res = nav(browser, tmp_path, lambda ctx: FakePage(
        ctx, responses=[FakeResponse(content_type='application/octet-stream')], downloads=[FakeDownload()]))
    out = tmp_path / 'out.mp4'
    assert res == {'success': True, 'file_path': str(out), 'size': len(b'saved-by-download-event')}


def test_navigation_survives_a_goto_error(browser, sleeps, quick_wait, tmp_path):
    res = nav(browser, tmp_path, lambda ctx: FakePage(ctx, responses=[RuntimeError('net::ERR_ABORTED')]))
    assert res == {'error': 'Navigation download method failed'}


def test_navigation_reports_a_page_that_cannot_open(browser, sleeps, tmp_path):
    res = nav(browser, tmp_path, lambda ctx: RuntimeError('Target closed'))
    assert res == {'error': 'Target closed'}


# --- _download_with_cdp (aiohttp with the browser's cookies) --------------------

class FakeAiohttp:
    """A stand-in `aiohttp` module: one scripted response per session.get()."""

    def __init__(self, status=200, chunks=(), content_length=None):
        self.status = status
        self.chunks = list(chunks)
        self.content_length = content_length
        self.requests = []
        self.module = types.ModuleType('aiohttp')
        self.module.ClientSession = self._session

    def _session(self):
        fake = self

        class Response:
            status = fake.status
            headers = {'content-length': str(fake.content_length)} if fake.content_length is not None else {}

            class content:
                @staticmethod
                async def iter_chunked(size):
                    for chunk in fake.chunks:
                        yield chunk

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            def get(self, url, headers=None):
                fake.requests.append((url, headers))
                return Response()
        return Session()


@pytest.fixture
def aiohttp_stub(monkeypatch):
    def install(**kw):
        stub = FakeAiohttp(**kw)
        monkeypatch.setitem(sys.modules, 'aiohttp', stub.module)
        return stub
    return install


def cdp(browser, tmp_path, progress=None):
    d = bd.BrowserDownloader(tmp_path, progress)

    async def scenario():
        page = await d._ensure_browser()
        page.url = 'https://site/v'
        return await d._download_with_cdp(page, 'https://cdn/v.mp4', str(tmp_path / 'out.mp4'))
    return run(scenario())


def test_cdp_download_sends_the_browser_cookies_and_reports_progress(browser, aiohttp_stub, tmp_path):
    stub = aiohttp_stub(chunks=[b'a' * 4, b'b' * 6], content_length=10)
    seen = []
    res = cdp(browser, tmp_path, lambda pct, done, total: seen.append((pct, done, total)))
    assert res == {'success': True, 'file_path': str(tmp_path / 'out.mp4'), 'size': 10}
    assert (tmp_path / 'out.mp4').read_bytes() == b'aaaabbbbbb'
    assert seen == [(40.0, 4, 10), (100.0, 10, 10)]
    url, headers = stub.requests[0]
    assert url == 'https://cdn/v.mp4'
    assert headers['Cookie'] == 'cf_clearance=abc; sid=1'
    assert headers['Referer'] == 'https://site/v'
    assert 'Chrome/' in headers['User-Agent']


def test_cdp_download_without_a_length_skips_progress(browser, aiohttp_stub, tmp_path):
    aiohttp_stub(chunks=[b'xyz'])
    seen = []
    res = cdp(browser, tmp_path, lambda *a: seen.append(a))
    assert res['size'] == 3 and seen == []


def test_cdp_download_reports_a_bad_status(browser, aiohttp_stub, tmp_path):
    aiohttp_stub(status=403)
    assert cdp(browser, tmp_path) == {'error': 'HTTP 403'}
    assert not (tmp_path / 'out.mp4').exists()


def test_cdp_download_reports_an_exception(browser, monkeypatch, tmp_path):
    broken = types.ModuleType('aiohttp')

    def explode():
        raise RuntimeError('no event loop')
    broken.ClientSession = explode
    monkeypatch.setitem(sys.modules, 'aiohttp', broken)
    assert cdp(browser, tmp_path) == {'error': 'no event loop'}


# --- the fallback decision inside download() -------------------------------------

def test_download_falls_back_to_cdp_when_navigation_fails(browser, sleeps, quick_wait, aiohttp_stub, tmp_path):
    aiohttp_stub(chunks=[b'cdp-bytes'], content_length=9)
    browser.pages = [
        lambda ctx: FakePage(ctx, sources=SOURCES, title='Clip'),
        lambda ctx: FakePage(ctx, responses=[FakeResponse(status=403, content_type='text/html')], content='nope'),
    ]
    res = run(bd.BrowserDownloader(tmp_path).download('https://site/v'))
    assert res == {'success': True, 'file_path': str(tmp_path / 'Clip.mp4'), 'size': 9}
    assert (tmp_path / 'Clip.mp4').read_bytes() == b'cdp-bytes'


def test_download_returns_the_cdp_error_when_everything_fails(browser, sleeps, quick_wait, aiohttp_stub, tmp_path):
    aiohttp_stub(status=503)
    browser.pages = [
        lambda ctx: FakePage(ctx, sources=SOURCES),
        lambda ctx: FakePage(ctx, responses=[RuntimeError('net::ERR_FAILED')]),
    ]
    assert run(bd.BrowserDownloader(tmp_path).download('https://site/v')) == {'error': 'HTTP 503'}


# --- convenience wrapper -----------------------------------------------------------

def test_download_with_browser_always_closes(browser, sleeps, tmp_path):
    browser.pages = [
        lambda ctx: FakePage(ctx, sources=SOURCES, title='Wrapped'),
        lambda ctx: FakePage(ctx, responses=[FakeResponse()]),
    ]
    calls = []
    res = run(bd.download_with_browser('https://site/v', tmp_path, quality='1080p',
                                       progress_callback=lambda *a: calls.append(a)))
    assert res['success'] and res['file_path'] == str(tmp_path / 'Wrapped.mp4')
    assert browser.browser.closed and browser.pw.stopped


def test_download_with_browser_closes_after_a_failure(browser, sleeps, tmp_path):
    browser.pages = [lambda ctx: FakePage(ctx, responses=[RuntimeError('crash')])]
    assert run(bd.download_with_browser('https://site/v', tmp_path)) == {'error': 'crash'}
    assert browser.browser.closed


def test_the_modules_own_smoke_test_uses_the_videos_folder(browser, sleeps, capsys):
    """`test_download()` is a manual smoke test; with the fake browser it just
    reports what the page offered."""
    from backend.config import DOWNLOAD_DIR
    browser.pages = [lambda ctx: FakePage(ctx, sources=[])]
    res = run(bd.test_download())
    assert res == {'error': 'No video sources found'}
    assert (DOWNLOAD_DIR / 'Videos').is_dir()
    assert 'Result:' in capsys.readouterr().out

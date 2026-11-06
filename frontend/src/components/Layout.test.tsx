import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api';
import * as socket from '../api/socket';
import { applyUpdate } from '../lib/pwa';
import { makeQueryClient } from '../test/queryWrapper';
import { makeDownload, makeStats } from '../test/fixtures';
import { captureToasts } from '../test/toasts';
import { Layout, useLayoutContext } from './Layout';
import type { DownloadsResponse } from '../types';

vi.mock('../api', () => ({
  fetchDownloads: vi.fn(), fetchStats: vi.fn(), fetchAuthors: vi.fn(),
  fetchVpsConfig: vi.fn(), fetchVpsFolders: vi.fn(),
  retryDownload: vi.fn(), stopDownload: vi.fn(), pauseDownload: vi.fn(), resumeDownload: vi.fn(), deleteDownload: vi.fn(),
}));
vi.mock('../api/socket', () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn() }));
vi.mock('../lib/pwa', () => ({ applyUpdate: vi.fn() }));

type Handlers = Parameters<typeof socket.connectSocket>[0];
const handlers = () => vi.mocked(socket.connectSocket).mock.calls.at(-1)![0] as Handlers;

const page = (downloads = [makeDownload()], has_more = false): DownloadsResponse => ({ downloads, has_more, total: downloads.length });

/** A page that exposes the outlet context as text and buttons, so the test
 *  can drive the context's functions the way DownloadsPage would. */
function Probe() {
  const ctx = useLayoutContext();
  const loc = useLocation();
  return (
    <div>
      <output data-testid="location">{loc.pathname}</output>
      <output data-testid="files">{ctx.downloads.map(d => d.file).join(',')}</output>
      <output data-testid="state">{[
        ctx.loading ? 'loading' : 'ready', ctx.loadingMore ? 'more' : '', ctx.hasMore ? 'hasMore' : '',
        ctx.error ?? '', `total=${ctx.totalResults}`, `search=${ctx.debouncedSearch}`, `secured=${ctx.showSecured}`,
        `vps=${ctx.vpsReady}`, `authors=${ctx.authors.join('|')}`, `sort=${ctx.sortBy}:${ctx.sortOrder}`,
        `filter=${ctx.filter}`, `author=${ctx.selectedAuthor}`, `add=${ctx.addUrlOpen}:${ctx.pastedUrl ?? ''}`,
      ].join(' ')}</output>
      <input aria-label="search" value={ctx.search} onChange={e => ctx.setSearch(e.target.value)} />
      <button onClick={ctx.loadMore}>loadMore</button>
      <button onClick={() => ctx.onRetry(1)}>retry</button>
      <button onClick={() => ctx.onStop('m1')}>stop</button>
      <button onClick={() => ctx.onPause('m1')}>pause</button>
      <button onClick={() => ctx.onResume('m1')}>resume</button>
      <button onClick={() => ctx.onDelete('m1', true)}>delete</button>
      <button onClick={() => { ctx.setSortBy('file'); ctx.setSortOrder('asc'); ctx.setFilter('on_disk'); ctx.setSelectedAuthor('bob'); }}>sort</button>
      <button onClick={() => { ctx.setAddUrlOpen(true); ctx.setPastedUrl('https://x'); }}>open</button>
      <button onClick={ctx.refreshDownloads}>refresh</button>
    </div>
  );
}

const renderLayout = (path = '/', onLogout = vi.fn()) => {
  const client = makeQueryClient();
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout onLogout={onLogout} />}>
            <Route path="*" element={<Probe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, client, onLogout };
};

const pill = () => screen.getByText(/^(Live|Offline)$/).parentElement!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchDownloads).mockResolvedValue(page());
  vi.mocked(api.fetchStats).mockResolvedValue(makeStats());
  vi.mocked(api.fetchAuthors).mockResolvedValue([]);
  vi.mocked(api.fetchVpsConfig).mockResolvedValue({ configured: false, host: '', port: 22, username: '', remote_path: '', has_password: false });
  vi.mocked(api.fetchVpsFolders).mockResolvedValue([]);
});

describe('Layout - header', () => {
  it('shows the queue figures from the stats and starts offline', async () => {
    vi.mocked(api.fetchStats).mockResolvedValue(makeStats({
      eta_seconds: 3725, remaining_bytes: 3 * 1024 ** 3, running_bytes: 1024 ** 3, waiting_bytes: 2 * 1024 ** 3,
      running_count: 1, waiting_count: 2, unsized_count: 1, total_speed: 5120,
    }));
    renderLayout();
    expect(screen.getByAltText('DownLee logo')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(await screen.findByText('1h 2m 5s')).toBeInTheDocument();
    expect(screen.getByText('3.00 GB+')).toBeInTheDocument();
    expect(screen.getByText('5.0 MB/s')).toBeInTheDocument();
    expect(screen.getByText('1 running: 1.00 GB left')).toBeInTheDocument();
    expect(screen.getByText('2 waiting: 2.00 GB')).toBeInTheDocument();
    expect(screen.getByText('1 download of unknown size not counted')).toBeInTheDocument();
    expect(screen.getByText('3.00 GB to go, waiting downloads included')).toBeInTheDocument();
  });

  it('with nothing queued the pills read dashes and zero', async () => {
    renderLayout();
    await screen.findByText('0 B');
    expect(screen.getAllByText('-')).toHaveLength(2);   // ETA and speed
    expect(screen.getByText('Time left for the whole queue')).toBeInTheDocument();
  });

  it('navigates with the header buttons and signs out', async () => {
    const { onLogout } = renderLayout();
    fireEvent.click(screen.getByText('Files').previousElementSibling!);
    expect(screen.getByTestId('location')).toHaveTextContent('/files');
    fireEvent.click(screen.getByText('Settings').previousElementSibling!);
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');
    fireEvent.click(screen.getByAltText('DownLee logo').parentElement!);
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    expect(screen.queryByText('VPS files')).toBeNull();
    expect(screen.queryByText('Analytics')).toBeNull();
    fireEvent.click(screen.getByText('Sign out').previousElementSibling!);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('offers the VPS page only once the VPS is configured with an active folder', async () => {
    vi.mocked(api.fetchVpsConfig).mockResolvedValue({ configured: true, host: 'h', port: 22, username: 'u', remote_path: '/', has_password: true });
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([{ id: 1, path: '/w', host: 'h', port: 22, username: 'u', auto_sync: false, folder: null, is_secured: false, active: true, created_at: null }]);
    renderLayout();
    const label = await screen.findByText('VPS files');
    expect(screen.getByTestId('state')).toHaveTextContent('vps=true');
    fireEvent.click(label.previousElementSibling!);
    expect(screen.getByTestId('location')).toHaveTextContent('/vps/files');
  });

  it('the phone overflow menu opens, navigates, and closes on Escape or a tap outside', async () => {
    const { onLogout } = renderLayout();
    const more = screen.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    fireEvent.pointerDown(more);          // inside the menu - stays open
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(document.body); // outside
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: /Files/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/files');
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(onLogout).toHaveBeenCalled();
  });
});

describe('Layout - secured toggle', () => {
  it('three quick clicks on the connection pill reveal the secured items and Analytics', async () => {
    renderLayout();
    await screen.findByText('0 B');
    expect(screen.getByTestId('state')).toHaveTextContent('secured=false');
    fireEvent.click(pill());
    fireEvent.click(pill());
    expect(screen.queryByText('Analytics')).toBeNull();
    fireEvent.click(pill());
    expect(screen.getByTestId('state')).toHaveTextContent('secured=true');
    fireEvent.click(screen.getByText('Analytics').previousElementSibling!);
    expect(screen.getByTestId('location')).toHaveTextContent('/analytics');
    await waitFor(() => expect(api.fetchDownloads).toHaveBeenLastCalledWith(expect.objectContaining({ includeHidden: true })));
    // The phone menu lists it too
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('button', { name: /Analytics/ })).toBeInTheDocument();
  });

  it('slow clicks do not count; Ctrl+X toggles directly', async () => {
    vi.useFakeTimers();
    try {
      renderLayout();
      fireEvent.click(pill());
      fireEvent.click(pill());
      act(() => { vi.advanceTimersByTime(1001); });
      fireEvent.click(pill());
      expect(screen.getByTestId('state')).toHaveTextContent('secured=false');
      fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
      expect(screen.getByTestId('state')).toHaveTextContent('secured=true');
      fireEvent.keyDown(window, { key: 'x' });   // without ctrl: nothing
      expect(screen.getByTestId('state')).toHaveTextContent('secured=true');
      fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
      expect(screen.getByTestId('state')).toHaveTextContent('secured=false');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Layout - update pill and toasts', () => {
  it('shows the new-version pill on the service worker\'s event; Reload applies, Later hides', async () => {
    renderLayout();
    expect(screen.queryByText(/new version of DownLee/)).toBeNull();
    act(() => { window.dispatchEvent(new Event('downlee:update-ready')); });
    expect(screen.getByText('A new version of DownLee is ready.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText(/new version of DownLee/)).toBeNull();
  });

  it('renders the toast container, so a notification raised anywhere shows up', async () => {
    const captured = captureToasts();
    try {
      renderLayout();
      const { notify } = await import('../lib/notify');
      act(() => { notify({ type: 'info', title: 'Hello there', message: 'from a test' }); });
      expect(await screen.findByText('Hello there')).toBeInTheDocument();
      expect(screen.getByText('from a test')).toBeInTheDocument();
    } finally { captured.stop(); }
  });
});

describe('Layout - realtime', () => {
  afterEach(() => { vi.mocked(socket.disconnectSocket).mockClear(); });

  it('connects the socket once, flips the pill on connect/disconnect, and disconnects on unmount', async () => {
    const { unmount } = renderLayout();
    await screen.findByText('0 B');
    expect(socket.connectSocket).toHaveBeenCalledTimes(1);
    act(() => { handlers().onConnect?.(); });
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(pill()).toHaveClass('bg-green-500/20');
    act(() => { handlers().onDisconnect?.(); });
    expect(screen.getByText('Offline')).toBeInTheDocument();
    unmount();
    expect(socket.disconnectSocket).toHaveBeenCalled();
  });

  it('toasts a new download, a completion and a failure (for downloads it knows)', async () => {
    const captured = captureToasts();
    try {
      renderLayout();
      await waitFor(() => expect(screen.getByTestId('files')).toHaveTextContent('clip.mkv'));
      act(() => { handlers().onNew(makeDownload({ id: 2, message_id: 'm2', file: 'new.mkv' })); });
      expect(await screen.findByText('Download Started')).toBeInTheDocument();
      expect(screen.getByText('new.mkv')).toBeInTheDocument();
      expect(screen.getByTestId('files')).toHaveTextContent('new.mkv,clip.mkv');
      act(() => { handlers().onStatus({ message_id: 'm1', status: 'done' }); });
      expect(await screen.findByText('Download Complete')).toBeInTheDocument();
      act(() => { handlers().onStatus({ message_id: 'm2', status: 'failed', error: 'x' }); });
      expect(await screen.findByText('Download Failed')).toBeInTheDocument();
      // A status for a download not in the list, or a neutral status, is silent
      act(() => { handlers().onStatus({ message_id: 'nope', status: 'done' }); });
      act(() => { handlers().onStatus({ message_id: 'm1', status: 'stopped' }); });
      expect(captured.titles()).toEqual(['Download Started', 'Download Complete', 'Download Failed']);
    } finally { captured.stop(); }
  });
});

describe('Layout - the outlet context', () => {
  it('exposes the list, loading state, totals and authors', async () => {
    vi.mocked(api.fetchDownloads).mockResolvedValue(page([makeDownload({ file: 'a.mkv' }), makeDownload({ id: 2, message_id: 'm2', file: 'b.mkv' })], true));
    vi.mocked(api.fetchAuthors).mockResolvedValue(['alice:1', 'bob']);
    renderLayout();
    expect(screen.getByTestId('state')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('files')).toHaveTextContent('a.mkv,b.mkv'));
    const state = screen.getByTestId('state');
    expect(state).toHaveTextContent('ready');
    expect(state).toHaveTextContent('hasMore');
    expect(state).toHaveTextContent('total=2');
    await waitFor(() => expect(state).toHaveTextContent('authors=alice:1|bob'));
    expect(state).toHaveTextContent('sort=created_at:desc filter=all author=');
    expect(api.fetchDownloads).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 30, filter: 'all', sortBy: 'created_at', sortOrder: 'desc', includeHidden: false }));
  });

  it('reports a failed list load as an error string', async () => {
    vi.mocked(api.fetchDownloads).mockRejectedValue(new Error('500'));
    renderLayout();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('Failed to fetch downloads'));
  });

  it('debounces the search and refetches with it; sort/filter/author pass through', async () => {
    vi.useFakeTimers();
    try {
      renderLayout();
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      fireEvent.change(screen.getByLabelText('search'), { target: { value: 'fil' } });
      fireEvent.change(screen.getByLabelText('search'), { target: { value: 'film' } });
      act(() => { vi.advanceTimersByTime(299); });
      expect(screen.getByTestId('state')).toHaveTextContent('search= ');
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(screen.getByTestId('state')).toHaveTextContent('search=film');
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      expect(api.fetchDownloads).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'film' }));
      fireEvent.click(screen.getByText('sort'));
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      expect(screen.getByTestId('state')).toHaveTextContent('sort=file:asc filter=on_disk author=bob');
      expect(api.fetchDownloads).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'file', sortOrder: 'asc', filter: 'on_disk', author: 'bob' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('loadMore fetches the next page only while there is one', async () => {
    vi.mocked(api.fetchDownloads)
      .mockResolvedValueOnce(page([makeDownload({ file: 'a.mkv' })], true))
      .mockResolvedValueOnce(page([makeDownload({ id: 2, message_id: 'm2', file: 'b.mkv' })], false));
    renderLayout();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('hasMore'));
    fireEvent.click(screen.getByText('loadMore'));
    await waitFor(() => expect(screen.getByTestId('files')).toHaveTextContent('a.mkv,b.mkv'));
    expect(api.fetchDownloads).toHaveBeenCalledTimes(2);
    expect(api.fetchDownloads).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
    fireEvent.click(screen.getByText('loadMore'));   // no more pages
    expect(api.fetchDownloads).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('refresh'));
    await waitFor(() => expect(api.fetchDownloads).toHaveBeenCalledTimes(3));
  });

  it('the download actions call the API, and a failed retry toasts', async () => {
    const captured = captureToasts();
    try {
      vi.mocked(api.retryDownload).mockRejectedValue(new Error('Nothing to resume'));
      vi.mocked(api.stopDownload).mockResolvedValue(undefined);
      vi.mocked(api.pauseDownload).mockResolvedValue(undefined);
      vi.mocked(api.resumeDownload).mockResolvedValue(undefined);
      vi.mocked(api.deleteDownload).mockResolvedValue(undefined);
      renderLayout();
      await screen.findByText('0 B');
      fireEvent.click(screen.getByText('stop'));
      fireEvent.click(screen.getByText('pause'));
      fireEvent.click(screen.getByText('resume'));
      fireEvent.click(screen.getByText('delete'));
      await waitFor(() => expect(api.deleteDownload).toHaveBeenCalledWith('m1', true));
      expect(api.stopDownload).toHaveBeenCalledWith('m1');
      expect(api.pauseDownload).toHaveBeenCalledWith('m1');
      expect(api.resumeDownload).toHaveBeenCalledWith('m1');
      fireEvent.click(screen.getByText('retry'));
      expect(await screen.findByText('Retry failed')).toBeInTheDocument();
      expect(screen.getByText('Nothing to resume')).toBeInTheDocument();
      expect(api.retryDownload).toHaveBeenCalledWith(1);
    } finally { captured.stop(); }
  });

  it('holds the add-URL dialog state for the page', async () => {
    renderLayout();
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('state')).toHaveTextContent('add=true:https://x');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { makeDownload } from '../test/fixtures';
import { captureToasts } from '../test/toasts';
import type { Download } from '../types';
import { VpsPage } from './VpsPage';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()), fetchVpsFiles: vi.fn(), downloadVpsFile: vi.fn(), deleteVpsRemote: vi.fn(), fetchTorrentConfig: vi.fn(),
}));

const layout = vi.hoisted(() => ({
  downloads: [] as Download[], onStop: vi.fn(async () => {}), onRetry: vi.fn(async () => {}), vpsReady: true, showSecured: false,
}));
vi.mock('../components/Layout', () => ({ useLayoutContext: () => layout }));

// The torrent panels and the usage strip have their own tests; the stub
// panel reports a count the way the real one does, so the tab badges can be
// checked.
const counts = vi.hoisted(() => ({ transmission: 3, qbittorrent: 0 }));
vi.mock('../components/TorrentStatusPanel', () => ({
  TorrentStatusPanel: ({ client, onCountChange }: { client: api.TorrentClient; onCountChange?: (n: number) => void }) => {
    useEffect(() => { onCountChange?.(counts[client]); }, [client, onCountChange]);
    return <div data-testid={`panel-${client}`} />;
  },
}));
vi.mock('../components/VpsUsageBar', () => ({ VpsUsageBar: () => <div data-testid="usage" /> }));
vi.mock('react-time-ago', () => ({ default: () => <span>a moment ago</span> }));

const entry = (over: Partial<api.VpsFileEntry> = {}): api.VpsFileEntry => ({
  name: 'movie.mkv', path: '/home/hs/downloads/movie.mkv', folder: '/home/hs/downloads', is_dir: false, size: 1024 ** 3,
  modified: '2026-11-01T10:00:00Z', downloaded: false, ...over,
});
const group = (over: Partial<api.VpsFolderGroup> = {}): api.VpsFolderGroup => ({
  path: '/home/hs/downloads', auto_sync: false, active: true, entries: [entry()], ...over,
});
const clientConfig = (configured: boolean, hidden = false): api.TorrentClientConfig => ({
  configured, url: '', username: '', has_password: false, download_dir: '', incomplete_dir: '', local_dir: '', stop_on_complete: true, hidden,
});
const torrentConfig = (transmission: api.TorrentClientConfig, qbittorrent: api.TorrentClientConfig): api.TorrentConfig =>
  ({ transmission, qbittorrent, telegram_default: null });

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}</output>;
}
const renderAt = (path = '/vps') => renderWithClient(
  <>
    <Routes>
      <Route path="/vps" element={<VpsPage />} />
      <Route path="/vps/:tab" element={<VpsPage />} />
    </Routes>
    <LocationProbe />
  </>,
  { router: true, initialEntries: [path] },
);
const filesSection = () => screen.getByPlaceholderText('Search files...').closest('.hidden');
const row = (name: string) => screen.getByTitle(name).closest('.rounded-xl') as HTMLElement;
const tabs = () => screen.getAllByRole('button').filter(b => b.className.includes('border-b-2')).map(b => b.textContent?.trim());

beforeEach(() => {
  vi.resetAllMocks();
  layout.downloads = [];
  layout.vpsReady = true;
  layout.showSecured = false;
  layout.onStop = vi.fn(async () => {});
  layout.onRetry = vi.fn(async () => {});
  vi.mocked(api.fetchVpsFiles).mockResolvedValue([group()]);
  vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig(clientConfig(false), clientConfig(false)));
  vi.mocked(api.downloadVpsFile).mockResolvedValue({ id: 1, message_id: 'new' });
  vi.mocked(api.deleteVpsRemote).mockResolvedValue({ status: 'ok' });
});

describe('VpsPage - tabs', () => {
  it('shows only the Files tab until a torrent client is configured', async () => {
    renderAt();
    expect(await screen.findByTitle('movie.mkv')).toBeInTheDocument();
    expect(tabs()).toEqual(['Files (1)']);
    expect(screen.queryByTestId('panel-transmission')).toBeNull();
    expect(screen.getByTestId('usage')).toBeInTheDocument();
    expect(filesSection()).toBeNull();
  });

  it('a configured client gets a tab with its live count; its URL shows the panel and hides the files', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig(clientConfig(true), clientConfig(true)));
    renderAt('/vps/transmission');
    expect(await screen.findByTestId('panel-transmission')).toBeInTheDocument();
    await waitFor(() => expect(tabs()).toEqual(['Files (1)', 'Transmission (3)', 'qBittorrent']));
    // Both panels stay mounted (their counts feed the badges); only the current one shows
    expect(screen.getByTestId('panel-transmission').parentElement).not.toHaveClass('hidden');
    expect(screen.getByTestId('panel-qbittorrent').parentElement).toHaveClass('hidden');
    expect(filesSection()).not.toBeNull();
    expect(screen.queryByTitle('Refresh listing')).toBeNull();   // a Files-only control

    fireEvent.click(screen.getByRole('button', { name: /qBittorrent/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/vps/qbittorrent');
    expect(screen.getByTestId('panel-qbittorrent').parentElement).not.toHaveClass('hidden');
    fireEvent.click(screen.getByRole('button', { name: /Files/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/vps/files');
    expect(filesSection()).toBeNull();
  });

  it('a hidden client falls back to Files, unless secured items are shown', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue(torrentConfig(clientConfig(true, true), clientConfig(false)));
    const { unmount } = renderAt('/vps/transmission');
    await screen.findByTitle('movie.mkv');
    await waitFor(() => expect(api.fetchTorrentConfig).toHaveBeenCalled());
    expect(tabs()).toEqual(['Files (1)']);
    expect(screen.queryByTestId('panel-transmission')).toBeNull();
    expect(filesSection()).toBeNull();
    unmount();

    layout.showSecured = true;
    renderAt('/vps/transmission');
    expect(await screen.findByTestId('panel-transmission')).toBeInTheDocument();
    expect(filesSection()).not.toBeNull();
    expect(api.fetchVpsFiles).toHaveBeenLastCalledWith(true);
  });

  it('a stale client URL with nothing configured is the Files view', async () => {
    renderAt('/vps/qbittorrent');
    expect(await screen.findByTitle('movie.mkv')).toBeInTheDocument();
    expect(filesSection()).toBeNull();
  });

  it('the Settings button goes to the VPS settings', async () => {
    renderAt();
    fireEvent.click(await screen.findByTitle('VPS settings'));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/vps');
  });
});

describe('VpsPage - files', () => {
  it('spins, then lists entries with folder, size and age; folders say "folder"', async () => {
    vi.mocked(api.fetchVpsFiles).mockResolvedValue([group({ entries: [entry(), entry({ name: 'Season 1', path: '/home/hs/downloads/Season 1', is_dir: true, modified: null })] })]);
    renderAt();
    expect(screen.getByText('Loading VPS files...')).toBeInTheDocument();
    const r = await screen.findByTitle('movie.mkv').then(() => row('movie.mkv'));
    expect(within(r).getByTitle('/home/hs/downloads')).toBeInTheDocument();
    expect(within(r).getByText('1.00 GB')).toBeInTheDocument();
    expect(within(r).getByText('a moment ago')).toBeInTheDocument();
    expect(within(row('Season 1')).getByText('folder')).toBeInTheDocument();
    expect(within(row('Season 1')).queryByText('a moment ago')).toBeNull();
  });

  it('with no connection: points at Settings', async () => {
    layout.vpsReady = false;
    vi.mocked(api.fetchVpsFiles).mockResolvedValue([]);
    renderAt();
    expect(await screen.findByText('No VPS connection or watched folders')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /configure a vps and add folders/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/vps');
  });

  it('an empty watched folder says "No files found"; a failed listing is a toast', async () => {
    vi.mocked(api.fetchVpsFiles).mockResolvedValueOnce([group({ entries: [] })]).mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    const { unmount } = renderAt();
    expect(await screen.findByText('No files found')).toBeInTheDocument();
    unmount();
    renderAt();
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to load VPS files'));
    capture.stop();
  });

  it('shows a per-folder listing error, counts folders on other connections, and offers the folder filter', async () => {
    vi.mocked(api.fetchVpsFiles).mockResolvedValue([
      group(),
      group({ path: '/home/hs/other', entries: [entry({ name: 'other.mkv', path: '/home/hs/other/other.mkv', folder: '/home/hs/other' })] }),
      group({ path: '/home/hs/broken', error: 'Permission denied', entries: [] }),
      group({ path: '/old/box', active: false, host: 'old', entries: [entry({ name: 'old.mkv', path: '/old/box/old.mkv' })] }),
    ]);
    renderAt();
    expect(await screen.findByText('Permission denied', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('1 folder on other VPS connections hidden.')).toBeInTheDocument();
    expect(screen.queryByTitle('old.mkv')).toBeNull();
    expect(tabs()).toEqual(['Files (2)']);
    const filter = screen.getByTitle('Filter by watched folder');
    expect(within(filter).getAllByRole('option').map(o => o.textContent)).toEqual(['All folders', '/home/hs/downloads', '/home/hs/other', '/home/hs/broken']);
    fireEvent.change(filter, { target: { value: '/home/hs/other' } });
    expect(screen.queryByTitle('movie.mkv')).toBeNull();
    expect(screen.getByTitle('other.mkv')).toBeInTheDocument();
  });

  it('search narrows by name and says when nothing matches', async () => {
    vi.mocked(api.fetchVpsFiles).mockResolvedValue([group({ entries: [entry(), entry({ name: 'clip.mp4', path: '/x/clip.mp4' })] })]);
    renderAt();
    await screen.findByTitle('movie.mkv');
    const search = screen.getByPlaceholderText('Search files...');
    fireEvent.change(search, { target: { value: 'CLIP' } });
    expect(screen.queryByTitle('movie.mkv')).toBeNull();
    expect(screen.getByTitle('clip.mp4')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No files match "zzz"')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Clear search', { selector: 'button' }));
    expect(screen.getByTitle('movie.mkv')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'm' } });
    fireEvent.click(screen.getByTitle('Clear search'));
    expect(search).toHaveValue('');
  });

  it('Refresh refetches the listing', async () => {
    renderAt();
    await screen.findByTitle('movie.mkv');
    fireEvent.click(screen.getByTitle('Refresh listing'));
    await waitFor(() => expect(api.fetchVpsFiles).toHaveBeenCalledTimes(2));
  });
});

describe('VpsPage - a file row', () => {
  it('Download starts a VPS pull with the path and size; a refusal is a toast', async () => {
    vi.mocked(api.downloadVpsFile).mockResolvedValueOnce({ id: 1, message_id: 'm' }).mockResolvedValueOnce({ error: 'already downloaded' });
    const capture = captureToasts();
    renderAt();
    await screen.findByTitle('movie.mkv');
    fireEvent.click(within(row('movie.mkv')).getByTitle('Download to server'));
    await waitFor(() => expect(api.downloadVpsFile).toHaveBeenCalledWith('/home/hs/downloads/movie.mkv', 1024 ** 3, undefined));
    fireEvent.click(within(row('movie.mkv')).getByTitle('Download to server'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('already downloaded'));
    capture.stop();
  });

  it('a running pull (matched by remote path) shows live progress and a stop button', async () => {
    layout.downloads = [makeDownload({
      id: 7, message_id: 'm7', downloaded_from: 'vps', url: '/home/hs/downloads/movie.mkv', status: 'downloading',
      progress: 42.5, downloaded_bytes: 435 * 1024 ** 2, total_bytes: 1024 ** 3, speed: 2048, pending_time: 300,
    })];
    renderAt();
    const r = await screen.findByTitle('movie.mkv').then(() => row('movie.mkv'));
    expect(within(r).getByText('435.00 MB / 1.00 GB')).toBeInTheDocument();
    expect(within(r).getByText('42.5% · 2.0 MB/s · ETA 5m 0s')).toBeInTheDocument();
    expect(within(r).queryByTitle('Download to server')).toBeNull();
    expect(within(r).queryByTitle('Delete from VPS (permanent)')).toBeNull();
    fireEvent.click(within(r).getByTitle('Stop download'));
    expect(layout.onStop).toHaveBeenCalledWith('m7');
  });

  it('a finished pull reads "Downloaded"; a failed or stopped one offers a retry', async () => {
    vi.mocked(api.fetchVpsFiles).mockResolvedValue([group({ entries: [
      entry({ status: 'done', downloaded: true }),
      entry({ name: 'failed.mkv', path: '/home/hs/downloads/failed.mkv', status: 'failed' }),
      entry({ name: 'stopped.mkv', path: '/home/hs/downloads/stopped.mkv', status: 'stopped' }),
    ] })]);
    layout.downloads = [makeDownload({ id: 9, message_id: 'm9', downloaded_from: 'vps', url: '/home/hs/downloads/failed.mkv', status: 'failed' })];
    renderAt();
    await screen.findByTitle('movie.mkv');
    expect(within(row('movie.mkv')).getByText('Downloaded')).toBeInTheDocument();
    expect(within(row('movie.mkv')).queryByTitle('Download to server')).toBeNull();
    const failed = row('failed.mkv');
    expect(within(failed).getByText('failed')).toBeInTheDocument();
    fireEvent.click(within(failed).getByTitle('Retry'));
    expect(layout.onRetry).toHaveBeenCalledWith(9);
    // Stopped, with no live record to retry: the snapshot's badge and a fresh download
    const stopped = row('stopped.mkv');
    expect(within(stopped).getByText('stopped')).toBeInTheDocument();
    expect(within(stopped).queryByTitle('Retry')).toBeNull();
    expect(within(stopped).getByTitle('Download to server')).toBeInTheDocument();
  });

  it('deleting on the VPS asks first, names what goes, then refreshes the listing', async () => {
    vi.mocked(api.fetchVpsFiles).mockResolvedValue([group({ entries: [entry(), entry({ name: 'Season 1', path: '/s1', is_dir: true })] })]);
    vi.mocked(api.deleteVpsRemote).mockResolvedValueOnce({ status: 'ok' }).mockResolvedValueOnce({ error: 'read-only' });
    const capture = captureToasts();
    const { client } = renderAt();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByTitle('movie.mkv');
    fireEvent.click(within(row('Season 1')).getByTitle('Delete from VPS (permanent)'));
    expect(screen.getByText(/permanently deletes the folder "Season 1" on the remote VPS and everything inside it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.deleteVpsRemote).not.toHaveBeenCalled();

    fireEvent.click(within(row('movie.mkv')).getByTitle('Delete from VPS (permanent)'));
    expect(screen.getByText(/permanently deletes the file "movie.mkv"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete from VPS' }));
    await waitFor(() => expect(api.deleteVpsRemote).toHaveBeenCalledWith('/home/hs/downloads/movie.mkv'));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vps', 'files'] }));

    fireEvent.click(within(row('Season 1')).getByTitle('Delete from VPS (permanent)'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete from VPS' }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('read-only'));
    capture.stop();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { makeDownload } from '../test/fixtures';
import { captureToasts } from '../test/toasts';
import { qk } from '../api/queryKeys';
import type { Download } from '../types';
import { TorrentStatusPanel, downleeState, isPendingPull, isAlreadyDownloaded } from './TorrentStatusPanel';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()), fetchTorrentList: vi.fn(), torrentAction: vi.fn(), downloadVpsFile: vi.fn(),
}));

// The shared downloads list (WebSocket-fed) and the retry handler come from
// the Layout outlet; a test sets what it wants the panel to see.
const layout = vi.hoisted(() => ({ downloads: [] as Download[], onRetry: vi.fn(async () => {}) }));
vi.mock('./Layout', () => ({ useLayoutContext: () => layout }));

vi.mock('./TorrentDetailsModal', () => ({
  TorrentDetailsModal: ({ hash, name, pulled, onClose }: { hash: string; name: string; pulled?: boolean; onClose: () => void }) => (
    <div role="dialog" aria-label="details">{name}|{hash}|{String(pulled)}<button onClick={onClose}>close details</button></div>
  ),
}));

const GB = 1024 ** 3;
const torrent = (over: Partial<api.TorrentStatus> = {}): api.TorrentStatus => ({
  id: 1, name: 'Ubuntu.iso', hash: 'h1', status: 'downloading', percent_done: 45, rate_download: 1024 * 1024, rate_upload: 0,
  total_size: 2 * GB, eta: 90, download_dir: '/home/hs/tr', content_path: null, error: null,
  peers_connected: 3, seeds_connected: 2, leeches_connected: 1, seeds_total: 20, leeches_total: 5,
  added_date: 1000, force_start: null, downlee: null, ...over,
});
const finished = (over: Partial<api.TorrentStatus> = {}) => torrent({
  status: 'completed', percent_done: 100, rate_download: 0, eta: null, ...over,
});

const list = (...torrents: api.TorrentStatus[]) => ({ configured: true, torrents });
const row = (name: string) => screen.getByText(name).closest('.rounded-xl') as HTMLElement;
/** The row's actions render twice (desktop + phone); the first copy is enough. */
const action = (name: string, title: string) => within(row(name)).getAllByTitle(title)[0];
/** The DownLee state is behind a tooltip; hover its trigger to read it. */
const hoverDownlee = (name: string) => {
  const trigger = row(name).querySelector('.inline-flex') as HTMLElement;
  fireEvent.mouseEnter(trigger);
  return trigger;
};
const downleeButton = (name: string) => (row(name).querySelector('.inline-flex button') as HTMLButtonElement | null);
const statusFilter = () => screen.getByTitle('Filter by status');

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}</output>;
}
const renderPanel = (client: api.TorrentClient = 'transmission', onCountChange?: (n: number) => void) =>
  renderWithClient(<><TorrentStatusPanel client={client} onCountChange={onCountChange} /><LocationProbe /></>, { router: true, initialEntries: ['/vps/transmission'] });

beforeEach(() => {
  vi.resetAllMocks();
  layout.downloads = [];
  layout.onRetry = vi.fn(async () => {});
  vi.mocked(api.torrentAction).mockResolvedValue({});
  vi.mocked(api.downloadVpsFile).mockResolvedValue({ id: 1, message_id: 'new' });
});

describe('downleeState / isPendingPull', () => {
  it('the live downloads list overrides the server match while a pull runs', () => {
    const t = finished({ downlee: { id: 5, message_id: 'm5', status: 'stopped', progress: 10 } });
    const live = makeDownload({ id: 5, message_id: 'm5', status: 'downloading', progress: 62 });
    const dl = downleeState(t, [live], new Set());
    expect(dl).toMatchObject({ status: 'downloading', progress: 62, running: true, done: false, retryable: false });
    expect(isPendingPull(t, dl)).toBe(false);
    const stale = downleeState(t, [], new Set());
    expect(stale).toMatchObject({ status: 'stopped', progress: 10, retryable: true, running: false });
    expect(isPendingPull(t, stale)).toBe(true);   // stopped = still not here
  });

  it('a just-started pull counts as running until the list catches up', () => {
    const t = finished();
    expect(downleeState(t, [], new Set(['h1'])).running).toBe(true);
    expect(downleeState(t, [], new Set()).running).toBe(false);
    expect(isPendingPull(t, downleeState(t, [], new Set()))).toBe(true);
    expect(isPendingPull(torrent(), downleeState(torrent(), [], new Set()))).toBe(false);   // not finished on the VPS yet
  });

  it('done is done, whichever side says so', () => {
    const t = finished({ downlee: { id: null, message_id: null, status: 'done', progress: 100, on_disk: true } });
    const dl = downleeState(t, [], new Set());
    expect(dl.done).toBe(true);
    expect(isAlreadyDownloaded(t, dl)).toBe(true);
    expect(isPendingPull(t, dl)).toBe(false);
  });
});

describe('TorrentStatusPanel - states', () => {
  it('spins, then offers Settings when no client is configured', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue({ configured: false });
    const { container } = renderPanel();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(await screen.findByText('No torrent client configured')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /configure transmission in settings/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/vps');
  });

  it('with no torrents: says so', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list());
    const onCount = vi.fn();
    renderPanel('transmission', onCount);
    expect(await screen.findByText('No torrents')).toBeInTheDocument();
    expect(onCount).toHaveBeenLastCalledWith(0);
  });

  it('a client error, or an unreachable client, is a toast', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValueOnce({ configured: true, error: 'RPC 409' });
    const capture = captureToasts();
    renderPanel();
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('RPC 409'));
    capture.stop();
  });

  it('an unreachable client is a toast too', async () => {
    vi.mocked(api.fetchTorrentList).mockRejectedValue(new Error('ECONNREFUSED'));
    const capture = captureToasts();
    renderPanel();
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to reach the torrent client'));
    capture.stop();
  });
});

describe('TorrentStatusPanel - rows', () => {
  it('shows what a row needs: status, bar, size, rates, swarm, ETA, folder; a finished one is quieter', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(
      torrent({ rate_upload: 2048 }),
      finished({ id: 2, name: 'Done.mkv', hash: 'h2', total_size: GB, rate_upload: 0 }),
    ));
    const onCount = vi.fn();
    renderPanel('transmission', onCount);
    const r = await screen.findByText('Ubuntu.iso').then(() => row('Ubuntu.iso'));
    expect(within(r).getByText('Downloading')).toBeInTheDocument();
    expect(within(r).getByText('45% of 2.00 GB')).toBeInTheDocument();
    expect(within(r).getByText('1.00 MB/s')).toBeInTheDocument();
    expect(within(r).getByText('2.00 KB/s')).toBeInTheDocument();
    expect(within(r).getByTitle('Seeds: connected / available in the swarm')).toHaveTextContent('2/20');
    expect(within(r).getByTitle('Leeches: connected / in the swarm')).toHaveTextContent('1/5');
    expect(within(r).getByText('ETA 1m 30s')).toBeInTheDocument();
    expect(within(r).getByTitle('/home/hs/tr')).toBeInTheDocument();
    expect(r.querySelector('.progress-shimmer')).not.toBeNull();
    expect(onCount).toHaveBeenLastCalledWith(2);

    const d = row('Done.mkv');
    expect(within(d).queryByText('Completed')).toBeNull();   // the normal end state, not a badge
    expect(within(d).getByText('1.00 GB')).toBeInTheDocument();
    expect(within(d).queryByTitle(/Seeds/)).toBeNull();
    expect(d.querySelector('.progress-shimmer')).toBeNull();
    expect(within(d).queryByTitle(/Force start/)).toBeNull();   // nothing left to fetch
  });

  it('a torrent error gets a verify-and-start button', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(torrent({ status: 'stopped', error: 'No data found' })));
    const { client } = renderPanel();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    expect(await screen.findByText('No data found')).toBeInTheDocument();
    expect(within(row('Ubuntu.iso')).getByText('Paused')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Recheck local data on the VPS, then start'));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('transmission', 'verify', ['h1'], false));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentList('transmission') }));
  });

  it('pause and resume: a plain start for stopped or completed, a stop while downloading', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(
      torrent(), torrent({ id: 2, name: 'Paused.mkv', hash: 'h2', status: 'stopped' }), finished({ id: 3, name: 'Done.mkv', hash: 'h3' }),
    ));
    renderPanel('qbittorrent');
    await screen.findByText('Ubuntu.iso');
    fireEvent.click(action('Ubuntu.iso', 'Pause'));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'stop', ['h1'], false));
    fireEvent.click(action('Paused.mkv', 'Resume'));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'start', ['h2'], false));
    fireEvent.click(action('Done.mkv', 'Resume'));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'start', ['h3'], false));
  });

  it('a refused action is a toast', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(torrent()));
    vi.mocked(api.torrentAction).mockResolvedValue({ error: 'torrent not found' });
    const capture = captureToasts();
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    fireEvent.click(action('Ubuntu.iso', 'Pause'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('torrent not found'));
    capture.stop();
  });

  it('force start jumps the queue; on a forced torrent the same button sends a plain start', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(
      torrent({ force_start: false }),
      torrent({ id: 2, name: 'Forced.mkv', hash: 'h2', force_start: true }),
      torrent({ id: 3, name: 'Unknown.mkv', hash: 'h3', force_start: null }),
    ));
    renderPanel('qbittorrent');
    await screen.findByText('Ubuntu.iso');
    fireEvent.click(action('Ubuntu.iso', "Force start - jump the client's download queue"));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'force-start', ['h1'], false));
    fireEvent.click(action('Forced.mkv', 'Force started - running ahead of the queue. Click to return it to the queue.'));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'start', ['h2'], false));
    // null = can't tell (Transmission): offered, but never lit up
    expect(action('Unknown.mkv', "Force start - jump the client's download queue")).toBeInTheDocument();
  });

  it('remove asks first; "Remove with data" deletes the files too', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(torrent()));
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    fireEvent.click(action('Ubuntu.iso', 'Remove torrent'));
    expect(screen.getByRole('heading', { name: 'Remove torrent?' })).toBeInTheDocument();
    expect(screen.getByText(/Remove "Ubuntu.iso" from the torrent client/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.torrentAction).not.toHaveBeenCalled();
    fireEvent.click(action('Ubuntu.iso', 'Remove torrent'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove with data' }));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('transmission', 'remove', ['h1'], true));
    fireEvent.click(action('Ubuntu.iso', 'Remove torrent'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('transmission', 'remove', ['h1'], false));
  });

  it('clicking the row (not its controls) opens the details modal', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(finished({ downlee: { id: 1, message_id: 'm', status: 'done', progress: 100 } })));
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    fireEvent.click(within(row('Ubuntu.iso')).getByTitle('/home/hs/tr'));
    const dialog = screen.getByRole('dialog', { name: 'details' });
    expect(dialog).toHaveTextContent('Ubuntu.iso|h1|true');
    fireEvent.click(screen.getByText('close details'));
    expect(screen.queryByRole('dialog', { name: 'details' })).toBeNull();
    // The name is a button for the same thing
    fireEvent.click(screen.getByTitle('Ubuntu.iso - show files and details'));
    expect(screen.getByRole('dialog', { name: 'details' })).toBeInTheDocument();
    // A row control does not open it
    fireEvent.click(screen.getByText('close details'));
    fireEvent.click(action('Ubuntu.iso', 'Resume'));
    expect(screen.queryByRole('dialog', { name: 'details' })).toBeNull();
  });
});

describe('TorrentStatusPanel - the DownLee transfer', () => {
  it('offers the pull on a finished torrent, posting its content path, then shows it running', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(finished({ content_path: '/home/hs/tr/Ubuntu.iso' })));
    renderPanel('qbittorrent');
    await screen.findByText('Ubuntu.iso');
    hoverDownlee('Ubuntu.iso');
    expect(screen.getByText('Download to DownLee')).toBeInTheDocument();
    fireEvent.click(downleeButton('Ubuntu.iso')!);
    await waitFor(() => expect(api.downloadVpsFile).toHaveBeenCalledWith('/home/hs/tr/Ubuntu.iso', undefined, 'qbittorrent'));
    // Accepted: running at 0% until the list refetch carries the server's own match
    await waitFor(() => expect(within(row('Ubuntu.iso')).getAllByText('0%').length).toBeGreaterThan(0));
    hoverDownlee('Ubuntu.iso');
    expect(screen.getByText('Downloading to DownLee')).toBeInTheDocument();
  });

  it('without a content path, falls back to <download_dir>/<name>; a refusal is a toast', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(finished({ download_dir: '/home/hs/tr/' })));
    vi.mocked(api.downloadVpsFile).mockResolvedValueOnce({ error: 'already downloaded' }).mockRejectedValueOnce(new Error('x'));
    const capture = captureToasts();
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    fireEvent.click(downleeButton('Ubuntu.iso')!);
    await waitFor(() => expect(api.downloadVpsFile).toHaveBeenCalledWith('/home/hs/tr/Ubuntu.iso', undefined, 'transmission'));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('already downloaded'));
    fireEvent.click(downleeButton('Ubuntu.iso')!);
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to start the download to DownLee'));
    capture.stop();
  });

  it('already pulled: a check, worded differently when only the files on disk say so', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(
      finished({ downlee: { id: 4, message_id: 'm4', status: 'done', progress: 100 } }),
      finished({ id: 2, name: 'OnDisk.mkv', hash: 'h2', downlee: { id: null, message_id: null, status: 'done', progress: 100, on_disk: true } }),
    ));
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    expect(downleeButton('Ubuntu.iso')).toBeNull();
    hoverDownlee('Ubuntu.iso');
    expect(screen.getByText('Already downloaded to DownLee')).toBeInTheDocument();
    hoverDownlee('OnDisk.mkv');
    expect(screen.getByText('Already on DownLee (files found on disk)')).toBeInTheDocument();
  });

  it('live progress comes from the shared downloads list, not the server snapshot', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(finished({ downlee: { id: 5, message_id: 'm5', status: 'stopped', progress: 10 } })));
    layout.downloads = [makeDownload({ id: 5, message_id: 'm5', status: 'downloading', progress: 37 })];
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    expect(within(row('Ubuntu.iso')).getAllByText('37%').length).toBeGreaterThan(0);
    expect(downleeButton('Ubuntu.iso')).toBeNull();
  });

  it('a failed or stopped transfer gets a retry that goes through the shared handler', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(finished({ downlee: { id: 9, message_id: 'm9', status: 'failed', progress: 60 } })));
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    hoverDownlee('Ubuntu.iso');
    expect(screen.getByText('Transfer to DownLee failed — retry')).toBeInTheDocument();
    fireEvent.click(downleeButton('Ubuntu.iso')!);
    expect(layout.onRetry).toHaveBeenCalledWith(9);
    expect(api.downloadVpsFile).not.toHaveBeenCalled();
  });
});

describe('TorrentStatusPanel - search, filter, sort, selection', () => {
  const four = () => list(
    torrent({ force_start: true, added_date: 40 }),                                         // downloading, forced
    finished({ id: 2, name: 'Pending.mkv', hash: 'h2', added_date: 30 }),                   // finished, not pulled
    finished({ id: 3, name: 'Pulled.mkv', hash: 'h3', added_date: 20, downlee: { id: 3, message_id: 'm3', status: 'done', progress: 100 } }),
    torrent({ id: 4, name: 'Stopped.mkv', hash: 'h4', status: 'stopped', percent_done: 30, added_date: 10 }),
  );
  const names = () => screen.getAllByTitle(/show files and details/).map(b => b.textContent);

  it('the status filter lists the statuses present plus the three pseudo-statuses with counts', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(four());
    renderPanel('qbittorrent');
    await screen.findByText('Ubuntu.iso');
    expect(within(statusFilter()).getAllByRole('option').map(o => o.textContent)).toEqual([
      'All statuses', 'Completed', 'Downloading', 'Paused', 'Forced (1)', 'To be downloaded (1)', 'Already downloaded (1)',
    ]);
    fireEvent.change(statusFilter(), { target: { value: '@forced' } });
    expect(names()).toEqual(['Ubuntu.iso']);
    fireEvent.change(statusFilter(), { target: { value: '@todo' } });
    expect(names()).toEqual(['Pending.mkv']);
    fireEvent.change(statusFilter(), { target: { value: '@done' } });
    expect(names()).toEqual(['Pulled.mkv']);
    fireEvent.change(statusFilter(), { target: { value: 'stopped' } });
    expect(names()).toEqual(['Stopped.mkv']);
    fireEvent.change(statusFilter(), { target: { value: 'completed' } });
    expect(names()).toEqual(['Pending.mkv', 'Pulled.mkv']);
  });

  it('a Transmission list never offers "Forced" (it cannot report it) and a failed pull still counts as to-do', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(list(
      torrent(), finished({ id: 2, name: 'Failed.mkv', hash: 'h2', downlee: { id: 2, message_id: 'm2', status: 'failed', progress: 50 } }),
    ));
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    const options = within(statusFilter()).getAllByRole('option').map(o => o.textContent);
    expect(options).not.toContain(expect.stringMatching(/^Forced/));
    expect(options).toContain('To be downloaded (1)');
    expect(options).not.toContain(expect.stringMatching(/^Already downloaded/));
  });

  it('search narrows by name; no match offers to clear the filters', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(four());
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    const search = screen.getByPlaceholderText('Search torrents...');
    fireEvent.change(search, { target: { value: 'PULL' } });
    expect(names()).toEqual(['Pulled.mkv']);
    fireEvent.click(screen.getByTitle('Clear search'));
    expect(names()).toHaveLength(4);
    fireEvent.change(search, { target: { value: 'zzz' } });
    fireEvent.change(statusFilter(), { target: { value: 'stopped' } });
    expect(screen.getByText('No torrents match the current filters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(names()).toHaveLength(4);
    expect(statusFilter()).toHaveValue('');
  });

  it('sorts by created (newest first), name, or status', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(four());
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    expect(names()).toEqual(['Ubuntu.iso', 'Pending.mkv', 'Pulled.mkv', 'Stopped.mkv']);
    fireEvent.change(screen.getByTitle('Sort by'), { target: { value: 'name' } });
    expect(names()).toEqual(['Pending.mkv', 'Pulled.mkv', 'Stopped.mkv', 'Ubuntu.iso']);
    fireEvent.change(screen.getByTitle('Sort by'), { target: { value: 'status' } });
    expect(names()).toEqual(['Pending.mkv', 'Pulled.mkv', 'Ubuntu.iso', 'Stopped.mkv']);
  });

  it('multi-select by hash: bulk actions run in one call; select-all follows the filter', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(four());
    renderPanel('qbittorrent');
    await screen.findByText('Ubuntu.iso');
    expect(screen.queryByTitle('Resume selected')).toBeNull();
    fireEvent.click(within(row('Ubuntu.iso')).getByTitle('Select'));
    fireEvent.click(within(row('Stopped.mkv')).getByTitle('Select'));
    expect(screen.getByTitle('Resume selected')).toBeInTheDocument();
    expect(within(row('Ubuntu.iso')).getByTitle('Deselect')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Force start selected - jump the client\'s download queue'));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'force-start', ['h1', 'h4'], false));
    fireEvent.click(screen.getByTitle('Pause selected'));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'stop', ['h1', 'h4'], false));
    fireEvent.click(screen.getByTitle('Resume selected'));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'start', ['h1', 'h4'], false));

    // Select all of what the filter shows, on top of the two already chosen
    fireEvent.change(statusFilter(), { target: { value: 'completed' } });
    fireEvent.click(screen.getByTitle('Select all'));
    expect(screen.getByTitle('Deselect all')).toHaveTextContent('4');
    fireEvent.click(screen.getByTitle('Deselect all'));
    expect(screen.getByTitle('Select all')).toHaveTextContent('2');
    fireEvent.change(statusFilter(), { target: { value: '' } });

    fireEvent.click(screen.getByTitle('Remove selected'));
    expect(screen.getByRole('heading', { name: 'Remove 2 torrents?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove with data' }));
    await waitFor(() => expect(api.torrentAction).toHaveBeenCalledWith('qbittorrent', 'remove', ['h1', 'h4'], true));
    // The selection is spent after a remove
    await waitFor(() => expect(screen.queryByTitle('Resume selected')).toBeNull());
  });

  it('a single selection reads in the singular, and the cross clears it', async () => {
    vi.mocked(api.fetchTorrentList).mockResolvedValue(four());
    renderPanel();
    await screen.findByText('Ubuntu.iso');
    fireEvent.click(within(row('Pulled.mkv')).getByTitle('Select'));
    fireEvent.click(screen.getByTitle('Remove selected'));
    expect(screen.getByRole('heading', { name: 'Remove 1 torrent?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByTitle('Clear selection'));
    expect(screen.queryByTitle('Remove selected')).toBeNull();
  });
});

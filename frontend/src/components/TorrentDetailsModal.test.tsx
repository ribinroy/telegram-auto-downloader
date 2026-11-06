import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { makeDownload, deferred } from '../test/fixtures';
import { captureToasts } from '../test/toasts';
import { qk } from '../api/queryKeys';
import type { Download } from '../types';
import { TorrentDetailsModal } from './TorrentDetailsModal';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()),
  fetchTorrentDetails: vi.fn(), setTorrentFilePriority: vi.fn(), renameTorrent: vi.fn(), downloadTorrentFiles: vi.fn(),
}));

const layout = vi.hoisted(() => ({ downloads: [] as Download[], onRetry: vi.fn(async () => {}) }));
vi.mock('./Layout', () => ({ useLayoutContext: () => layout }));

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const TRANSMISSION: api.TorrentFilePriority[] = ['skip', 'low', 'normal', 'high'];
const QBITTORRENT: api.TorrentFilePriority[] = ['skip', 'normal', 'high', 'max'];

const file = (index: number, path: string, over: Partial<api.TorrentFile> = {}): api.TorrentFile => ({
  index, path, size: 100 * MB, downloaded: 100 * MB, percent_done: 100, wanted: true, priority: 'normal', ...over,
});
const torrent = (over: Partial<api.TorrentStatus> = {}): api.TorrentStatus => ({
  id: 1, name: 'Show S01', hash: 'h1', status: 'downloading', percent_done: 60, rate_download: 2 * MB, rate_upload: 512 * 1024,
  total_size: GB, eta: 125, download_dir: '/home/hs/tr', content_path: null, error: null,
  peers_connected: 4, seeds_connected: 3, leeches_connected: 1, seeds_total: 30, leeches_total: 7,
  added_date: 1_700_000_000, force_start: null, downlee: null, ...over,
});
const details = (over: Partial<api.TorrentDetails> = {}, torrentOver: Partial<api.TorrentStatus> = {}): api.TorrentDetails => ({
  torrent: torrent(torrentOver),
  files: [
    file(0, 'Show S01/ep10.mkv', { percent_done: 12.5, downloaded: 12 * MB }),
    file(1, 'Show S01/ep2.mkv'),
    file(2, 'Show S01/extras/sample.mkv', { wanted: false, priority: 'skip', percent_done: 0, downloaded: 0 }),
  ],
  priorities: TRANSMISSION,
  rename_renames_folder: true,
  info: {
    ratio: 1.25, uploaded: 1.25 * GB, downloaded: GB, added_date: 1_700_000_000, done_date: null, comment: 'from the tracker',
    private: true, piece_size: 4 * MB, piece_count: 256,
    trackers: [{ host: 'tracker.example', seeds: 30, leeches: 7, message: null }, { host: 'dead.example', seeds: null, leeches: null, message: 'unregistered torrent' }],
  },
  ...over,
});

const stat = (label: string) => screen.getByText(label).parentElement as HTMLElement;
const renderModal = (client: api.TorrentClient = 'transmission', pulled = false, onClose = vi.fn()) => {
  const utils = renderWithClient(<TorrentDetailsModal client={client} hash="h1" name="Show S01" pulled={pulled} onClose={onClose} />);
  return { ...utils, onClose };
};

beforeEach(() => {
  vi.resetAllMocks();
  layout.downloads = [];
  layout.onRetry = vi.fn(async () => {});
  vi.mocked(api.setTorrentFilePriority).mockResolvedValue(undefined);
  vi.mocked(api.renameTorrent).mockResolvedValue(undefined);
  vi.mocked(api.downloadTorrentFiles).mockResolvedValue({ started: [], skipped: [], errors: [] });
});

describe('TorrentDetailsModal - loading and details', () => {
  it('names the torrent from the list while loading, then fills in the stats, files and trackers', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    const { container } = renderModal();
    expect(screen.getByRole('dialog', { name: 'Show S01' })).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(await screen.findByText(/downloading · 60% of 1.00 GB/)).toBeInTheDocument();
    expect(screen.getByText(/private/)).toBeInTheDocument();
    expect(stat('Downloaded')).toHaveTextContent('1.00 GB');
    expect(stat('Uploaded · ratio')).toHaveTextContent('1.25 GB · 1.25');
    expect(stat('Seeds')).toHaveTextContent('3 / 30');
    expect(stat('Leeches')).toHaveTextContent('1 / 7');
    expect(stat('ETA')).toHaveTextContent('2m 5s');
    expect(stat('Speed')).toHaveTextContent('2.00 MB/s');
    expect(stat('Completed')).toHaveTextContent('—');
    expect(stat('Saved to')).toHaveTextContent('/home/hs/tr');
    expect(stat('Pieces')).toHaveTextContent('256 × 4.00 MB');
    expect(screen.getByText('from the tracker')).toBeInTheDocument();
    expect(screen.getByText('Trackers · 2')).toBeInTheDocument();
    expect(screen.getByText('tracker.example').closest('li')).toHaveTextContent('30 seeds · 7 leeches');
    expect(screen.getByText('dead.example').closest('li')).toHaveTextContent('– seeds · – leeches');
    expect(screen.getByText('unregistered torrent')).toBeInTheDocument();
    expect(container.ownerDocument.body.style.overflow).toBe('hidden');
  });

  it('a torrent that cannot be loaded says so, and toasts', async () => {
    vi.mocked(api.fetchTorrentDetails).mockRejectedValue(new Error('gone'));
    const capture = captureToasts();
    renderModal();
    expect(await screen.findByText("Couldn't load this torrent")).toBeInTheDocument();
    await waitFor(() => expect(capture.titles()).toContain("Couldn't load the torrent"));
    capture.stop();
  });

  it('closes on Escape, the backdrop, or the close button - and restores page scrolling', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    const { onClose, unmount } = renderModal();
    await screen.findByText('Trackers · 2');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('dialog'));   // inside: stays open
    expect(onClose).toHaveBeenCalledTimes(3);
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('a finished torrent: a green bar, no ETA, the done date, the error box when there is one', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details(
      { info: { ...details().info, done_date: 1_700_100_000, comment: null, private: false, piece_size: null, piece_count: null, trackers: [] } },
      { status: 'completed', percent_done: 100, eta: 0, error: 'Tracker gave an error', download_dir: '' },
    ));
    renderModal();
    expect(await screen.findByText('Tracker gave an error')).toBeInTheDocument();
    expect(stat('ETA')).toHaveTextContent('—');
    expect(stat('Pieces')).toHaveTextContent('—');
    expect(stat('Saved to')).toHaveTextContent('—');
    expect(stat('Completed')).not.toHaveTextContent('—');
    expect(screen.queryByText(/Trackers ·/)).toBeNull();
    expect(screen.queryByText(/private/)).toBeNull();
    expect(document.querySelector('.bg-green-500')).not.toBeNull();
  });
});

describe('TorrentDetailsModal - files and priorities', () => {
  it('lists files below their shared folder, in natural order, with per-file progress and the skipped count', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    renderModal();
    expect(await screen.findByText('Files · 3 (1 skipped)')).toBeInTheDocument();
    expect(screen.getByText('in Show S01/')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem').filter(li => li.querySelector('select'));
    expect(rows.map(r => within(r).getByRole('combobox').getAttribute('aria-label'))).toEqual([
      'Priority of ep2.mkv', 'Priority of ep10.mkv', 'Priority of sample.mkv',
    ]);
    expect(within(rows[0]).getByText('done')).toBeInTheDocument();
    expect(within(rows[1]).getByText('12.5%')).toBeInTheDocument();
    expect(within(rows[2]).getByText('extras/')).toBeInTheDocument();
    expect(within(rows[2]).queryByText(/%|done/)).toBeNull();   // a skipped file has no bar
    expect(within(rows[2]).getByText('sample.mkv')).toHaveClass('text-slate-500');
    expect(screen.queryByPlaceholderText('Filter files')).toBeNull();   // only past 8 files
  });

  it('offers only the client\'s own priority levels', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    const { unmount } = renderModal('transmission');
    const select = await screen.findByRole('combobox', { name: 'Priority of ep2.mkv' });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Skip', 'Low', 'Normal', 'High']);
    unmount();

    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details({ priorities: QBITTORRENT }));
    renderModal('qbittorrent');
    const q = await screen.findByRole('combobox', { name: 'Priority of ep2.mkv' });
    expect(within(q).getAllByRole('option').map(o => o.textContent)).toEqual(['Skip', 'Normal', 'High', 'Max']);
  });

  it('a per-file change applies at once, then the client\'s view is refetched', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    const pending = deferred<void>();
    vi.mocked(api.setTorrentFilePriority).mockReturnValue(pending.promise);
    const { client } = renderModal('transmission');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const select = await screen.findByRole('combobox', { name: 'Priority of ep2.mkv' });
    fireEvent.change(select, { target: { value: 'high' } });
    // Optimistic: the select holds the new level while the client is still answering
    await waitFor(() => expect(select).toHaveValue('high'));
    expect(api.setTorrentFilePriority).toHaveBeenCalledWith('transmission', 'h1', [1], 'high');
    expect(invalidate).not.toHaveBeenCalled();
    pending.resolve();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentDetails('transmission', 'h1') }));
  });

  it('a refused change snaps back and toasts', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    vi.mocked(api.setTorrentFilePriority).mockRejectedValue(new Error('unknown priority'));
    const capture = captureToasts();
    renderModal('transmission');
    const select = await screen.findByRole('combobox', { name: 'Priority of ep2.mkv' });
    fireEvent.change(select, { target: { value: 'skip' } });
    await waitFor(() => expect(capture.titles()).toContain("Couldn't change the file priority"));
    await waitFor(() => expect(select).toHaveValue('normal'));
    capture.stop();
  });

  it('bulk: select-all follows the filter, the bar applies a level to the selection and clears it', { timeout: 20_000 }, async () => {
    const many = Array.from({ length: 10 }, (_, i) => file(i, `Show S01/ep${i + 1}.mkv`));
    many.push(file(10, 'Show S01/sample.mkv'));
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details({ files: many }));
    renderModal('transmission');
    const filter = await screen.findByPlaceholderText('Filter files');
    const bar = () => screen.getByText('Clear').parentElement!.parentElement as HTMLElement;
    expect(bar()).toHaveAttribute('inert');
    expect(screen.getByRole('checkbox', { name: 'Select all files' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.change(filter, { target: { value: 'SAMPLE' } });
    expect(screen.getAllByRole('listitem').filter(li => li.querySelector('select'))).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select the files shown' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(bar()).not.toHaveAttribute('inert');
    fireEvent.click(within(bar()).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(api.setTorrentFilePriority).toHaveBeenCalledWith('transmission', 'h1', [10], 'skip'));
    expect(bar()).toHaveAttribute('inert');

    // Clear the filter: a partial selection reads as mixed, select-all takes the rest
    fireEvent.change(filter, { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select ep1.mkv' }));
    expect(screen.getByRole('checkbox', { name: 'Select all files' })).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all files' }));
    expect(screen.getByText('11 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all files' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all files' }));
    expect(bar()).toHaveAttribute('inert');
    fireEvent.change(filter, { target: { value: 'nothing here' } });
    expect(screen.getByText('No file matches')).toBeInTheDocument();
  });

  it('a magnet with no metadata yet has no files to list', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details({ files: [] }));
    renderModal();
    expect(await screen.findByText(/No file list yet/)).toBeInTheDocument();
    expect(screen.getByText('Files · 0')).toBeInTheDocument();
  });
});

describe('TorrentDetailsModal - per-file DownLee', () => {
  it('each finished, wanted file gets a pull button; the rest get nothing', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    renderModal('qbittorrent');
    await screen.findByText('Files · 3 (1 skipped)');
    const pulls = screen.getAllByRole('button', { name: 'Download this file to DownLee' });
    expect(pulls).toHaveLength(1);   // ep2 only: ep10 is at 12.5%, sample is skipped
    expect(pulls[0].closest('li')).toHaveTextContent('ep2.mkv');
  });

  it('starting a pull posts the index, toasts, and shows the file running until the refetch', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    vi.mocked(api.downloadTorrentFiles).mockResolvedValue({ started: [{ index: 1, id: 2, message_id: 'm2' }], skipped: [], errors: [] });
    const capture = captureToasts();
    const { client } = renderModal('qbittorrent');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Download this file to DownLee' }));
    await waitFor(() => expect(api.downloadTorrentFiles).toHaveBeenCalledWith('qbittorrent', 'h1', [1]));
    await waitFor(() => expect(capture.titles()).toContain('Downloading to DownLee'));
    expect(capture.toasts[0].message).toBe('1 file');
    expect(await screen.findByTitle('Downloading to DownLee')).toHaveTextContent('0%');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentDetails('qbittorrent', 'h1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentList('qbittorrent') });
    capture.stop();
  });

  it('reports skipped (already there) and failed files, and a request that throws', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    vi.mocked(api.downloadTorrentFiles)
      .mockResolvedValueOnce({ started: [], skipped: [{ index: 1 }], errors: [{ index: 1, error: 'no such file' }] })
      .mockRejectedValueOnce(new Error('offline'));
    const capture = captureToasts();
    renderModal('qbittorrent');
    fireEvent.click(await screen.findByRole('button', { name: 'Download this file to DownLee' }));
    await waitFor(() => expect(capture.titles()).toContain('Already on DownLee'));
    expect(capture.toasts.find(t => t.title === 'Already on DownLee')?.message).toBe('1 file skipped');
    expect(capture.toasts.find(t => t.title === "Couldn't start the download")?.message).toBe('no such file');
    fireEvent.click(screen.getByRole('button', { name: 'Download this file to DownLee' }));
    await waitFor(() => expect(capture.toasts.filter(t => t.title === "Couldn't start the download")).toHaveLength(2));
    expect(capture.toasts.at(-1)?.message).toBe('offline');
    capture.stop();
  });

  it('shows pulled / live % / retry per file from the server match and the live downloads list', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details({ files: [
      file(0, 'Show S01/done.mkv', { downlee: { id: 1, message_id: 'm1', status: 'done', progress: 100 } }),
      file(1, 'Show S01/live.mkv', { downlee: { id: 2, message_id: 'm2', status: 'stopped', progress: 5 } }),
      file(2, 'Show S01/waiting.mkv', { downlee: { id: 3, message_id: 'm3', status: 'waiting', progress: 0 } }),
      file(3, 'Show S01/failed.mkv', { downlee: { id: 4, message_id: 'm4', status: 'failed', progress: 50 } }),
      file(4, 'Show S01/ondisk.mkv', { downlee: { id: null, message_id: null, status: 'done', progress: 100, on_disk: true } }),
    ] }));
    layout.downloads = [makeDownload({ id: 2, message_id: 'm2', status: 'downloading', progress: 73 })];
    renderModal('transmission');
    await screen.findByText('Files · 5');
    expect(screen.getAllByTitle('On DownLee')).toHaveLength(2);
    const running = screen.getAllByTitle('Downloading to DownLee');
    expect(running.map(r => r.textContent)).toEqual(['73%', '0%']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry the download to DownLee' }));
    expect(layout.onRetry).toHaveBeenCalledWith(4);
    expect(screen.queryByRole('button', { name: 'Download this file to DownLee' })).toBeNull();
  });

  it('a torrent pulled whole marks its files as pulled, except ones with their own transfer', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details({ files: [
      file(0, 'Show S01/a.mkv'),
      file(1, 'Show S01/b.mkv', { downlee: { id: 7, message_id: 'm7', status: 'failed', progress: 1 } }),
    ] }));
    renderModal('transmission', true);
    await screen.findByText('Files · 2');
    expect(screen.getByTitle('Pulled with the whole torrent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry the download to DownLee' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download this file to DownLee' })).toBeNull();
  });

  it('the bulk "To DownLee" pulls only the pullable part of the selection and says how many', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    vi.mocked(api.downloadTorrentFiles).mockResolvedValue({ started: [{ index: 1, id: 2, message_id: 'm2' }], skipped: [], errors: [] });
    renderModal('qbittorrent');
    await screen.findByText('Files · 3 (1 skipped)');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select ep10.mkv' }));
    expect(screen.queryByRole('button', { name: /To DownLee/ })).toBeNull();   // ep10 isn't finished
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select ep2.mkv' }));
    const pull = screen.getByRole('button', { name: 'To DownLee (1)' });
    fireEvent.click(pull);
    await waitFor(() => expect(api.downloadTorrentFiles).toHaveBeenCalledWith('qbittorrent', 'h1', [1]));
    // The selection is spent
    expect(screen.getByText('Clear').parentElement!.parentElement).toHaveAttribute('inert');
  });
});

describe('TorrentDetailsModal - rename in place', () => {
  it('renames the torrent on Enter and says what that means on this client', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    const capture = captureToasts();
    const { client, onClose } = renderModal('transmission', true);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename torrent' }));
    const input = screen.getByRole('textbox', { name: 'New torrent name' });
    expect(input).toHaveValue('Show S01');
    // Transmission: the name is the folder, and this one is already pulled
    expect(screen.getByText('Renames its folder on the VPS too.')).toBeInTheDocument();
    expect(screen.getByText(/Already pulled to DownLee - after this the panel won't recognise it/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: ' Show Season 1 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.renameTorrent).toHaveBeenCalledWith('transmission', 'h1', 'Show Season 1', undefined));
    await waitFor(() => expect(capture.titles()).toContain('Renamed'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentDetails('transmission', 'h1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentList('transmission') });
    expect(screen.queryByRole('textbox', { name: 'New torrent name' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    capture.stop();
  });

  it('on qBittorrent a torrent rename is only a label, so no folder warning', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details({ rename_renames_folder: false, priorities: QBITTORRENT }));
    renderModal('qbittorrent', true);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename torrent' }));
    expect(screen.getByText(/Changes the name shown in the client; the folder on the VPS keeps its name/)).toBeInTheDocument();
    expect(screen.queryByText(/Already pulled to DownLee/)).toBeNull();
  });

  it('Escape cancels the edit without closing the modal; an unchanged or empty name saves nothing', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    const { onClose } = renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Rename torrent' }));
    const input = screen.getByRole('textbox', { name: 'New torrent name' });
    fireEvent.change(input, { target: { value: 'Something else' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'New torrent name' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(api.renameTorrent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Rename torrent' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New torrent name' }), { key: 'Enter' });   // unchanged
    expect(api.renameTorrent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rename torrent' }));
    const again = screen.getByRole('textbox', { name: 'New torrent name' });
    fireEvent.change(again, { target: { value: '   ' } });
    fireEvent.blur(again);   // leaving the field saves - but there is nothing to save
    expect(api.renameTorrent).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'New torrent name' })).toBeNull();
  });

  it('renames a file by its full path, on blur as well as Enter; a refusal is a toast', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    vi.mocked(api.renameTorrent).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('name taken'));
    const capture = captureToasts();
    renderModal('qbittorrent');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename ep2.mkv' }));
    const input = screen.getByRole('textbox', { name: 'New name for ep2.mkv' });
    fireEvent.change(input, { target: { value: 'Episode 2.mkv' } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.renameTorrent).toHaveBeenCalledWith('qbittorrent', 'h1', 'Episode 2.mkv', 'Show S01/ep2.mkv'));

    fireEvent.click(screen.getByRole('button', { name: 'Rename sample.mkv' }));
    const second = screen.getByRole('textbox', { name: 'New name for sample.mkv' });
    fireEvent.change(second, { target: { value: 'clip.mkv' } });
    fireEvent.keyDown(second, { key: 'Enter' });
    await waitFor(() => expect(api.renameTorrent).toHaveBeenCalledWith('qbittorrent', 'h1', 'clip.mkv', 'Show S01/extras/sample.mkv'));
    await waitFor(() => expect(capture.titles()).toContain('Rename failed'));
    expect(capture.toasts.find(t => t.title === 'Rename failed')?.message).toBe('name taken');
    capture.stop();
  });
});

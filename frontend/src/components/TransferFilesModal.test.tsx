import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { makeDownload } from '../test/fixtures';
import { captureToasts } from '../test/toasts';
import { TransferFilesModal } from './TransferFilesModal';

vi.mock('../api', () => ({ fetchTransferFiles: vi.fn(), setTransferFilesStatus: vi.fn(), ensureMediaToken: vi.fn() }));
vi.mock('../api/files', () => ({ getFileStreamUrl: (p: string) => `/stream?path=${p}` }));
vi.mock('./VideoPlayerModal', () => ({
  VideoPlayerModal: ({ isOpen, title, videoUrl }: { isOpen: boolean; title: string; videoUrl: string }) =>
    isOpen ? <div data-testid="player">{title}|{videoUrl}</div> : null,
}));

type Row = api.TransferFiles['files'][number];
const file = (path: string, state: Row['state'], over: Partial<Row> = {}): Row =>
  ({ path, size: 1000, local_size: state === 'done' || state === 'on_disk' ? 1000 : 0, state, local_path: null, ...over });

const listing = (files: Row[], over: Partial<api.TransferFiles> = {}): api.TransferFiles =>
  ({ source: 'vps', error: null, is_dir: true, files, ...over });

const pull = makeDownload({ id: 7, message_id: 'p7', file: 'Show S01', downloaded_from: 'vps', status: 'downloading', file_count: 4 });

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}{loc.search}</output>;
}

const renderModal = (download = pull, onClose = vi.fn()) => {
  const utils = renderWithClient(<><TransferFilesModal download={download} onClose={onClose} /><LocationProbe /></>, { router: true });
  return { ...utils, onClose };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.ensureMediaToken).mockResolvedValue('tok');
  vi.mocked(api.setTransferFilesStatus).mockResolvedValue({ file_status: {}, status: 'downloading', restarted: null });
});

describe('TransferFilesModal - listing', () => {
  it('lists the files, unfinished first, with a progress line and the done count', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing([
      file('ep03.mkv', 'done', { local_path: '/dl/Show S01/ep03.mkv' }),
      file('ep01.mkv', 'downloading', { local_size: 250 }),
      file('ep02.mkv', 'pending'),
      file('ep04.mkv', 'paused', { local_size: 500 }),
    ]));
    renderModal();
    expect(await screen.findByText('ep01.mkv')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Show S01' })).toBeInTheDocument();
    expect(screen.getByText('1 of 4 files done · 1 downloading · 1 paused')).toBeInTheDocument();

    const rows = screen.getAllByRole('listitem').slice(1);   // the first is the column header
    expect(rows.map(r => r.querySelector('.break-all')!.textContent)).toEqual(['ep01.mkv', 'ep02.mkv', 'ep04.mkv', 'ep03.mkv']);
    expect(within(rows[0]).getByText('250.00 B / 1000.00 B')).toBeInTheDocument();
    expect(within(rows[3]).getByText('1000.00 B')).toBeInTheDocument();
    // No filter box under nine files
    expect(screen.queryByPlaceholderText('Filter files...')).toBeNull();
    expect(api.fetchTransferFiles).toHaveBeenCalledWith(7);
  });

  it('offers a filter past eight files and reports no matches', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing(Array.from({ length: 9 }, (_, i) => file(`ep${i}.mkv`, 'pending'))));
    renderModal();
    const box = await screen.findByPlaceholderText('Filter files...');
    fireEvent.change(box, { target: { value: 'EP7' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('ep7.mkv')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No files match')).toBeInTheDocument();
  });

  it('with only the local side listed: a warning, no pause/skip, but view still works', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing([
      file('a.txt', 'on_disk', { local_path: '/dl/Show S01/a.txt' }),
      file('b.mkv', 'partial', { local_size: 10 }),
    ], { source: 'local', error: 'SSH timed out' }));
    renderModal();
    expect(await screen.findByText(/Couldn't compare with the VPS \(SSH timed out\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pause|skip/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show a.txt in the file explorer' })).toBeInTheDocument();
  });

  it('shows a failed load and an empty pull', async () => {
    vi.mocked(api.fetchTransferFiles).mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce(listing([]));
    const first = renderModal();
    expect(await screen.findByText("Couldn't load the file list: 404")).toBeInTheDocument();
    first.unmount();
    renderModal();
    expect(await screen.findByText('No files found')).toBeInTheDocument();
  });
});

describe('TransferFilesModal - decisions', () => {
  it('pause / skip / resume / include-again send the right status for that one file', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing([
      file('a.mkv', 'pending'), file('b.mkv', 'paused'), file('c.mkv', 'skipped'),
    ]));
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause a.mkv' }));
    await waitFor(() => expect(api.setTransferFilesStatus).toHaveBeenCalledWith(7, ['a.mkv'], 'paused'));
    fireEvent.click(screen.getByRole('button', { name: "Skip a.mkv - don't download it" }));
    await waitFor(() => expect(api.setTransferFilesStatus).toHaveBeenCalledWith(7, ['a.mkv'], 'skipped'));
    fireEvent.click(screen.getByRole('button', { name: 'Resume b.mkv' }));
    await waitFor(() => expect(api.setTransferFilesStatus).toHaveBeenCalledWith(7, ['b.mkv'], null));
    fireEvent.click(screen.getByRole('button', { name: 'Download c.mkv after all' }));
    await waitFor(() => expect(api.setTransferFilesStatus).toHaveBeenCalledWith(7, ['c.mkv'], null));
    // A skipped file has no pause/skip of its own
    expect(screen.queryByRole('button', { name: 'Pause c.mkv' })).toBeNull();
  });

  it('toasts what a decision did to the pull: queued, resumed, or finished', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing([file('a.mkv', 'paused'), file('b.mkv', 'pending')]));
    vi.mocked(api.setTransferFilesStatus)
      .mockResolvedValueOnce({ file_status: {}, status: 'waiting', restarted: 'waiting' })
      .mockResolvedValueOnce({ file_status: {}, status: 'downloading', restarted: 'started' })
      .mockResolvedValueOnce({ file_status: { 'b.mkv': 'skipped' }, status: 'done', restarted: null })
      .mockRejectedValueOnce(new Error('VPS unreachable'));
    const capture = captureToasts();
    renderModal(makeDownload({ ...pull, status: 'paused' }));
    const resume = await screen.findByRole('button', { name: 'Resume a.mkv' });
    fireEvent.click(resume);
    await waitFor(() => expect(capture.titles()).toEqual(['Transfer queued']));
    fireEvent.click(screen.getByRole('button', { name: 'Resume a.mkv' }));
    await waitFor(() => expect(capture.titles()).toEqual(['Transfer queued', 'Transfer resumed']));
    fireEvent.click(screen.getByRole('button', { name: "Skip b.mkv - don't download it" }));
    await waitFor(() => expect(capture.titles()).toContain('Transfer complete'));
    expect(capture.toasts[2].message).toBe('Show S01 - the rest is skipped');
    fireEvent.click(screen.getByRole('button', { name: 'Pause b.mkv' }));
    await waitFor(() => expect(capture.titles()).toContain("Couldn't pause the file"));
    expect(capture.toasts[3].message).toBe('VPS unreachable');
    capture.stop();
  });
});

describe('TransferFilesModal - viewing and closing', () => {
  it('plays a finished video here, after making sure of a media token', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing([file('ep01.mkv', 'done', { local_path: '/dl/Show S01/ep01.mkv' })]));
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Play ep01.mkv' }));
    expect(api.ensureMediaToken).toHaveBeenCalled();
    expect(await screen.findByTestId('player')).toHaveTextContent('ep01.mkv|/stream?path=/dl/Show S01/ep01.mkv');
    // While the player is up, Escape is its to handle
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Show S01' })).toBeInTheDocument();
  });

  it('sends anything else to the file explorer, selected, and closes', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing([file('notes.nfo', 'done', { local_path: '/dl/Show S01/notes.nfo' })]));
    const { onClose } = renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Show notes.nfo in the file explorer' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/files?path=%2Fdl%2FShow%20S01&select=%2Fdl%2FShow%20S01%2Fnotes.nfo');
  });

  it('closes on Escape, the X and the backdrop - not on a click inside', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing([]));
    const { onClose } = renderModal();
    await screen.findByText('No files found');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

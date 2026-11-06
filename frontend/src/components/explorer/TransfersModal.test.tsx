import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as files from '../../api/files';
import { renderWithClient } from '../../test/queryWrapper';
import { TransfersModal } from './TransfersModal';

vi.mock('../../api/files', async (orig) => ({
  ...(await orig<typeof files>()),
  fetchTransferFiles: vi.fn(), pauseTransferFiles: vi.fn(), cancelTransfer: vi.fn(), dismissTransfer: vi.fn(),
}));

const job = (over: Partial<files.FileTransfer> = {}): files.FileTransfer => ({
  id: 'j1', move: false, paths: ['/a/Movies'], dest: '/mnt/hdd/Films', status: 'running',
  total_bytes: 4000, done_bytes: 1000, total_files: 3, done_files: 1, items_total: 1, items_done: 0,
  current_item: '/a/Movies', current_file: '/a/Movies/b.mkv', current_file_size: 2000, current_file_done: 500,
  speed: 1024, eta: 65, started_at: 100, finished_at: null, results: [], errors: [], error: null, acknowledged: false, ...over,
});

const tf = (rel: string, state: files.TransferFileState, over: Partial<files.TransferFile> = {}): files.TransferFile =>
  ({ path: `/a/${rel}`, rel, size: 1000, state, rename: false, ...over });

const listing = (id: string, list: files.TransferFile[], over: Partial<files.TransferFileListing> = {}): files.TransferFileListing => ({
  id, status: 'running', files: list, truncated: false,
  counts: { pending: 0, copying: 0, paused: 0, done: 0, failed: 0, skipped: 0, cancelled: 0,
    ...Object.fromEntries(list.map(f => [f.state, list.filter(x => x.state === f.state).length])) },
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(files.fetchTransferFiles).mockResolvedValue(listing('j1', []));
});

describe('TransfersModal - one job', () => {
  it('shows a running copy: title, figures, the file being written, and Cancel', async () => {
    vi.mocked(files.cancelTransfer).mockResolvedValue({ job: job({ status: 'cancelled' }) });
    renderWithClient(<TransfersModal transfers={[job()]} onClose={() => {}} onOpenDest={() => {}} />);
    expect(screen.getByText('Copying Movies to Films')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Done').nextElementSibling).toHaveTextContent('1000.00 B / 3.91 KB');
    expect(screen.getByText('Files').nextElementSibling).toHaveTextContent('1 / 3');
    expect(screen.getByText('Speed').nextElementSibling).toHaveTextContent('1.00 KB/s');
    expect(screen.getByText('Left').nextElementSibling).toHaveTextContent('1m 5s');
    expect(screen.getByText('Now').nextElementSibling).toHaveTextContent('b.mkv');
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(files.cancelTransfer).toHaveBeenCalledWith('j1', expect.anything()));
  });

  it('a finished job: how long it took, what was copied, its errors, and Dismiss', async () => {
    vi.mocked(files.dismissTransfer).mockResolvedValue(undefined);
    const onOpenDest = vi.fn();
    renderWithClient(
      <TransfersModal
        transfers={[job({ move: true, status: 'partial', finished_at: 165, done_bytes: 3000, done_files: 2, errors: [{ path: '/a/Movies/c.mkv', error: 'Permission denied' }] })]}
        onClose={() => {}} onOpenDest={onOpenDest}
      />,
    );
    expect(screen.getByText('Moved Movies to Films')).toBeInTheDocument();
    expect(screen.getByText('Some items failed')).toBeInTheDocument();
    expect(screen.getByText('· took 1m 5s')).toBeInTheDocument();
    expect(screen.getByText('2.93 KB in 2 file(s)')).toBeInTheDocument();
    expect(screen.getByText('c.mkv')).toBeInTheDocument();
    expect(screen.getByText('- Permission denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(files.dismissTransfer).toHaveBeenCalledWith('j1', expect.anything()));
    fireEvent.click(screen.getByTitle('/mnt/hdd/Films'));
    expect(onOpenDest).toHaveBeenCalledWith('/mnt/hdd/Films');
  });

  it('while preparing: a pulse, no figures and no file list', () => {
    renderWithClient(<TransfersModal transfers={[job({ status: 'preparing', total_bytes: 0 })]} onClose={() => {}} onOpenDest={() => {}} />);
    expect(screen.getByText('Counting what to copy…')).toBeInTheDocument();
    expect(screen.queryByText('Files')).toBeNull();
    expect(files.fetchTransferFiles).not.toHaveBeenCalled();
  });

  it('a job-level error is shown', () => {
    renderWithClient(<TransfersModal transfers={[job({ status: 'failed', finished_at: 101, error: 'Destination is read-only' })]} onClose={() => {}} onOpenDest={() => {}} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Destination is read-only')).toBeInTheDocument();
  });
});

describe('TransfersModal - the file list', () => {
  it('lists files copying-first with state chips, and pauses / resumes one at a time', async () => {
    vi.mocked(files.fetchTransferFiles).mockResolvedValue(listing('j1', [
      tf('Movies/a.mkv', 'done'), tf('Movies/b.mkv', 'copying', { done: 500 }), tf('Movies/c.mkv', 'pending'), tf('Movies/d.mkv', 'paused'),
    ]));
    vi.mocked(files.pauseTransferFiles).mockImplementation(async (id, paths, paused) =>
      ({ ...listing(id, [tf('x', paused ? 'paused' : 'pending')]), changed: paths.length }));
    renderWithClient(<TransfersModal transfers={[job()]} onClose={() => {}} onOpenDest={() => {}} />);
    const list = (await screen.findByText('Movies/b.mkv')).closest('ul')!;
    expect(within(list).getAllByRole('listitem').map(li => li.querySelector('.truncate')!.textContent))
      .toEqual(['Movies/b.mkv', 'Movies/d.mkv', 'Movies/c.mkv', 'Movies/a.mkv']);
    expect(screen.getByText('50% of 1000.00 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All 4' })).toHaveClass('text-cyan-200');
    expect(screen.getByRole('button', { name: 'Copying 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copied 1' })).toBeInTheDocument();
    // One pausable or resumable file: no bulk bar
    expect(screen.queryByRole('button', { name: /^Pause \d/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pause Movies/c.mkv' }));
    await waitFor(() => expect(files.pauseTransferFiles).toHaveBeenCalledWith('j1', ['/a/Movies/c.mkv'], true));
    // The answer replaces the listing without waiting for the poll
    expect(await screen.findByText('x')).toBeInTheDocument();
  });

  it('bulk pause / resume follow the chips and the filter', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => tf(`Movies/p${i}.mkv`, 'pending')),
      tf('Movies/z1.mkv', 'paused'), tf('Movies/z2.mkv', 'paused'), tf('Movies/done.mkv', 'done'),
    ];
    vi.mocked(files.fetchTransferFiles).mockResolvedValue(listing('j1', rows));
    vi.mocked(files.pauseTransferFiles).mockImplementation(async (id) => ({ ...listing(id, rows), changed: 0 }));
    renderWithClient(<TransfersModal transfers={[job()]} onClose={() => {}} onOpenDest={() => {}} />);
    await screen.findByText('Movies/p0.mkv');
    expect(screen.getByRole('button', { name: 'Pause 6' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume 2' })).toBeInTheDocument();

    // Past eight files there is a filter; it narrows the bulk action too
    fireEvent.change(screen.getByPlaceholderText('Filter files'), { target: { value: 'p1' } });
    expect(screen.queryByRole('button', { name: 'Pause 6' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Filter files'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Paused 2' }));
    expect(screen.queryByText('Movies/p0.mkv')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume 2' }));
    await waitFor(() => expect(files.pauseTransferFiles).toHaveBeenCalledWith('j1', ['/a/Movies/z1.mkv', '/a/Movies/z2.mkv'], false));

    fireEvent.change(screen.getByPlaceholderText('Filter files'), { target: { value: 'nothing-here' } });
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
  });

  it('a finished job lists its files with no actions; a rename shows as moved', async () => {
    vi.mocked(files.fetchTransferFiles).mockResolvedValue(listing('j1', [
      tf('Movies', 'done', { rename: true }), tf('Movies/e.mkv', 'failed', { error: 'EIO' }),
    ], { status: 'partial', truncated: true }));
    renderWithClient(<TransfersModal transfers={[job({ status: 'partial', finished_at: 110, total_files: 500 })]} onClose={() => {}} onOpenDest={() => {}} />);
    expect(await screen.findByText('moved')).toBeInTheDocument();
    expect(screen.getByText('EIO')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pause /i })).toBeNull();
    expect(screen.getByText('Only the first 2 of 500 files are listed.')).toBeInTheDocument();
  });
});

describe('TransfersModal - several jobs', () => {
  it('shows a tab per job, defaults to the first running one, and switches on click', async () => {
    const done = job({ id: 'j0', status: 'done', finished_at: 120, paths: ['/a/x.txt', '/a/y.txt'] });
    const running = job({ id: 'j1' });
    vi.mocked(files.fetchTransferFiles).mockImplementation(async (id) => listing(id, []));
    renderWithClient(<TransfersModal transfers={[done, running]} onClose={() => {}} onOpenDest={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('2 items');
    expect(tabs[1]).toHaveTextContent('Movies');
    expect(tabs[1]).toHaveTextContent('25%');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Copying Movies to Films')).toBeInTheDocument();

    fireEvent.click(tabs[0]);
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Copied 2 items to Films')).toBeInTheDocument();
    await waitFor(() => expect(files.fetchTransferFiles).toHaveBeenCalledWith('j0', expect.anything()));
  });

  it('says so when there is nothing, and closes on the X or the backdrop', () => {
    const onClose = vi.fn();
    renderWithClient(<TransfersModal transfers={[]} onClose={onClose} onOpenDest={() => {}} />);
    expect(screen.getByText('No transfers right now')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(document.querySelector('.backdrop-blur-sm')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

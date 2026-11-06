import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { makeDownload, makeQueueState } from '../test/fixtures';
import { captureToasts } from '../test/toasts';
import { DownloadQueueButton } from './DownloadQueue';
import type { QueueState } from '../types';

vi.mock('../api', () => ({
  fetchQueue: vi.fn(), setQueueLimits: vi.fn(), reorderQueue: vi.fn(), startQueuedNow: vi.fn(),
  stopAllDownloads: vi.fn(), resumeAllDownloads: vi.fn(),
}));

const running = makeDownload({ id: 1, message_id: 'r1', file: 'running.mkv', progress: 42, speed: 2048 });
const w1 = makeDownload({ id: 2, message_id: 'w1', file: 'first.mkv', status: 'waiting', downloaded_from: 'youtube.com', url: 'https://y/1', total_bytes: 5 * 1024 ** 2 });
const w2 = makeDownload({ id: 3, message_id: 'w2', file: 'second.mkv', status: 'waiting', downloaded_from: 'vps' });
const busy = (over: Partial<QueueState> = {}) => makeQueueState({
  active: { total: 1, telegram: 1, ytdlp: 0, vps: 0 }, running: [running], waiting: [w1, w2], resumable: 0, max_limit: 4, ...over,
});

const open = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /download queue:/i }));
  return screen.getByRole('dialog', { name: 'Downloads' });
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.setQueueLimits).mockImplementation(async limits => busy({ limits: { ...busy().limits, ...limits } }));
});

describe('DownloadQueueButton', () => {
  it('stays out of the way while nothing is queued or stopped', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(makeQueueState());
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    await waitFor(() => expect(api.fetchQueue).toHaveBeenCalled());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows running/total and opens the queue', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy());
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Download queue: 1 of 3 downloading' });
    expect(button).toHaveTextContent('1/3');
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Downloads' });
    expect(within(dialog).getByText('1 downloading · 2 waiting')).toBeInTheDocument();
    expect(within(dialog).getByText(/drag across the line to swap/)).toBeInTheDocument();
  });

  it('with only stopped downloads: a pause icon with the count, and a nudge to resume', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(makeQueueState({ resumable: 2 }));
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Download queue: 2 stopped' });
    expect(button).toHaveTextContent('2');
    fireEvent.click(button);
    expect(screen.getByText('Nothing downloading')).toBeInTheDocument();
    expect(screen.getByText('Resume all to pick the stopped ones back up.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop all/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume all (2)' })).toBeEnabled();
  });
});

describe('queue modal - the line', () => {
  it('lists running then waiting rows with percent, place, source and size', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy());
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    const dialog = await open();
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('42%');
    expect(rows[0]).toHaveTextContent('running.mkv');
    expect(rows[0]).toHaveTextContent('Telegram');
    expect(rows[0]).toHaveTextContent('2.0 MB/s');
    expect(rows[1]).toHaveTextContent('#1');
    expect(rows[1]).toHaveTextContent('youtube.com');   // a URL download is named by its site
    expect(rows[1]).toHaveTextContent('5.00 MB');
    expect(rows[2]).toHaveTextContent('#2');
    expect(rows[2]).toHaveTextContent('VPS');
    // The dashed line sits on the first waiting row only
    expect(rows[1]).toHaveClass('border-dashed');
    expect(rows[2]).not.toHaveClass('border-dashed');
    // Every row has a grip; only waiting ones have start-now / leave
    expect(within(dialog).getAllByRole('button', { name: /^Reorder /i })).toHaveLength(3);
    expect(within(dialog).getAllByRole('button', { name: /^Start .* now$/i })).toHaveLength(2);
  });

  it('start now and leave-the-queue act on that one row', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy());
    vi.mocked(api.startQueuedNow).mockResolvedValue(busy({ running: [running, w1], waiting: [w2] }));
    const onStop = vi.fn();
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={onStop} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Start first.mkv now' }));
    await waitFor(() => expect(api.startQueuedNow).toHaveBeenCalledWith('w1'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove second.mkv from the queue' }));
    expect(onStop).toHaveBeenCalledWith('w2');
  });

  it('keeps a secured source\'s rows out of view but counts them', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy({ waiting: [w1, { ...w2, hidden: true }] }));
    const { rerender } = renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    const dialog = await open();
    expect(within(dialog).queryByText('second.mkv')).toBeNull();
    expect(within(dialog).getByText('1 hidden download also in the queue')).toBeInTheDocument();
    expect(within(dialog).getByText('1 downloading · 2 waiting')).toBeInTheDocument();
    rerender(<DownloadQueueButton showSecured onStop={() => {}} />);
    expect(within(dialog).getByText('second.mkv')).toBeInTheDocument();
    expect(within(dialog).queryByText(/hidden download/)).toBeNull();
  });
});

describe('queue modal - controls', () => {
  it('the stepper changes the global limit within 1..max', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy({ limits: { global: 3, telegram: null, ytdlp: null, vps: null } }));
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'More downloads at once' }));
    await waitFor(() => expect(api.setQueueLimits).toHaveBeenCalledWith({ global: 4 }));
    // Optimistic: 4 shows, and at the max the + is disabled
    await waitFor(() => expect(screen.getByRole('button', { name: 'More downloads at once' })).toBeDisabled());
    expect(screen.getByLabelText('Downloads at once')).toHaveTextContent('4');
    fireEvent.click(screen.getByRole('button', { name: 'Fewer downloads at once' }));
    await waitFor(() => expect(api.setQueueLimits).toHaveBeenLastCalledWith({ global: 3 }));
  });

  it('per-source caps live behind the sliders button; "No cap" sends null', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy({ limits: { global: 3, telegram: null, ytdlp: null, vps: 2 } }));
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    await open();
    expect(screen.queryByText('A source at its cap is skipped, not waited on - the next download in line that fits starts instead.')).toBeNull();
    const toggle = screen.getByTitle('Limits per source');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const vps = screen.getByText('VPS').closest('label')!;
    expect(within(vps).getByText('0 running')).toBeInTheDocument();
    const select = within(vps).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('2');
    expect(within(select).getAllByRole('option')).toHaveLength(5);   // No cap + 1..4
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(api.setQueueLimits).toHaveBeenCalledWith({ vps: null }));
    const tg = within(screen.getByText('Telegram').closest('label')!).getByRole('combobox');
    fireEvent.change(tg, { target: { value: '1' } });
    await waitFor(() => expect(api.setQueueLimits).toHaveBeenCalledWith({ telegram: 1 }));
  });

  it('stop all asks inline, then reports the count', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy());
    vi.mocked(api.stopAllDownloads).mockResolvedValue({ ...busy({ running: [], waiting: [], active: { total: 0, telegram: 0, ytdlp: 0, vps: 0 }, resumable: 3 }), stopped: 3, errors: [] });
    const capture = captureToasts();
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: /stop all/i }));
    expect(screen.getByText('Stop all 3?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Stop all 3?')).toBeNull();
    expect(api.stopAllDownloads).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /stop all/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop all' }));
    await waitFor(() => expect(capture.titles()).toEqual(['Stopped 3 downloads']));
    expect(await screen.findByText('Nothing downloading')).toBeInTheDocument();
    capture.stop();
  });

  it('stop all with a straggler warns rather than cheers', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy());
    vi.mocked(api.stopAllDownloads).mockResolvedValue({ ...busy(), stopped: 2, errors: [{ message_id: 'r1', file: 'running.mkv', error: 'thread hung' }] });
    const capture = captureToasts();
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: /stop all/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop all' }));
    await waitFor(() => expect(capture.toasts[0]).toMatchObject({ type: 'warning', title: "Stopped 2; 1 didn't stop", message: 'thread hung' }));
    capture.stop();
  });

  it('resume all queues the stopped ones and says how many run at once', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(makeQueueState({ resumable: 2 }));
    vi.mocked(api.resumeAllDownloads).mockResolvedValue({ ...busy({ resumable: 0 }), queued: 2 });
    const capture = captureToasts();
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Resume all (2)' }));
    await waitFor(() => expect(capture.toasts[0]).toMatchObject({ title: 'Queued 2 downloads', message: 'Up to 3 run at once.' }));
    capture.stop();
  });

  it('a failed bulk action is a toast with the reason', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(makeQueueState({ resumable: 1 }));
    vi.mocked(api.resumeAllDownloads).mockRejectedValue(new Error('backend down'));
    const capture = captureToasts();
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Resume all (1)' }));
    await waitFor(() => expect(capture.toasts[0]).toMatchObject({ type: 'error', title: 'Resume all failed', message: 'backend down' }));
    capture.stop();
  });

  it('closes on Escape and the X, and keeps the page from scrolling while open', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(busy());
    renderWithClient(<DownloadQueueButton showSecured={false} onStop={() => {}} />);
    await open();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

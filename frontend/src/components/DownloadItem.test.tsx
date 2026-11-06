import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { makeDownload, makeQueueState, deferred } from '../test/fixtures';
import { DownloadItem } from './DownloadItem';
import type { Download } from '../types';

vi.mock('../api', () => ({
  checkVideoFile: vi.fn(),
  getVideoStreamUrl: vi.fn((id: number) => `/stream/${id}`),
  getThumbUrl: vi.fn((id: number, name: string) => `/thumbs/${id}/${name}`),
  ensureMediaToken: vi.fn(),
  fetchQueue: vi.fn(), setQueueLimits: vi.fn(), reorderQueue: vi.fn(), startQueuedNow: vi.fn(),
  stopAllDownloads: vi.fn(), resumeAllDownloads: vi.fn(),
}));
// Needs locale data registered by main.tsx; the date is not what is under test.
vi.mock('react-time-ago', () => ({ default: ({ date }: { date: Date }) => <time dateTime={date.toISOString()}>ago</time> }));
vi.mock('./VideoPlayerModal', () => ({
  VideoPlayerModal: ({ isOpen, title, videoUrl, onClose }: { isOpen: boolean; title: string; videoUrl: string; onClose: () => void }) =>
    isOpen ? <div data-testid="player"><span>{title}|{videoUrl}</span><button onClick={onClose}>close-player</button></div> : null,
}));
vi.mock('./TransferFilesModal', () => ({
  TransferFilesModal: ({ download, onClose }: { download: Download; onClose: () => void }) =>
    <div data-testid="files-modal"><span>files of {download.file}</span><button onClick={onClose}>close-files</button></div>,
}));

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}{loc.search}</output>;
}

type Handlers = { onRetry: ReturnType<typeof vi.fn>; onStop: ReturnType<typeof vi.fn>; onPause: ReturnType<typeof vi.fn>; onResume: ReturnType<typeof vi.fn>; onDelete: ReturnType<typeof vi.fn> };

const renderItem = (download: Download) => {
  const h: Handlers = { onRetry: vi.fn(), onStop: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onDelete: vi.fn() };
  const utils = renderWithClient(<><DownloadItem download={download} {...h} /><LocationProbe /></>, { router: true });
  return { ...utils, ...h };
};

/** The desktop action buttons carry their label in a sibling tooltip div. */
const tipButton = (tip: string) => {
  const el = screen.getByText(tip, { selector: 'div' });
  const button = el.previousElementSibling;
  if (!(button instanceof HTMLButtonElement)) throw new Error(`no button before tooltip "${tip}"`);
  return button;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchQueue).mockResolvedValue(makeQueueState());
  vi.mocked(api.getVideoStreamUrl).mockImplementation((id: number) => `/stream/${id}`);
  vi.mocked(api.getThumbUrl).mockImplementation((id: number, name: string) => `/thumbs/${id}/${name}`);
  vi.mocked(api.ensureMediaToken).mockResolvedValue('tok');
});

describe('DownloadItem - progress and status', () => {
  it('a running download shows the percentage, bytes, speed and ETA, no status badge', () => {
    renderItem(makeDownload({ progress: 42.5, downloaded_bytes: 42_500, total_bytes: 100_000, speed: 2048, pending_time: 75 }));
    expect(screen.getAllByText('42.5%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('41.50 KB / 97.66 KB').length).toBe(2);   // desktop + mobile
    expect(screen.getByText('Speed: 2.0 MB/s')).toBeInTheDocument();
    expect(screen.getByText('ETA: 1m 15s')).toBeInTheDocument();
    expect(screen.queryByText('downloading')).toBeNull();
    const bars = document.querySelectorAll('.progress-shimmer');
    expect(bars).toHaveLength(2);
    expect((bars[0] as HTMLElement).style.width).toBe('42.5%');
  });

  it('a stopped download keeps its bar (yellow) and a stopped badge; paused is amber', () => {
    const { rerender } = renderItem(makeDownload({ status: 'stopped', progress: 30 }));
    expect(screen.getAllByText('stopped')).toHaveLength(2);
    expect(document.querySelectorAll('.bg-yellow-500')).toHaveLength(2);
    rerender(<DownloadItem download={makeDownload({ status: 'paused', progress: 30 })} onRetry={() => {}} onStop={() => {}} onPause={() => {}} onResume={() => {}} onDelete={() => {}} />);
    expect(screen.getAllByText('paused')).toHaveLength(2);
    expect(document.querySelectorAll('.bg-amber-400').length).toBeGreaterThan(0);
  });

  it('a finished download shows its size and the done badge; a failed one its error', () => {
    const { rerender } = renderItem(makeDownload({ status: 'done', progress: 100, total_bytes: 5 * 1024 ** 2 }));
    expect(screen.getAllByText('done')).toHaveLength(2);
    expect(screen.getAllByText('Size: 5.00 MB')).toHaveLength(2);
    expect(document.querySelector('.progress-shimmer')).toBeNull();
    rerender(<DownloadItem download={makeDownload({ status: 'failed', error: 'Connection reset' })} onRetry={() => {}} onStop={() => {}} onPause={() => {}} onResume={() => {}} onDelete={() => {}} />);
    expect(screen.getAllByText('failed')).toHaveLength(2);
    expect(screen.getAllByText('Connection reset').length).toBeGreaterThanOrEqual(2);
  });

  it('a waiting download reads its place in the queue', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(makeQueueState({
      waiting: [makeDownload({ id: 9, message_id: 'other', status: 'waiting' }), makeDownload({ id: 1, message_id: 'm1', status: 'waiting' })],
    }));
    renderItem(makeDownload({ status: 'waiting', progress: 0 }));
    expect(screen.getAllByText('Waiting')).toHaveLength(2);
    expect(await screen.findAllByText('Waiting · #2')).toHaveLength(2);
  });
});

describe('DownloadItem - chips and meta', () => {
  it('shows the hidden chip and the destination folder, in the progress header while a bar is shown', () => {
    renderItem(makeDownload({ hidden: true, dest_folder: '/mnt/media/Films', progress: 50 }));
    expect(screen.getAllByTitle('Hidden from the default view').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('/mnt/media/Films').length).toBeGreaterThan(0);
    expect(screen.getAllByText('/mnt/media/Films').length).toBeGreaterThan(0);
  });

  it('shows the chips next to the size when nothing is in progress', () => {
    renderItem(makeDownload({ status: 'done', dest_folder: '/dl/Videos' }));
    expect(screen.getAllByText('/dl/Videos').length).toBe(2);
    expect(screen.queryByTitle('Hidden from the default view')).toBeNull();
  });

  it('resolution, audio and bit-depth badges come from the file metadata', () => {
    renderItem(makeDownload({
      status: 'done',
      file_meta: { video: { codec: 'hevc', width: 3840, height: 2160, bit_depth: 10, fps: 60, bitrate: 25_000_000 }, audio: { codec: 'aac', channels: 6, sample_rate: 48000, bitrate: 320_000 }, duration: 3725 },
    }));
    expect(screen.getByText('4K')).toBeInTheDocument();
    expect(screen.getByText('5.1')).toBeInTheDocument();
    expect(screen.getByText('10b')).toBeInTheDocument();
  });

  it.each([
    [{ width: 7680, height: 4320 }, '8K'],
    [{ width: 2560, height: 1440 }, '2K'],
    [{ width: 1920, height: 1080 }, 'FH'],
    [{ width: 1280, height: 720 }, 'HD'],
    [{ width: 640, height: 480 }, 'SD'],
  ])('labels %o as %s', (dims, label) => {
    renderItem(makeDownload({ status: 'done', file_meta: { video: { codec: 'h264', ...dims }, audio: { codec: 'aac', channels: 2 } } }));
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('2.0')).toBeInTheDocument();
  });

  it.each([[8, '7.1'], [3, '2.1']])('%i channels reads %s', (channels, label) => {
    renderItem(makeDownload({ status: 'done', file_meta: { audio: { codec: 'ac3', channels } } }));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows the author without its id, the database id and a source link for a URL download', () => {
    renderItem(makeDownload({ id: 42, author: 'alice:12345', url: 'https://youtube.com/watch?v=x', downloaded_from: 'youtube.com', status: 'done' }));
    expect(screen.getAllByText('alice').length).toBe(2);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.length).toBe(2);
    expect(links[0]).toHaveAttribute('href', 'https://youtube.com/watch?v=x');
    expect(links[0]).toHaveAttribute('target', '_blank');
  });

  it('a VPS download stores a remote path in url - not shown as a link on desktop', () => {
    renderItem(makeDownload({ author: 'bob', url: '/home/seed/film.mkv', downloaded_from: 'vps', status: 'done' }));
    expect(screen.queryByText('Source')).toBeNull();
    expect(screen.getAllByText('bob').length).toBe(2);
  });

  it.each(['youtube.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'reddit.com', 'twitch.tv', 'facebook.com', 'vimeo.com'])
  ('draws a brand icon for %s', (source) => {
    const { container } = renderItem(makeDownload({ downloaded_from: source }));
    expect(container.querySelector('svg.w-5.h-5[viewBox]')).not.toBeNull();
  });

  it('an unknown source gets its first letter', () => {
    renderItem(makeDownload({ downloaded_from: 'example.org' }));
    expect(screen.getByText('E')).toBeInTheDocument();
  });

  it('a VPS folder pull with several files offers a files link that opens the modal', () => {
    renderItem(makeDownload({ downloaded_from: 'vps', file_count: 3, file: 'Show S01', status: 'done' }));
    expect(screen.queryByTestId('files-modal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '3 files' }));
    expect(screen.getByTestId('files-modal')).toHaveTextContent('files of Show S01');
    fireEvent.click(screen.getByText('close-files'));
    expect(screen.queryByTestId('files-modal')).toBeNull();
  });

  it('a single-file pull has no files link', () => {
    renderItem(makeDownload({ downloaded_from: 'vps', file_count: 1, status: 'done' }));
    expect(screen.queryByRole('button', { name: /files$/ })).toBeNull();
  });
});

describe('DownloadItem - actions', () => {
  it('telegram downloading: pause acts at once, stop asks first', () => {
    const { onPause, onStop } = renderItem(makeDownload({ downloaded_from: 'telegram' }));
    fireEvent.click(tipButton('Pause'));
    expect(onPause).toHaveBeenCalledWith('m1');
    fireEvent.click(tipButton('Stop'));
    const dialog = screen.getByText('Stop Download?').closest('.fixed')!;
    expect(within(dialog).getByText('This will stop the download and discard progress.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.queryByText('Stop Download?')).toBeNull();
    fireEvent.click(tipButton('Stop'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledWith('m1');
    expect(screen.queryByText('Stop Download?')).toBeNull();
  });

  it('a URL download pauses straight away (its stop keeps the bytes)', () => {
    const { onStop, onPause } = renderItem(makeDownload({ downloaded_from: 'youtube.com', url: 'https://y/1' }));
    fireEvent.click(tipButton('Pause'));
    expect(onStop).toHaveBeenCalledWith('m1');
    expect(onPause).not.toHaveBeenCalled();
    expect(screen.queryByText('Stop')).toBeNull();
  });

  it('paused telegram: resume, or stop after asking (worded as a pause for a VPS pull)', () => {
    const { onResume, onStop, rerender } = renderItem(makeDownload({ status: 'paused' }));
    fireEvent.click(tipButton('Resume'));
    expect(onResume).toHaveBeenCalledWith('m1');
    rerender(<DownloadItem download={makeDownload({ status: 'paused', downloaded_from: 'vps' })} onRetry={() => {}} onStop={onStop} onPause={() => {}} onResume={() => {}} onDelete={() => {}} />);
    fireEvent.click(tipButton('Stop'));
    expect(screen.getByText('Pause Download?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onStop).toHaveBeenCalledWith('m1');
  });

  it('a paused URL download has no resume button here (it is resumed from the queue)', () => {
    renderItem(makeDownload({ status: 'paused', downloaded_from: 'youtube.com', url: 'https://y/1' }));
    expect(screen.queryByText('Resume')).toBeNull();
  });

  it('retry: a failed telegram download retries, a stopped/failed URL download resumes', () => {
    const { onRetry, rerender } = renderItem(makeDownload({ id: 5, status: 'failed' }));
    fireEvent.click(tipButton('Retry'));
    expect(onRetry).toHaveBeenCalledWith(5);
    expect(screen.queryByText('Resume')).toBeNull();
    rerender(<DownloadItem download={makeDownload({ id: 6, status: 'stopped', downloaded_from: 'youtube.com', url: 'https://y/1' })} onRetry={onRetry} onStop={() => {}} onPause={() => {}} onResume={() => {}} onDelete={() => {}} />);
    expect(screen.queryByText('Retry')).toBeNull();
    fireEvent.click(tipButton('Resume'));
    expect(onRetry).toHaveBeenCalledWith(6);
    // A stopped telegram download has neither - it is picked up by the queue
    rerender(<DownloadItem download={makeDownload({ id: 7, status: 'stopped' })} onRetry={onRetry} onStop={() => {}} onPause={() => {}} onResume={() => {}} onDelete={() => {}} />);
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByText('Resume')).toBeNull();
  });

  it('delete asks, then removes the record alone or with its file', () => {
    const { onDelete } = renderItem(makeDownload({ status: 'done' }));
    fireEvent.click(tipButton('Delete'));
    expect(screen.getByText('Delete Download?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith('m1', false);
    expect(screen.queryByText('Delete Download?')).toBeNull();
    fireEvent.click(tipButton('Delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete + File' }));
    expect(onDelete).toHaveBeenCalledWith('m1', true);
    fireEvent.click(tipButton('Delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it('the phone layout drives the same handlers', () => {
    const { onDelete, onPause } = renderItem(makeDownload({ status: 'downloading' }));
    // Phone buttons: pause (amber), stop (yellow), delete (red)
    fireEvent.click(document.querySelector('button.p-1\\.5.bg-amber-500\\/20')!);
    expect(onPause).toHaveBeenCalledWith('m1');
    fireEvent.click(document.querySelector('button.p-1\\.5.bg-red-500\\/20')!);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith('m1', false);
  });

  it('waiting: start now jumps the queue, leave queue stops it', async () => {
    vi.mocked(api.startQueuedNow).mockResolvedValue(makeQueueState());
    const { onStop } = renderItem(makeDownload({ status: 'waiting' }));
    fireEvent.click(tipButton('Start now'));
    await waitFor(() => expect(api.startQueuedNow).toHaveBeenCalledWith('m1'));
    fireEvent.click(tipButton('Leave queue'));
    expect(onStop).toHaveBeenCalledWith('m1');
    // The phone versions carry labels
    fireEvent.click(screen.getByRole('button', { name: 'Leave queue' }));
    expect(onStop).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
    await waitFor(() => expect(api.startQueuedNow).toHaveBeenCalledTimes(2));
  });

  it('a download with no message id does not call the handlers', () => {
    const { onPause, onStop } = renderItem(makeDownload({ message_id: null }));
    fireEvent.click(tipButton('Pause'));
    fireEvent.click(tipButton('Stop'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onPause).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('DownloadItem - the view button', () => {
  it('plays a video inline once the server confirms it is one', async () => {
    const gate = deferred<api.VideoCheckResult>();
    vi.mocked(api.checkVideoFile).mockReturnValue(gate.promise);
    renderItem(makeDownload({ id: 3, status: 'done', file: 'clip.mkv' }));
    const button = screen.getByTitle('Play video');
    fireEvent.click(button);
    expect(button).toBeDisabled();   // checking
    expect(api.checkVideoFile).toHaveBeenCalledWith(3);
    gate.resolve({ exists: true, kind: 'video', path: '/dl/clip.mkv' });
    expect(await screen.findByTestId('player')).toHaveTextContent('clip.mkv|/stream/3');
    expect(api.ensureMediaToken).toHaveBeenCalled();
    expect(button).toBeEnabled();
    fireEvent.click(screen.getByText('close-player'));
    expect(screen.queryByTestId('player')).toBeNull();
  });

  it('a folder pull opens the explorer at that folder', async () => {
    vi.mocked(api.checkVideoFile).mockResolvedValue({ exists: true, kind: 'dir', path: '/dl/Show S01' });
    renderItem(makeDownload({ status: 'done', file: 'Show S01', downloaded_from: 'vps' }));
    fireEvent.click(screen.getByTitle('Show in Files'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/files?path=%2Fdl%2FShow%20S01'));
    expect(screen.queryByTestId('player')).toBeNull();
  });

  it('a non-video file opens the explorer at its folder with the file selected', async () => {
    vi.mocked(api.checkVideoFile).mockResolvedValue({ exists: true, kind: 'file', path: '/dl/notes.pdf', parent: '/dl' });
    renderItem(makeDownload({ status: 'done', file: 'notes.pdf' }));
    fireEvent.click(screen.getByTitle('Show in Files'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/files?path=%2Fdl&select=%2Fdl%2Fnotes.pdf'));
  });

  it('a missing file marks the row as not found, and a re-check can restore it', async () => {
    vi.mocked(api.checkVideoFile).mockResolvedValueOnce({ exists: false }).mockResolvedValueOnce({ exists: true, kind: 'video', path: '/dl/clip.mkv' });
    renderItem(makeDownload({ status: 'done', file: 'clip.mkv' }));
    fireEvent.click(screen.getByTitle('Play video'));
    const again = await screen.findByTitle('Not found - click to re-check');
    expect(again).toHaveClass('bg-slate-700/30');
    fireEvent.click(again);
    expect(await screen.findByTestId('player')).toBeInTheDocument();
    expect(screen.getByTitle('Play video')).toHaveClass('bg-cyan-500/20');
  });

  it('starts out greyed when the record already says the file is gone', () => {
    renderItem(makeDownload({ status: 'done', file: 'clip.mkv', file_deleted: true }));
    expect(screen.getByTitle('Not found - click to re-check')).toBeInTheDocument();
  });

  it('a failed check is logged and the button re-enabled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.checkVideoFile).mockRejectedValue(new Error('offline'));
    renderItem(makeDownload({ status: 'done', file: 'clip.mkv' }));
    const button = screen.getByTitle('Play video');
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(error).toHaveBeenCalledWith('Failed to check download file:', expect.any(Error));
    expect(screen.queryByTestId('player')).toBeNull();
  });
});

describe('DownloadItem - thumbnails', () => {
  // alt="" makes the preview images presentational, so no img role to query
  const previewImgs = () => Array.from(document.querySelectorAll('img.object-contain'));
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses one of the thumbnails as a background and none when there are none', () => {
    const { container, rerender } = renderItem(makeDownload({ id: 4, thumb_count: 2 }));
    const bg = container.querySelector('.bg-cover') as HTMLElement;
    expect(bg.style.backgroundImage).toMatch(/\/thumbs\/4\/[12]\.jpg/);
    rerender(<DownloadItem download={makeDownload({ id: 4, thumb_count: 0 })} onRetry={() => {}} onStop={() => {}} onPause={() => {}} onResume={() => {}} onDelete={() => {}} />);
    expect(container.querySelector('.bg-cover')).toBeNull();
  });

  it('hovering half a second opens the preview; arrows and the carousel move through it; leaving closes it', () => {
    const { container } = renderItem(makeDownload({ id: 4, thumb_count: 3 }));
    const item = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(item);
    act(() => { vi.advanceTimersByTime(499); });
    expect(previewImgs()).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(1); });
    const imgs = previewImgs();
    expect(imgs).toHaveLength(3);
    expect(imgs[0]).toHaveClass('opacity-100');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(imgs[1]).toHaveClass('opacity-100');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(imgs[2]).toHaveClass('opacity-100');
    act(() => { vi.advanceTimersByTime(3000); });   // carousel wraps
    expect(imgs[0]).toHaveClass('opacity-100');
    fireEvent.mouseLeave(item);
    act(() => { vi.advanceTimersByTime(100); });
    expect(previewImgs()).toHaveLength(0);
  });

  it('leaving and coming back before the hide delay keeps it open; a click closes it', () => {
    const { container } = renderItem(makeDownload({ id: 4, thumb_count: 2 }));
    const item = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(item);
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.mouseLeave(item);
    fireEvent.mouseEnter(item);
    act(() => { vi.advanceTimersByTime(600); });
    expect(previewImgs()).toHaveLength(2);
    fireEvent.click(item);
    expect(previewImgs()).toHaveLength(0);
    // Leaving before the half second cancels the open
    fireEvent.mouseEnter(item);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.mouseLeave(item);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(previewImgs()).toHaveLength(0);
  });

  it('on a phone the image button toggles the preview and a horizontal swipe moves through it', () => {
    renderItem(makeDownload({ id: 4, thumb_count: 2 }));
    const toggle = document.querySelector('button.bg-purple-500\\/20') as HTMLButtonElement;
    fireEvent.click(toggle);
    const imgs = previewImgs();
    expect(imgs[0]).toHaveClass('opacity-100');
    const sheet = imgs[0].parentElement!.parentElement!;
    fireEvent.touchStart(sheet, { touches: [{ clientX: 200, clientY: 10 }] });
    fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 100, clientY: 12 }] });
    expect(imgs[1]).toHaveClass('opacity-100');
    fireEvent.touchStart(sheet, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 200, clientY: 12 }] });
    expect(imgs[0]).toHaveClass('opacity-100');
    // A vertical scroll or a tiny move is not a swipe
    fireEvent.touchStart(sheet, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 140, clientY: 200 }] });
    expect(imgs[0]).toHaveClass('opacity-100');
    fireEvent.click(document.querySelector('button.bg-purple-500\\/30')!);
    expect(previewImgs()).toHaveLength(0);
  });

  it('no thumbnails: hovering never opens anything', () => {
    const { container } = renderItem(makeDownload({ thumb_count: 0 }));
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(previewImgs()).toHaveLength(0);
  });
});

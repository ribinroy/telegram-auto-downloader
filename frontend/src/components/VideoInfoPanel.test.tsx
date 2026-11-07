import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import * as mediaInfo from '../api/mediaInfo';
import { subscribeNotifications } from '../lib/notify';
import { renderWithClient } from '../test/queryWrapper';
import { VideoInfoPanel } from './VideoInfoPanel';

vi.mock('../api/mediaInfo', () => ({ fetchMediaInfo: vi.fn() }));

const INFO: mediaInfo.MediaInfo = {
  file: { name: 'Film.mkv', path: '/m/Film.mkv', size: 1024, modified: null },
  container: { format: 'matroska', format_long: 'Matroska / WebM', duration: 125, bitrate: 1_000_000, tags: {} },
  streams: [
    { index: 0, type: 'video', codec: 'hevc', codec_long: null, profile: null, language: null, title: null, default: true, forced: false, bitrate: null, width: 3840, height: 2160 },
    { index: 1, type: 'audio', codec: 'aac', codec_long: null, profile: null, language: 'eng', title: null, default: true, forced: false, bitrate: null, channels: 2 },
    { index: 2, type: 'subtitle', codec: 'subrip', codec_long: null, profile: null, language: 'ger', title: null, default: false, forced: true, bitrate: null },
    { index: 3, type: 'attachment', codec: 'ttf', codec_long: null, profile: null, language: null, title: null, default: false, forced: false, bitrate: null },
    { index: 4, type: 'attachment', codec: 'ttf', codec_long: null, profile: null, language: null, title: null, default: false, forced: false, bitrate: null },
  ],
  chapters: [{ start: 0, end: 60, title: 'Opening' }, { start: 60, end: 125, title: null }],
};

beforeEach(() => vi.resetAllMocks());

describe('VideoInfoPanel', () => {
  it('reads the file, then lists the file, every stream and the chapters', async () => {
    vi.mocked(mediaInfo.fetchMediaInfo).mockResolvedValue(INFO);
    renderWithClient(<VideoInfoPanel source={{ downloadId: 4 }} name="Film.mkv" onClose={vi.fn()} />);
    expect(screen.getByText('Reading the file…')).toBeInTheDocument();
    expect(await screen.findByText('4K · HEVC · 2:05 · 1.00 KB')).toBeInTheDocument();
    expect(mediaInfo.fetchMediaInfo).toHaveBeenCalledWith({ downloadId: 4 });

    expect(screen.getByText('File')).toBeInTheDocument();
    expect(screen.getByText('Matroska / WebM')).toBeInTheDocument();
    // Attachments are counted, not given a section each
    expect(screen.getByText('2 (fonts, cover art)')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { name: /Attachment/ })).toHaveLength(0);
    expect(screen.getByText('Video · Default')).toBeInTheDocument();
    expect(screen.getByText('3840 × 2160 (4K)')).toBeInTheDocument();
    expect(screen.getByText('Audio · Default')).toBeInTheDocument();
    expect(screen.getByText('Stereo')).toBeInTheDocument();
    expect(screen.getByText('Subtitle · Forced')).toBeInTheDocument();
    expect(screen.getByText('Chapters (2)')).toBeInTheDocument();
    expect(screen.getByText('Opening')).toBeInTheDocument();
    expect(screen.getByText('Chapter 2')).toBeInTheDocument();
  });

  it('a failed read is a toast, and the panel says so itself', async () => {
    const seen: string[] = [];
    const off = subscribeNotifications(ts => { for (const t of ts) seen.push(t.title); });
    vi.mocked(mediaInfo.fetchMediaInfo).mockRejectedValue(new Error('Not a media file ffprobe can read'));
    renderWithClient(<VideoInfoPanel source={{ path: '/x.mp4' }} name="x.mp4" onClose={vi.fn()} />);
    expect(await screen.findByText('Couldn’t read this file’s details.', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('x.mp4')).toBeInTheDocument();      // the name it was opened with
    await waitFor(() => expect(seen).toContain('Couldn’t load video details'));
    off();
  });

  it('Escape closes it before anything else hears the key; the backdrop closes, the card does not', async () => {
    vi.mocked(mediaInfo.fetchMediaInfo).mockResolvedValue(INFO);
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    renderWithClient(<VideoInfoPanel source={{ downloadId: 4 }} name="Film.mkv" onClose={onClose} />);
    await screen.findByText('File');
    expect(screen.getByLabelText('Close details')).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();         // the player modal's own Escape stays out of it
    fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText('Close details'));
    expect(onClose).toHaveBeenCalledTimes(3);
    document.removeEventListener('keydown', outer);
  });
});

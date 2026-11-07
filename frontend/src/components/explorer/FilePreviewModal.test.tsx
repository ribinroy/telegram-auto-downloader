import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import * as api from '../../api';
import * as files from '../../api/files';
import { renderWithClient } from '../../test/queryWrapper';
import { FilePreviewModal } from './FilePreviewModal';

// The player is its own component with its own tests; here it only has to
// report what it was handed.
vi.mock('../VideoPlayer', () => ({
  VideoPlayer: ({ src, name, subtitles, onError }: { src: string; name: string; subtitles?: { path?: string }; onError?: () => void }) =>
    <div data-testid="video-player" data-src={src} data-name={name} data-sub={subtitles?.path}><button onClick={onError}>fail</button></div>,
}));
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof api>()), ensureMediaToken: vi.fn() }));
vi.mock('../../api/files', async (orig) => ({ ...(await orig<typeof files>()), readTextFile: vi.fn() }));

const entry = (name: string, over: Partial<files.FileEntry> = {}): files.FileEntry => {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const kind: files.FileKind = ({ mp4: 'video', jpg: 'image', mp3: 'audio', txt: 'text', pdf: 'document' } as Record<string, files.FileKind>)[ext] ?? 'file';
  return { name, path: `/d/${name}`, is_dir: false, is_link: false, broken: false, hidden: false, size: 2048, modified: null, mode: null, kind, ext, ...over };
};

const siblings = [entry('a.jpg'), entry('b.mp4'), entry('c.txt')];

function renderModal(e: files.FileEntry, list = siblings) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const view = renderWithClient(<FilePreviewModal entry={e} siblings={list} onClose={onClose} onNavigate={onNavigate} />);
  return { ...view, onClose, onNavigate };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.ensureMediaToken).mockResolvedValue('tok');
});

describe('FilePreviewModal - frame', () => {
  it('names the file, its size and path, and links to a download of it', () => {
    renderModal(entry('a.jpg'));
    expect(screen.getByRole('heading', { name: 'a.jpg' })).toHaveAttribute('title', '/d/a.jpg');
    expect(screen.getByText('2.00 KB · /d/a.jpg')).toBeInTheDocument();
    const link = screen.getByTitle('Download to this device');
    expect(link).toHaveAttribute('href', expect.stringContaining('/api/files/download?path=%2Fd%2Fa.jpg'));
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes from the button, the backdrop and Escape, and restores scrolling', () => {
    const { onClose, unmount } = renderModal(entry('a.jpg'));
    fireEvent.click(screen.getByRole('heading', { name: 'a.jpg' }).closest('.relative')!.querySelector('button')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('.bg-black\\/90')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
    unmount();
    expect(document.body.style.overflow).toBe('');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('FilePreviewModal - paging through the folder', () => {
  it('offers previous/next buttons titled with the neighbours and pages with the arrow keys', () => {
    const { onNavigate } = renderModal(entry('b.mp4'));
    fireEvent.click(screen.getByTitle('a.jpg'));
    expect(onNavigate).toHaveBeenLastCalledWith(siblings[0]);
    fireEvent.click(screen.getByTitle('c.txt'));
    expect(onNavigate).toHaveBeenLastCalledWith(siblings[2]);
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(onNavigate).toHaveBeenLastCalledWith(siblings[0]);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onNavigate).toHaveBeenLastCalledWith(siblings[2]);
    expect(onNavigate).toHaveBeenCalledTimes(4);
  });

  it('has no previous at the start and no next at the end; the keys do nothing there', () => {
    const { onNavigate, unmount } = renderModal(entry('a.jpg'));
    expect(screen.queryByTitle('b.mp4')).not.toBeNull();
    expect(screen.queryByTitle('c.txt')).toBeNull();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(onNavigate).not.toHaveBeenCalled();
    unmount();
    const { onNavigate: nav2 } = renderModal(entry('c.txt'));
    expect(screen.queryByTitle('b.mp4')).not.toBeNull();
    expect(screen.queryByTitle('a.jpg')).toBeNull();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(nav2).not.toHaveBeenCalled();
  });

  it('an entry not in the sibling list has no paging at all', () => {
    const { onNavigate } = renderModal(entry('zzz.jpg'));
    expect(screen.queryByTitle('a.jpg')).toBeNull();
    expect(screen.queryByTitle('c.txt')).toBeNull();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('FilePreviewModal - bodies by kind', () => {
  it('a video goes to the shared player with its subtitles source', () => {
    renderModal(entry('b.mp4'));
    const player = screen.getByTestId('video-player');
    expect(player).toHaveAttribute('data-src', expect.stringContaining('/api/files/stream?path=%2Fd%2Fb.mp4'));
    expect(player).toHaveAttribute('data-name', 'b.mp4');
    expect(player).toHaveAttribute('data-sub', '/d/b.mp4');
    // A video brings its own box, so the generic black frame is not drawn
    expect(player.parentElement).toHaveClass('relative');
    expect(player.parentElement).not.toHaveClass('bg-black');
  });

  it('an image is an <img>, audio an <audio>, a pdf an <iframe>', () => {
    const { unmount } = renderModal(entry('a.jpg'));
    const img = screen.getByAltText('a.jpg');
    expect(img).toHaveAttribute('src', expect.stringContaining('/api/files/stream?path=%2Fd%2Fa.jpg'));
    expect(img.parentElement).toHaveClass('bg-black');
    unmount();
    renderModal(entry('s.mp3'));
    const audio = document.querySelector('audio')!;
    expect(audio).toHaveAttribute('src', expect.stringContaining('%2Fd%2Fs.mp3'));
    expect(audio).toHaveAttribute('controls');
    renderModal(entry('doc.pdf'));
    expect(screen.getByTitle('doc.pdf')).toHaveAttribute('src', expect.stringContaining('%2Fd%2Fdoc.pdf'));
  });

  it('anything else says so and offers the download instead', () => {
    renderModal(entry('archive.rar'));
    expect(screen.getByText('No preview for .rar')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download it instead' }))
      .toHaveAttribute('href', expect.stringContaining('/api/files/download?path=%2Fd%2Farchive.rar'));
    renderModal(entry('Makefile'));
    expect(screen.getByText('No preview for .this file type')).toBeInTheDocument();
  });

  it('a text file is read through the API: spinner, then the text, with a note when truncated', async () => {
    vi.mocked(files.readTextFile).mockResolvedValue({ path: '/d/c.txt', text: 'hello world', truncated: true, size: 5000 });
    renderModal(entry('c.txt'));
    expect(document.querySelector('.animate-spin')).not.toBeNull();
    expect(await screen.findByText('hello world')).toBeInTheDocument();
    expect(files.readTextFile).toHaveBeenCalledWith('/d/c.txt');
    expect(screen.getByText('Preview truncated - showing the first 11.00 B of 4.88 KB.')).toBeInTheDocument();
  });

  it('a text file that cannot be read shows the reason', async () => {
    vi.mocked(files.readTextFile).mockRejectedValue(new Error('Permission denied'));
    renderModal(entry('c.txt'));
    expect(await screen.findByText('Permission denied')).toBeInTheDocument();
  });
});

describe('FilePreviewModal - media token retry', () => {
  it('a failed load mints a fresh media token and reloads the element once', async () => {
    renderModal(entry('a.jpg'));
    const first = screen.getByAltText('a.jpg');
    fireEvent.error(first);
    expect(api.ensureMediaToken).toHaveBeenCalledWith(true);
    // The element is keyed on the attempt, so a new one is mounted
    await waitFor(() => expect(screen.getByAltText('a.jpg')).not.toBe(first));
    fireEvent.error(screen.getByAltText('a.jpg'));
    expect(api.ensureMediaToken).toHaveBeenCalledTimes(1);
  });

  it('the video player reports errors the same way', async () => {
    renderModal(entry('b.mp4'));
    fireEvent.click(screen.getByRole('button', { name: 'fail' }));
    await waitFor(() => expect(api.ensureMediaToken).toHaveBeenCalledWith(true));
  });

  it('moving to another file gets a fresh retry', async () => {
    const { rerender, onClose, onNavigate } = renderModal(entry('a.jpg'));
    fireEvent.error(screen.getByAltText('a.jpg'));
    await waitFor(() => expect(api.ensureMediaToken).toHaveBeenCalledTimes(1));
    rerender(<FilePreviewModal entry={entry('z.jpg')} siblings={siblings} onClose={onClose} onNavigate={onNavigate} />);
    fireEvent.error(screen.getByAltText('z.jpg'));
    await waitFor(() => expect(api.ensureMediaToken).toHaveBeenCalledTimes(2));
  });
});

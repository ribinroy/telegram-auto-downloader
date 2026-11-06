import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VideoPlayerModal } from './VideoPlayerModal';

// The player itself has its own tests; here it only has to show up with the
// right inputs.
vi.mock('./VideoPlayer', () => ({
  VideoPlayer: ({ src, name, subtitles }: { src: string; name: string; subtitles?: unknown }) =>
    <div data-testid="player" data-src={src} data-name={name} data-subs={JSON.stringify(subtitles ?? null)} />,
}));

afterEach(() => { delete (document as { fullscreenElement?: Element | null }).fullscreenElement; });

describe('VideoPlayerModal', () => {
  it('renders nothing while closed and leaves the page scrollable', () => {
    render(<VideoPlayerModal isOpen={false} onClose={() => {}} videoUrl="/v" title="Clip" />);
    expect(screen.queryByText('Clip')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('shows the title, mounts the player with its inputs and locks page scroll until closed', () => {
    const { unmount } = render(<VideoPlayerModal isOpen onClose={() => {}} videoUrl="/v.mp4" title="Clip.mkv" subtitles={{ downloadId: 3 }} />);
    expect(screen.getByRole('heading', { name: 'Clip.mkv' })).toBeInTheDocument();
    const player = screen.getByTestId('player');
    expect(player).toHaveAttribute('data-src', '/v.mp4');
    expect(player).toHaveAttribute('data-name', 'Clip.mkv');
    expect(player).toHaveAttribute('data-subs', '{"downloadId":3}');
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on the X button, the backdrop and Escape', () => {
    const onClose = vi.fn();
    render(<VideoPlayerModal isOpen onClose={onClose} videoUrl="/v" title="Clip" />);
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('.backdrop-blur-sm')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('lets Escape leave fullscreen first; only the next one closes', () => {
    const onClose = vi.fn();
    render(<VideoPlayerModal isOpen onClose={onClose} videoUrl="/v" title="Clip" />);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.body });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

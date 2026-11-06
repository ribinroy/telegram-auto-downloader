import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import * as subtitles from '../api/subtitles';
import * as vr from '../api/vr';
import { renderWithClient } from '../test/queryWrapper';
import { VideoPlayer } from './VideoPlayer';

// jsdom cannot decode video; the three.js renderer is replaced by a stub that
// only reports what it was handed. Nothing here asserts on playback.
vi.mock('./VRVideoPlayer', () => ({
  VRVideoPlayer: ({ projection, subtitle }: { projection: string; subtitle: string }) =>
    <div data-testid="vr-player" data-projection={projection} data-subtitle={subtitle} />,
}));
vi.mock('../api/subtitles', async (orig) => ({
  ...(await orig<typeof subtitles>()),
  listSubtitleTracks: vi.fn(),
  getSubtitleUrl: (_s: unknown, id: string) => `/sub/${id}`,
}));
vi.mock('../api/vr', () => ({ fetchDownloadProjection: vi.fn(), saveDownloadProjection: vi.fn() }));

// jsdom's textTracks list is always empty, so stand in a TextTrack per
// <track> element - stable per element, so a mode set in one effect run is
// what the next one reads.
interface FakeTrack { id: string; mode: string; activeCues: { text: string }[]; listeners: Set<() => void>; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void }
const fakeTracks = new WeakMap<Element, FakeTrack>();
const trackOf = (el: Element): FakeTrack => {
  let t = fakeTracks.get(el);
  if (!t) {
    t = {
      id: el.id, mode: 'disabled', activeCues: [], listeners: new Set(),
      addEventListener: (_e, f) => { t!.listeners.add(f); },
      removeEventListener: (_e, f) => { t!.listeners.delete(f); },
    };
    fakeTracks.set(el, t);
  }
  return t;
};
const textTracksDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'textTracks')!;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(subtitles.listSubtitleTracks).mockResolvedValue([]);
  vi.mocked(vr.fetchDownloadProjection).mockResolvedValue({ projection: null, detected: 'flat', lens: null });
  vi.mocked(vr.saveDownloadProjection).mockResolvedValue({ projection: null });
  Object.defineProperty(HTMLMediaElement.prototype, 'textTracks', {
    configurable: true,
    get(this: HTMLMediaElement) { return Array.from(this.querySelectorAll('track')).map(trackOf); },
  });
});
afterEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, 'textTracks', textTracksDesc);
  delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
});

const enableFullscreen = () => {
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  const request = vi.fn().mockResolvedValue(undefined);
  const exit = vi.fn().mockResolvedValue(undefined);
  Element.prototype.requestFullscreen = request;
  document.exitFullscreen = exit;
  return { request, exit };
};

const projectionSelect = () => screen.getByRole('combobox', { name: 'View' }) as HTMLSelectElement;

describe('VideoPlayer - view picker', () => {
  it('shows a flat video with native controls and no VR renderer', () => {
    renderWithClient(<VideoPlayer src="/v.mp4" name="holiday.mp4" />);
    const video = document.querySelector('video')!;
    expect(video).toHaveAttribute('src', '/v.mp4');
    expect(video).toHaveAttribute('controls');
    expect(video).not.toHaveClass('hidden');
    expect(projectionSelect().value).toBe('flat');
    expect(screen.queryByTestId('vr-player')).toBeNull();
    // Nothing is marked auto when the guess is flat
    expect(screen.getByRole('option', { name: 'Flat' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /· auto/ })).toBeNull();
  });

  it('guesses VR from the filename, marks that option "· auto" and hands the video to the VR renderer', async () => {
    renderWithClient(<VideoPlayer src="/v.mp4" name="trip_180_sbs.mp4" />);
    expect(projectionSelect().value).toBe('180-sbs');
    expect(screen.getByRole('option', { name: '180° side by side · auto' })).toBeInTheDocument();
    expect(document.querySelector('video')).toHaveClass('hidden');
    expect(document.querySelector('video')).not.toHaveAttribute('controls');
    const stub = await screen.findByTestId('vr-player');
    expect(stub).toHaveAttribute('data-projection', '180-sbs');
    expect(screen.getByTitle('View (guessed from the filename)')).toBeInTheDocument();
  });

  it('a manual pick is remembered for the file; picking the guess again forgets it', async () => {
    renderWithClient(<VideoPlayer src="/v.mp4" name="trip_180_sbs.mp4" />);
    fireEvent.change(projectionSelect(), { target: { value: '360-mono' } });
    expect(projectionSelect().value).toBe('360-mono');
    expect(localStorage.getItem('downlee:projection:trip_180_sbs.mp4')).toBe('360-mono');
    expect(screen.getByTitle('View (chosen for this file)')).toBeInTheDocument();
    expect(await screen.findByTestId('vr-player')).toHaveAttribute('data-projection', '360-mono');

    fireEvent.change(projectionSelect(), { target: { value: '180-sbs' } });
    expect(localStorage.getItem('downlee:projection:trip_180_sbs.mp4')).toBeNull();
    expect(screen.getByTitle('View (guessed from the filename)')).toBeInTheDocument();
  });

  it('starts from the remembered pick', () => {
    localStorage.setItem('downlee:projection:plain.mp4', '180-tb');
    renderWithClient(<VideoPlayer src="/v.mp4" name="plain.mp4" />);
    expect(projectionSelect().value).toBe('180-tb');
  });

  it('for a download, the pick is saved on the server too and the server\'s pick is used', async () => {
    vi.mocked(vr.fetchDownloadProjection).mockResolvedValue({ projection: '360-sbs', detected: 'flat', lens: null });
    renderWithClient(<VideoPlayer src="/v.mp4" name="plain.mp4" subtitles={{ downloadId: 9 }} />);
    await waitFor(() => expect(projectionSelect().value).toBe('360-sbs'));
    expect(vr.fetchDownloadProjection).toHaveBeenCalledWith(9);

    fireEvent.change(projectionSelect(), { target: { value: '180-mono' } });
    await waitFor(() => expect(vr.saveDownloadProjection).toHaveBeenCalledWith(9, '180-mono'));
    fireEvent.change(projectionSelect(), { target: { value: 'flat' } });
    // 'flat' is the guess, so the pick is cleared rather than stored
    await waitFor(() => expect(vr.saveDownloadProjection).toHaveBeenLastCalledWith(9, null));
  });

  it('a new file resets the pick', () => {
    localStorage.setItem('downlee:projection:a.mp4', '180-tb');
    const { rerender } = renderWithClient(<VideoPlayer src="/a.mp4" name="a.mp4" />);
    expect(projectionSelect().value).toBe('180-tb');
    rerender(<VideoPlayer src="/b.mp4" name="b.mp4" />);
    expect(projectionSelect().value).toBe('flat');
  });
});

describe('VideoPlayer - custom player', () => {
  const toggle = () => screen.getByRole('button', { name: 'Custom player' });

  it('is off by default; switching it on hands a flat video to the renderer as a plane and remembers it', async () => {
    renderWithClient(<VideoPlayer src="/v.mp4" name="holiday.mp4" />);
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('downlee:player:custom')).toBe('1');
    const video = document.querySelector('video')!;
    expect(video).toHaveClass('hidden');
    expect(video).not.toHaveAttribute('controls');
    expect(await screen.findByTestId('vr-player')).toHaveAttribute('data-projection', 'flat');
    // The view picker still says flat - the custom player is not a projection
    expect(projectionSelect().value).toBe('flat');

    fireEvent.click(toggle());
    expect(localStorage.getItem('downlee:player:custom')).toBeNull();
    expect(video).not.toHaveClass('hidden');
    expect(video).toHaveAttribute('controls');
    expect(screen.queryByTestId('vr-player')).toBeNull();
  });

  it('starts in the custom player when that was chosen before, for every file', async () => {
    localStorage.setItem('downlee:player:custom', '1');
    const { rerender } = renderWithClient(<VideoPlayer src="/a.mp4" name="a.mp4" />);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByTestId('vr-player')).toHaveAttribute('data-projection', 'flat');
    rerender(<VideoPlayer src="/b.mp4" name="b_180_sbs.mp4" />);
    expect(await screen.findByTestId('vr-player')).toHaveAttribute('data-projection', '180-sbs');
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  });

  it('a VR file is unaffected by the toggle - the renderer draws it either way', async () => {
    renderWithClient(<VideoPlayer src="/v.mp4" name="trip_360.mp4" />);
    expect(await screen.findByTestId('vr-player')).toHaveAttribute('data-projection', '360-mono');
    fireEvent.click(toggle());
    expect(screen.getByTestId('vr-player')).toHaveAttribute('data-projection', '360-mono');
    expect(document.querySelector('video')).toHaveClass('hidden');
  });

  it('with the custom player on, subtitles go to the renderer rather than the hidden <video>', async () => {
    localStorage.setItem('downlee:player:custom', '1');
    vi.mocked(subtitles.listSubtitleTracks).mockResolvedValue([
      { id: 't1', label: 'English', lang: 'en', kind: 'sidecar', format: 'srt', forced: false, default: false },
    ]);
    renderWithClient(<VideoPlayer src="/v.mp4" name="a.mp4" subtitles={{ path: '/x/a.mp4' }} />);
    const select = await screen.findByRole('combobox', { name: 'Subtitles' });
    fireEvent.change(select, { target: { value: 't1' } });
    const track = trackOf(document.querySelector('track#sub-t1')!);
    await waitFor(() => expect(track.mode).toBe('hidden'));
    track.activeCues = [{ text: 'Hi' }];
    act(() => { track.listeners.forEach(f => f()); });
    expect(await screen.findByTestId('vr-player')).toHaveAttribute('data-subtitle', 'Hi');
  });
});

describe('VideoPlayer - subtitles', () => {
  const tracks: subtitles.SubtitleTrack[] = [
    { id: 't1', label: 'English', lang: 'en', kind: 'sidecar', format: 'srt', forced: false, default: false },
    { id: 't2', label: 'Deutsch', lang: 'de', kind: 'embedded', format: 'ass', forced: false, default: false },
  ];

  it('offers no subtitle picker without tracks, nor without a source', async () => {
    renderWithClient(<VideoPlayer src="/v.mp4" name="a.mp4" />);
    expect(screen.queryByRole('combobox', { name: 'Subtitles' })).toBeNull();
    expect(subtitles.listSubtitleTracks).not.toHaveBeenCalled();
    renderWithClient(<VideoPlayer src="/v.mp4" name="a.mp4" subtitles={{ path: '/x/a.mp4' }} />);
    await waitFor(() => expect(subtitles.listSubtitleTracks).toHaveBeenCalledWith({ path: '/x/a.mp4' }));
    expect(screen.queryByRole('combobox', { name: 'Subtitles' })).toBeNull();
  });

  it('lists the tracks (sidecars with their format), renders <track> elements and switches the chosen one on', async () => {
    vi.mocked(subtitles.listSubtitleTracks).mockResolvedValue(tracks);
    renderWithClient(<VideoPlayer src="/v.mp4" name="a.mp4" subtitles={{ path: '/x/a.mp4' }} />);
    const select = await screen.findByRole('combobox', { name: 'Subtitles' }) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: 'Off' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'English (.srt)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Deutsch' })).toBeInTheDocument();

    const els = document.querySelectorAll('track');
    expect(Array.from(els).map(t => t.id)).toEqual(['sub-t1', 'sub-t2']);
    expect(els[0]).toHaveAttribute('src', '/sub/t1');
    expect(els[0]).toHaveAttribute('srclang', 'en');
    await waitFor(() => expect(trackOf(els[0]).mode).toBe('disabled'));

    fireEvent.change(select, { target: { value: 't2' } });
    await waitFor(() => expect(trackOf(els[1]).mode).toBe('showing'));
    expect(trackOf(els[0]).mode).toBe('disabled');
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(trackOf(els[1]).mode).toBe('disabled'));
  });

  it('in VR the track is hidden (not painted) and its cues go to the renderer', async () => {
    vi.mocked(subtitles.listSubtitleTracks).mockResolvedValue(tracks);
    renderWithClient(<VideoPlayer src="/v.mp4" name="a_180_sbs.mp4" subtitles={{ path: '/x/a.mp4' }} />);
    const select = await screen.findByRole('combobox', { name: 'Subtitles' });
    fireEvent.change(select, { target: { value: 't1' } });
    const track = trackOf(document.querySelector('track#sub-t1')!);
    await waitFor(() => expect(track.mode).toBe('hidden'));

    track.activeCues = [{ text: 'Hello' }, { text: 'there' }];
    act(() => { track.listeners.forEach(f => f()); });
    expect(await screen.findByTestId('vr-player')).toHaveAttribute('data-subtitle', 'Hello\nthere');

    // Switching tracks drops the old track's line at once
    fireEvent.change(select, { target: { value: 't2' } });
    await waitFor(() => expect(screen.getByTestId('vr-player')).toHaveAttribute('data-subtitle', ''));
  });
});

describe('VideoPlayer - fullscreen', () => {
  it('has no fullscreen button where the browser does not allow it', () => {
    renderWithClient(<VideoPlayer src="/v.mp4" name="a.mp4" />);
    expect(screen.queryByRole('button', { name: /fullscreen/i })).toBeNull();
    fireEvent.keyDown(window, { key: 'f' });
    expect(Element.prototype.requestFullscreen).toBeUndefined();
  });

  it('the button and the F key both toggle fullscreen on the whole player', async () => {
    const { request, exit } = enableFullscreen();
    renderWithClient(<VideoPlayer src="/v.mp4" name="a.mp4" />);
    const button = screen.getByRole('button', { name: 'Fullscreen' });
    fireEvent.click(button);
    expect(request).toHaveBeenCalledTimes(1);
    const wrap = request.mock.instances[0] as Element;
    expect(wrap.contains(document.querySelector('video'))).toBe(true);
    expect(wrap.contains(button)).toBe(true);   // toolbar included

    fireEvent.keyDown(window, { key: 'F' });
    expect(request).toHaveBeenCalledTimes(2);

    // The browser reports we are in; the button flips to exit and F now exits
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => wrap });
    fireEvent(document, new Event('fullscreenchange'));
    await screen.findByRole('button', { name: 'Exit fullscreen' });
    expect(screen.getByTitle('Exit fullscreen (F)')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'f' });
    expect(exit).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    fireEvent(document, new Event('fullscreenchange'));
    await screen.findByRole('button', { name: 'Fullscreen' });
  });

  it('ignores F typed into a form field', () => {
    const { request } = enableFullscreen();
    renderWithClient(<><input aria-label="search" /><VideoPlayer src="/v.mp4" name="a.mp4" /></>);
    fireEvent.keyDown(screen.getByLabelText('search'), { key: 'f' });
    fireEvent.keyDown(projectionSelect(), { key: 'f' });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('VideoPlayer - misc', () => {
  it('passes video errors up and renders extra controls in the toolbar', () => {
    const onError = vi.fn();
    renderWithClient(<VideoPlayer src="/v.mp4" name="a.mp4" onError={onError} autoPlay={false} extraControls={<button>Download</button>} />);
    const video = document.querySelector('video')!;
    expect(video).not.toHaveAttribute('autoplay');
    fireEvent.error(video);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  it('uses the decoded aspect ratio to settle the stereo layout', async () => {
    // "VR" alone says 180° side by side; a 1:2 frame (two 1:1 eyes stacked) can only be top/bottom
    renderWithClient(<VideoPlayer src="/v.mp4" name="scene_vr.mp4" />);
    expect(projectionSelect().value).toBe('180-sbs');
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 2048 });
    Object.defineProperty(video, 'videoHeight', { value: 4096 });
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(projectionSelect().value).toBe('180-tb'));
  });
});

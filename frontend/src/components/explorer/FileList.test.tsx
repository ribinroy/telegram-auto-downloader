import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import * as files from '../../api/files';
import { FileList } from './FileList';

vi.mock('../../api/files', async (orig) => ({
  ...(await orig<typeof files>()),
  warmThumbs: vi.fn(), thumbStatus: vi.fn(),
}));
// Locale data is registered by main.tsx; the relative date is not under test.
vi.mock('react-time-ago', () => ({ default: ({ date }: { date: Date }) => <time dateTime={date.toISOString()}>ago</time> }));

type Props = Parameters<typeof FileList>[0];

const entry = (name: string, over: Partial<files.FileEntry> = {}): files.FileEntry => {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const kind: files.FileKind = over.is_dir ? 'folder'
    : ({ mp4: 'video', jpg: 'image', mp3: 'audio', txt: 'text', zip: 'archive' } as Record<string, files.FileKind>)[ext] ?? 'file';
  return {
    name, path: `/d/${name}`, is_dir: false, is_link: false, broken: false, hidden: false,
    size: 1024, modified: '2026-01-01T00:00:00Z', mode: null, kind, ext, ...over,
  };
};

const ENTRIES = [entry('Docs', { is_dir: true, size: 0 }), entry('clip.mp4', { size: 2048 }), entry('photo.jpg'), entry('notes.txt', { modified: null })];

function renderList(over: Partial<Props> = {}) {
  const props: Props = {
    entries: ENTRIES, selected: new Set(), view: 'list', sortKey: 'name', sortAsc: true, renaming: null,
    onSort: vi.fn(), onActivate: vi.fn(), onLongPress: vi.fn(), onContext: vi.fn(), onRename: vi.fn(), onRenameCancel: vi.fn(),
    ...over,
  };
  const view = render(<FileList {...props} />);
  return { ...view, props };
}

const row = (name: string) => document.querySelector(`[data-path="/d/${name}"]`) as HTMLElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(files.warmThumbs).mockResolvedValue({ queued: 0, cached: 0, skipped: 0 });
  vi.mocked(files.thumbStatus).mockResolvedValue({ states: {} });
});

describe('FileList - list view', () => {
  it('renders a row per entry with size, link marker and the search-result path', () => {
    renderList({ entries: [...ENTRIES, entry('ln', { is_link: true, broken: true })], showPath: true });
    expect(within(row('Docs')).getByText('--')).toBeInTheDocument();
    expect(within(row('clip.mp4')).getByText('2.00 KB')).toBeInTheDocument();
    expect(within(row('clip.mp4')).getByText('/d/clip.mp4')).toBeInTheDocument();
    expect(within(row('notes.txt')).getAllByText('--')).toHaveLength(1);   // no modified date
    expect(row('ln').querySelector('svg')).toHaveClass('text-red-400');    // broken link icon
    expect(row('ln').querySelectorAll('svg')).toHaveLength(3);             // kind, link marker, ⋮
    expect(row('clip.mp4').querySelectorAll('svg')).toHaveLength(2);
  });

  it('marks selected and hidden rows', () => {
    renderList({ entries: [entry('.secret', { hidden: true }), entry('a')], selected: new Set(['/d/a']) });
    expect(row('a')).toHaveClass('bg-cyan-500/15');
    expect(row('.secret')).not.toHaveClass('bg-cyan-500/15');
    expect(within(row('.secret')).getByText('.secret')).toHaveClass('text-slate-500');
    expect(within(row('a')).getByText('a')).toHaveClass('text-white');
  });

  it('the column headers sort, and the active one carries the direction arrow', () => {
    const { props, rerender } = renderList({ sortKey: 'size', sortAsc: false });
    fireEvent.click(screen.getByRole('button', { name: 'Modified' }));
    expect(props.onSort).toHaveBeenCalledWith('modified');
    expect(screen.getByRole('button', { name: 'Size' })).toHaveClass('text-white');
    expect(screen.getByRole('button', { name: 'Size' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Name' }).querySelector('svg')).toBeNull();
    rerender(<FileList {...props} sortKey="name" sortAsc />);
    expect(screen.getByRole('button', { name: 'Name' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Size' }).querySelector('svg')).toBeNull();
  });

  it('a right-click and the ⋮ button both open the context menu at the pointer', () => {
    const { props } = renderList();
    fireEvent.contextMenu(row('Docs'), { clientX: 11, clientY: 22 });
    expect(props.onContext).toHaveBeenCalledWith(ENTRIES[0], 11, 22);
    fireEvent.click(within(row('clip.mp4')).getByTitle('Actions'), { clientX: 5, clientY: 6 });
    expect(props.onContext).toHaveBeenCalledWith(ENTRIES[1], 5, 6);
    // The button's click never reaches the row, so nothing was "opened"
    expect(props.onActivate).not.toHaveBeenCalled();
  });
});

describe('FileList - click opens, press-and-hold selects', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const press = (el: HTMLElement, init: Record<string, unknown> = {}) =>
    fireEvent.pointerDown(el, { pointerType: 'mouse', button: 0, clientX: 100, clientY: 100, ...init });

  it('a plain click activates the row', () => {
    const { props } = renderList();
    press(row('Docs'));
    fireEvent.pointerUp(row('Docs'));
    fireEvent.click(row('Docs'), { ctrlKey: true });
    expect(props.onActivate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onActivate).mock.calls[0][0]).toBe(ENTRIES[0]);
    expect(vi.mocked(props.onActivate).mock.calls[0][1].ctrlKey).toBe(true);
    expect(props.onLongPress).not.toHaveBeenCalled();
  });

  it('holding for 450ms selects, and the click the browser fires on release is swallowed', () => {
    const { props } = renderList();
    press(row('Docs'), { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(449); });
    expect(props.onLongPress).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(props.onLongPress).toHaveBeenCalledWith(ENTRIES[0]);
    fireEvent.pointerUp(row('Docs'));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(row('Docs'), click);
    expect(click.defaultPrevented).toBe(true);
    expect(props.onActivate).not.toHaveBeenCalled();
    // Only that one click is swallowed
    fireEvent.click(row('Docs'));
    expect(props.onActivate).toHaveBeenCalledTimes(1);
  });

  it('moving the pointer cancels the hold, a small wobble does not', () => {
    const { props } = renderList();
    press(row('Docs'));
    fireEvent.pointerMove(row('Docs'), { clientX: 105, clientY: 103 });
    act(() => { vi.advanceTimersByTime(450); });
    expect(props.onLongPress).toHaveBeenCalledTimes(1);

    press(row('clip.mp4'));
    fireEvent.pointerMove(row('clip.mp4'), { clientX: 120, clientY: 100 });
    act(() => { vi.advanceTimersByTime(450); });
    expect(props.onLongPress).toHaveBeenCalledTimes(1);
    fireEvent.click(row('clip.mp4'));
    expect(props.onActivate).toHaveBeenCalledTimes(1);
  });

  it('releasing or leaving before the hold is up cancels it', () => {
    const { props } = renderList();
    press(row('Docs'));
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerUp(row('Docs'));
    act(() => { vi.advanceTimersByTime(300); });
    press(row('Docs'));
    fireEvent.pointerLeave(row('Docs'));
    act(() => { vi.advanceTimersByTime(500); });
    press(row('Docs'));
    fireEvent.pointerCancel(row('Docs'));
    act(() => { vi.advanceTimersByTime(500); });
    expect(props.onLongPress).not.toHaveBeenCalled();
  });

  it('a right mouse button never starts a hold', () => {
    const { props } = renderList();
    press(row('Docs'), { button: 2 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(props.onLongPress).not.toHaveBeenCalled();
  });

  it('a pending hold dies with the list', () => {
    const { props, unmount } = renderList();
    press(row('Docs'));
    unmount();
    act(() => { vi.advanceTimersByTime(500); });
    expect(props.onLongPress).not.toHaveBeenCalled();
  });
});

describe('FileList - inline rename', () => {
  it('shows an editor on the renaming row, focused with the stem selected', () => {
    renderList({ renaming: '/d/clip.mp4' });
    const input = within(row('clip.mp4')).getByDisplayValue('clip.mp4') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
    expect(within(row('Docs')).queryByRole('textbox')).toBeNull();
  });

  it('a name without an extension is selected whole', () => {
    renderList({ renaming: '/d/Docs' });
    const input = within(row('Docs')).getByDisplayValue('Docs') as HTMLInputElement;
    expect(input.selectionEnd).toBe(4);
  });

  it('Enter and blur submit, Escape cancels, and keys do not leak to the row', () => {
    const { props } = renderList({ renaming: '/d/clip.mp4' });
    const input = within(row('clip.mp4')).getByDisplayValue('clip.mp4');
    fireEvent.change(input, { target: { value: 'film.mp4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRename).toHaveBeenCalledWith(ENTRIES[1], 'film.mp4');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.onRenameCancel).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    expect(props.onRename).toHaveBeenCalledTimes(2);
    fireEvent.click(input);
    fireEvent.pointerDown(input, { pointerType: 'mouse', button: 0 });
    expect(props.onActivate).not.toHaveBeenCalled();
  });
});

describe('FileList - grid view', () => {
  it('shows a preview for local images and videos, an icon for everything else', () => {
    renderList({ view: 'grid', entries: [...ENTRIES, entry('far.mp4', { remote: true, path: 'vps:/x/far.mp4' })], selected: new Set(['/d/photo.jpg']) });
    const img = (name: string) => row(name).querySelector('img');
    expect(img('clip.mp4')).toHaveAttribute('src', expect.stringContaining('/api/files/thumb?path=%2Fd%2Fclip.mp4'));
    expect(img('clip.mp4')).toHaveClass('thumb-sheet');
    expect(img('photo.jpg')).toHaveClass('object-cover');
    expect(img('Docs')).toBeNull();
    expect(img('notes.txt')).toBeNull();
    expect(document.querySelector('[data-path="vps:/x/far.mp4"] img')).toBeNull();
    expect(within(row('Docs')).getByText('folder')).toBeInTheDocument();
    expect(within(row('clip.mp4')).getByText('2.00 KB')).toBeInTheDocument();
    expect(row('photo.jpg')).toHaveClass('border-cyan-500/60');
    expect(row('Docs')).not.toHaveClass('border-cyan-500/60');
  });

  it('warms the first 60 previews in one call, once per listing', () => {
    const many = Array.from({ length: 70 }, (_, i) => entry(`v${i}.mp4`));
    const { rerender, props } = renderList({ view: 'grid', entries: [entry('Docs', { is_dir: true }), ...many] });
    expect(files.warmThumbs).toHaveBeenCalledTimes(1);
    const paths = vi.mocked(files.warmThumbs).mock.calls[0][0];
    expect(paths).toHaveLength(60);
    expect(paths[0]).toBe('/d/v0.mp4');
    rerender(<FileList {...props} selected={new Set(['/d/v1.mp4'])} />);
    expect(files.warmThumbs).toHaveBeenCalledTimes(1);
    rerender(<FileList {...props} entries={[entry('other.jpg')]} />);
    expect(files.warmThumbs).toHaveBeenCalledTimes(2);
  });

  it('warms nothing when there is nothing to preview', () => {
    renderList({ view: 'grid', entries: [entry('Docs', { is_dir: true }), entry('notes.txt')] });
    expect(files.warmThumbs).not.toHaveBeenCalled();
    expect(files.thumbStatus).not.toHaveBeenCalled();
  });

  it('renames in the grid too', () => {
    const { props } = renderList({ view: 'grid', renaming: '/d/photo.jpg' });
    const input = within(row('photo.jpg')).getByDisplayValue('photo.jpg');
    fireEvent.change(input, { target: { value: 'pic.jpg' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRename).toHaveBeenCalledWith(ENTRIES[2], 'pic.jpg');
  });
});

describe('FileList - preview polling', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const tick = async (ms = 5000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const src = (name: string) => row(name).querySelector('img')!.getAttribute('src')!;

  it('asks every 5s where the previews stand and reloads a cell once its sheet is ready', async () => {
    vi.mocked(files.thumbStatus)
      .mockResolvedValueOnce({ states: { '/d/clip.mp4': 'quick', '/d/photo.jpg': 'ready' } })
      .mockResolvedValueOnce({ states: { '/d/clip.mp4': 'ready', '/d/photo.jpg': 'ready' } });
    renderList({ view: 'grid' });
    expect(files.thumbStatus).not.toHaveBeenCalled();
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledWith(['/d/clip.mp4', '/d/photo.jpg']);
    expect(src('clip.mp4')).not.toContain('v=');
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledTimes(2);
    expect(src('clip.mp4')).toContain('&v=1');
    expect(src('photo.jpg')).not.toContain('v=');
    // Everything settled: the poll stops
    await tick();
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps polling through a failed call, and only while the tab is visible', async () => {
    vi.mocked(files.thumbStatus)
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ states: { '/d/clip.mp4': 'pending', '/d/photo.jpg': 'none' } });
    renderList({ view: 'grid' });
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledTimes(1);
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledTimes(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await tick();
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledTimes(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledTimes(3);
  });

  it('stops when the grid goes away', async () => {
    vi.mocked(files.thumbStatus).mockResolvedValue({ states: { '/d/clip.mp4': 'pending' } });
    const { unmount } = renderList({ view: 'grid' });
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledTimes(1);
    unmount();
    await tick();
    expect(files.thumbStatus).toHaveBeenCalledTimes(1);
  });

  it('a preview that fails to load is retried with backoff, then gives way to the icon', async () => {
    renderList({ view: 'grid', entries: [entry('clip.mp4')] });
    const img = () => row('clip.mp4').querySelector('img');
    fireEvent.error(img()!);
    expect(src('clip.mp4')).not.toContain('retry=');
    await tick(3000);
    expect(src('clip.mp4')).toContain('&retry=1');
    fireEvent.error(img()!);
    await tick(5999);
    expect(src('clip.mp4')).toContain('&retry=1');
    await tick(1);
    expect(src('clip.mp4')).toContain('&retry=2');
    for (const wait of [12000, 20000, 20000, 20000]) {
      fireEvent.error(img()!);
      await tick(wait);
    }
    expect(src('clip.mp4')).toContain('&retry=6');
    fireEvent.error(img()!);
    await tick(20000);
    expect(img()).toBeNull();
    expect(row('clip.mp4').querySelector('svg')).toHaveClass('text-purple-400');
  });

  it('a retry and a reload are both carried in the URL', async () => {
    vi.mocked(files.thumbStatus)
      .mockResolvedValueOnce({ states: { '/d/clip.mp4': 'quick' } })
      .mockResolvedValueOnce({ states: { '/d/clip.mp4': 'ready' } });
    renderList({ view: 'grid', entries: [entry('clip.mp4')] });
    fireEvent.error(row('clip.mp4').querySelector('img')!);
    await tick(3000);
    expect(src('clip.mp4')).toMatch(/&retry=1$/);
    await tick(7000);
    // The reload remounts the cell with a fresh retry budget
    expect(src('clip.mp4')).toMatch(/&v=1$/);
  });
});

describe('FileList - on a touch screen', () => {
  it('the browser contextmenu on a hold is ignored; the ⋮ button is the way to the menu', async () => {
    vi.resetModules();
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ ...original(query), matches: query === '(pointer: coarse)' })) as typeof window.matchMedia;
    try {
      const { FileList: CoarseList } = await import('./FileList');
      const onContext = vi.fn();
      render(<CoarseList entries={ENTRIES} selected={new Set()} view="list" sortKey="name" sortAsc renaming={null}
        onSort={() => {}} onActivate={() => {}} onLongPress={() => {}} onContext={onContext} onRename={() => {}} onRenameCancel={() => {}} />);
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      fireEvent(row('Docs'), ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(onContext).not.toHaveBeenCalled();
      fireEvent.click(within(row('Docs')).getByTitle('Actions'));
      expect(onContext).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = original;
    }
  });
});

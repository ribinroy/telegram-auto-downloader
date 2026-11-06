import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useLayoutContext, type LayoutContext } from '../components/Layout';
import { makeDownload } from '../test/fixtures';
import { captureToasts } from '../test/toasts';
import { DownloadsPage } from './DownloadsPage';
import type { Download } from '../types';

vi.mock('../components/Layout', () => ({ useLayoutContext: vi.fn() }));
vi.mock('../components/DownloadItem', () => ({
  DownloadItem: ({ download, onRetry, onStop }: { download: Download; onRetry: (id: number) => void; onStop: (id: string) => void }) => (
    <div data-testid="item"><span>{download.file}</span><button onClick={() => onRetry(download.id)}>retry-{download.id}</button><button onClick={() => onStop(download.message_id!)}>stop-{download.id}</button></div>
  ),
}));
vi.mock('../components/AddUrlModal', () => ({
  AddUrlModal: ({ isOpen, onClose, initialUrl, initialFiles, showSecured }: { isOpen: boolean; onClose: () => void; initialUrl?: string | null; initialFiles?: File[] | null; showSecured?: boolean }) => (
    <div data-testid="modal" data-open={String(isOpen)} data-url={initialUrl ?? ''} data-files={(initialFiles ?? []).map(f => f.name).join(',')} data-secured={String(showSecured)}>
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}));
vi.mock('../components/DownloadQueue', () => ({
  DownloadQueueButton: ({ className, showSecured }: { className?: string; showSecured: boolean }) =>
    <div data-testid="queue" data-class={className} data-secured={String(showSecured)} />,
}));

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname}</output>;
}

const makeContext = (over: Partial<LayoutContext> = {}): LayoutContext => ({
  downloads: [], totalResults: 0, loading: false, loadingMore: false, hasMore: false, error: null,
  search: '', setSearch: vi.fn(), debouncedSearch: '',
  sortBy: 'created_at', setSortBy: vi.fn(), sortOrder: 'desc', setSortOrder: vi.fn(),
  authors: [], selectedAuthor: '', setSelectedAuthor: vi.fn(),
  filter: 'all', setFilter: vi.fn(),
  loadMore: vi.fn(), onRetry: vi.fn(), onStop: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onDelete: vi.fn(),
  addUrlOpen: false, setAddUrlOpen: vi.fn(), pastedUrl: null, setPastedUrl: vi.fn(),
  showSecured: false, refreshDownloads: vi.fn(), vpsReady: false,
  ...over,
});

const renderPage = (over: Partial<LayoutContext> = {}) => {
  const ctx = makeContext(over);
  vi.mocked(useLayoutContext).mockReturnValue(ctx);
  const utils = render(<MemoryRouter><DownloadsPage /><LocationProbe /></MemoryRouter>);
  return { ...utils, ctx };
};

/** jsdom has no DragEvent; a plain event with a dataTransfer bolted on is
 *  what the page's window listeners read. */
const dragEvent = (type: string, over: { types?: string[]; files?: File[] } = {}) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { types: over.types ?? ['Files'], files: over.files ?? [], dropEffect: 'none' },
  });
  return ev;
};
const torrent = (name: string) => new File(['x'], name, { type: 'application/x-bittorrent' });

beforeEach(() => { vi.clearAllMocks(); });

describe('DownloadsPage - list states', () => {
  it('focuses the search box and shows the empty state', () => {
    renderPage();
    expect(screen.getByPlaceholderText('Search...')).toHaveFocus();
    expect(screen.getByText('No downloads yet')).toBeInTheDocument();
    expect(screen.queryByTestId('item')).toBeNull();
  });

  it('shows a spinner while loading, and the on-disk empty state under that filter', () => {
    const { rerender } = renderPage({ loading: true });
    expect(screen.getByText('Loading downloads...')).toBeInTheDocument();
    vi.mocked(useLayoutContext).mockReturnValue(makeContext({ filter: 'on_disk' }));
    rerender(<MemoryRouter><DownloadsPage /></MemoryRouter>);
    expect(screen.getByText('Nothing on disk')).toBeInTheDocument();
  });

  it('renders one item per download, wired to the context handlers, plus a spinner while loading more', () => {
    const { ctx } = renderPage({
      downloads: [makeDownload({ id: 1, file: 'a.mkv' }), makeDownload({ id: 2, message_id: 'm2', file: 'b.mkv' })],
      loadingMore: true,
    });
    expect(screen.getAllByTestId('item')).toHaveLength(2);
    fireEvent.click(screen.getByText('retry-2'));
    expect(ctx.onRetry).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByText('stop-1'));
    expect(ctx.onStop).toHaveBeenCalledWith('m1');
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });

  it('toasts when the list could not be loaded', async () => {
    const captured = captureToasts();
    try {
      renderPage({ error: 'Failed to fetch downloads' });
      await vi.waitFor(() => expect(captured.titles()).toEqual(["Couldn't load downloads"]));
    } finally { captured.stop(); }
  });
});

describe('DownloadsPage - search, filter and sort', () => {
  it('typing searches; the result count and clear button appear once the search is applied', () => {
    const { ctx } = renderPage({ search: 'fi', debouncedSearch: 'fi', totalResults: 3 });
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'film' } });
    expect(ctx.setSearch).toHaveBeenCalledWith('film');
    expect(screen.getByText('3 results')).toBeInTheDocument();
    fireEvent.click(screen.getByText('3 results').nextElementSibling!);
    expect(ctx.setSearch).toHaveBeenCalledWith('');
  });

  it('says "1 result" in the singular and hides the count with no search', () => {
    const { rerender } = renderPage({ debouncedSearch: 'x', totalResults: 1 });
    expect(screen.getByText('1 result')).toBeInTheDocument();
    vi.mocked(useLayoutContext).mockReturnValue(makeContext({ totalResults: 5 }));
    rerender(<MemoryRouter><DownloadsPage /></MemoryRouter>);
    expect(screen.queryByText(/result/)).toBeNull();
  });

  it('the filter, sort and order selects (phone and desktop) drive the context', () => {
    const { ctx } = renderPage();
    const shows = screen.getAllByTitle('Show') as HTMLSelectElement[];
    expect(shows).toHaveLength(2);
    fireEvent.change(shows[0], { target: { value: 'on_disk' } });
    fireEvent.change(shows[1], { target: { value: 'on_disk' } });
    expect(ctx.setFilter).toHaveBeenCalledTimes(2);
    expect(ctx.setFilter).toHaveBeenCalledWith('on_disk');
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects).toHaveLength(6);   // show, sort, order x2 - no author select with no authors
    const sortBy = selects.filter(s => s.value === 'created_at');
    expect(sortBy).toHaveLength(2);
    fireEvent.change(sortBy[1], { target: { value: 'status' } });
    expect(ctx.setSortBy).toHaveBeenCalledWith('status');
    const order = selects.filter(s => s.value === 'desc');
    fireEvent.change(order[0], { target: { value: 'asc' } });
    expect(ctx.setSortOrder).toHaveBeenCalledWith('asc');
  });

  it('offers an author filter once there is more than one, labelled without the id', () => {
    const { ctx, rerender } = renderPage({ authors: ['alice:123', 'bob'] });
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects).toHaveLength(8);
    const authors = selects.filter(s => s.value === '' && s.options.length === 3);
    expect(authors).toHaveLength(2);
    expect(Array.from(authors[0].options).map(o => o.textContent)).toEqual(['All authors', 'alice', 'bob']);
    fireEvent.change(authors[0], { target: { value: 'alice:123' } });
    expect(ctx.setSelectedAuthor).toHaveBeenCalledWith('alice:123');
    vi.mocked(useLayoutContext).mockReturnValue(makeContext({ authors: ['only'] }));
    rerender(<MemoryRouter><DownloadsPage /></MemoryRouter>);
    expect(screen.getAllByRole('combobox')).toHaveLength(6);
  });
});

describe('DownloadsPage - infinite scroll and paste', () => {
  afterEach(() => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 0 });
  });

  it('asks for more when scrolled near the bottom', () => {
    const { ctx } = renderPage();
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 800 });
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 100 });
    fireEvent.scroll(window);
    expect(ctx.loadMore).not.toHaveBeenCalled();
    window.scrollY = 1950;   // 3000 - 1950 - 800 = 250 < 300
    fireEvent.scroll(window);
    expect(ctx.loadMore).toHaveBeenCalledTimes(1);
  });

  it('a paste outside an input opens the add dialog with the text', () => {
    const { ctx } = renderPage();
    const paste = (target: Element, text: string) => {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { getData: () => text } });
      target.dispatchEvent(ev);
      return ev;
    };
    const ev = paste(document.body, '  https://youtu.be/x  ');
    expect(ev.defaultPrevented).toBe(true);
    expect(ctx.setPastedUrl).toHaveBeenCalledWith('https://youtu.be/x');
    expect(ctx.setAddUrlOpen).toHaveBeenCalledWith(true);
    // Into the search box: left to the input
    paste(screen.getByPlaceholderText('Search...'), 'https://other');
    expect(ctx.setPastedUrl).toHaveBeenCalledTimes(1);
    // Empty clipboard: nothing
    paste(document.body, '   ');
    expect(ctx.setPastedUrl).toHaveBeenCalledTimes(1);
  });

  it('ignores a paste while the dialog is already open', () => {
    const { ctx } = renderPage({ addUrlOpen: true });
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => 'https://x' } });
    document.body.dispatchEvent(ev);
    expect(ctx.setPastedUrl).not.toHaveBeenCalled();
  });
});

describe('DownloadsPage - dropping .torrent files', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the drop overlay while files are dragged over, driven by a depth counter', () => {
    renderPage();
    act(() => { window.dispatchEvent(dragEvent('dragenter')); });
    expect(screen.getByText('Drop .torrent files')).toBeInTheDocument();
    act(() => { window.dispatchEvent(dragEvent('dragenter')); });   // a child element
    act(() => { window.dispatchEvent(dragEvent('dragleave')); });
    expect(screen.getByText('Drop .torrent files')).toBeInTheDocument();
    act(() => { window.dispatchEvent(dragEvent('dragleave')); });
    expect(screen.queryByText('Drop .torrent files')).toBeNull();
    // dragover accepts the drop
    const over = dragEvent('dragover');
    act(() => { window.dispatchEvent(over); });
    expect(over.defaultPrevented).toBe(true);
    expect((over as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe('copy');
  });

  it('dragging something that is not a file (text, a link) is ignored', () => {
    renderPage();
    const ev = dragEvent('dragenter', { types: ['text/plain'] });
    act(() => { window.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByText('Drop .torrent files')).toBeNull();
  });

  it('dropping .torrent files opens the add dialog preloaded with every one of them', () => {
    const { ctx, rerender } = renderPage();
    act(() => { window.dispatchEvent(dragEvent('dragenter')); });
    const drop = dragEvent('drop', { files: [torrent('a.torrent'), new File(['x'], 'notes.txt', { type: 'text/plain' }), torrent('B.TORRENT')] });
    act(() => { window.dispatchEvent(drop); });
    expect(drop.defaultPrevented).toBe(true);
    expect(screen.queryByText('Drop .torrent files')).toBeNull();
    expect(ctx.setPastedUrl).toHaveBeenCalledWith(null);
    expect(ctx.setAddUrlOpen).toHaveBeenCalledWith(true);
    // The page passes the batch to the modal once the layout says it is open
    const open = makeContext({ addUrlOpen: true });
    vi.mocked(useLayoutContext).mockReturnValue(open);
    rerender(<MemoryRouter><DownloadsPage /><LocationProbe /></MemoryRouter>);
    expect(screen.getByTestId('modal')).toHaveAttribute('data-files', 'a.torrent,B.TORRENT');
    expect(screen.getByTestId('modal')).toHaveAttribute('data-open', 'true');
    // Closing clears the batch and the pasted URL
    fireEvent.click(screen.getByText('close-modal'));
    expect(open.setAddUrlOpen).toHaveBeenCalledWith(false);
    expect(open.setPastedUrl).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId('modal')).toHaveAttribute('data-files', '');
  });

  it('a drop with no .torrent in it flashes a rejection for 2.5s and opens nothing', () => {
    const { ctx } = renderPage();
    act(() => { window.dispatchEvent(dragEvent('dragenter')); });
    act(() => { window.dispatchEvent(dragEvent('drop', { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] })); });
    expect(screen.getByText('No .torrent files in that drop')).toBeInTheDocument();
    expect(ctx.setAddUrlOpen).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2499); });
    expect(screen.getByText('No .torrent files in that drop')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('No .torrent files in that drop')).toBeNull();
  });

  it('a drop of non-files is left to the browser', () => {
    const { ctx } = renderPage();
    const drop = dragEvent('drop', { types: ['text/uri-list'] });
    act(() => { window.dispatchEvent(drop); });
    expect(drop.defaultPrevented).toBe(false);
    expect(ctx.setAddUrlOpen).not.toHaveBeenCalled();
  });
});

describe('DownloadsPage - floating buttons and the modal', () => {
  it('the + button opens the add dialog, which gets the pasted URL and the secured flag', () => {
    const { ctx } = renderPage({ pastedUrl: 'https://p', showSecured: true, addUrlOpen: true });
    fireEvent.click(screen.getByText('Add URL download').previousElementSibling!);
    expect(ctx.setAddUrlOpen).toHaveBeenCalledWith(true);
    const modal = screen.getByTestId('modal');
    expect(modal).toHaveAttribute('data-open', 'true');
    expect(modal).toHaveAttribute('data-url', 'https://p');
    expect(modal).toHaveAttribute('data-secured', 'true');
    expect(screen.getByTestId('queue')).toHaveAttribute('data-secured', 'true');
  });

  it('the VPS button shows only when the VPS is ready and lifts the queue button above it', () => {
    const { rerender } = renderPage();
    expect(screen.queryByText('VPS files')).toBeNull();
    expect(screen.getByTestId('queue')).toHaveAttribute('data-class', 'bottom-20 sm:bottom-24');
    vi.mocked(useLayoutContext).mockReturnValue(makeContext({ vpsReady: true }));
    rerender(<MemoryRouter><DownloadsPage /><LocationProbe /></MemoryRouter>);
    expect(screen.getByTestId('queue')).toHaveAttribute('data-class', 'bottom-36 sm:bottom-[10.5rem]');
    fireEvent.click(screen.getByText('VPS files').previousElementSibling!);
    expect(screen.getByTestId('location')).toHaveTextContent('/vps');
  });
});

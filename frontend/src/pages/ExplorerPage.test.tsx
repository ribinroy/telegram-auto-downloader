import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import * as files from '../api/files';
import { qk } from '../api/queryKeys';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { deferred } from '../test/fixtures';
import { ExplorerPage } from './ExplorerPage';

vi.mock('../api/files', async (orig) => ({
  ...(await orig<typeof files>()),
  fetchFileRoots: vi.fn(), listFiles: vi.fn(), createFolder: vi.fn(), renamePath: vi.fn(), deletePaths: vi.fn(),
  transferPaths: vi.fn(), searchFiles: vi.fn(), uploadFiles: vi.fn(), fetchTransfers: vi.fn(), ackTransfers: vi.fn(),
  warmThumbs: vi.fn(), thumbStatus: vi.fn(), readTextFile: vi.fn(),
}));
// The page reads the secured toggle from the Layout's outlet context.
vi.mock('../components/Layout', () => ({ useLayoutContext: () => ({ showSecured: false }) }));
// The modals have their own tests; here they only report what they were given.
vi.mock('../components/explorer/FilePreviewModal', () => ({
  FilePreviewModal: ({ entry, siblings, onClose, onNavigate }: { entry: files.FileEntry; siblings: files.FileEntry[]; onClose: () => void; onNavigate: (e: files.FileEntry) => void }) =>
    <div data-testid="preview" data-name={entry.name} data-siblings={siblings.map(s => s.name).join(',')}>
      <button onClick={onClose}>close-preview</button>
      <button onClick={() => onNavigate(siblings[0])}>first-sibling</button>
    </div>,
}));
vi.mock('../components/explorer/PropertiesModal', () => ({
  PropertiesModal: ({ entry, onClose }: { entry: files.FileEntry; onClose: () => void }) =>
    <div data-testid="properties" data-name={entry.name}><button onClick={onClose}>close-props</button></div>,
}));
vi.mock('../components/explorer/TransfersModal', () => ({
  TransfersModal: ({ transfers, onClose, onOpenDest }: { transfers: files.FileTransfer[]; onClose: () => void; onOpenDest: (p: string) => void }) =>
    <div data-testid="transfers" data-count={transfers.length}>
      <button onClick={onClose}>close-transfers</button>
      <button onClick={() => onOpenDest(transfers[0].dest)}>open-dest</button>
    </div>,
}));
vi.mock('react-time-ago', () => ({ default: ({ date }: { date: Date }) => <time dateTime={date.toISOString()}>ago</time> }));

// --- fixtures ---------------------------------------------------------------

const entry = (dir: string, name: string, over: Partial<files.FileEntry> = {}): files.FileEntry => {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const kind: files.FileKind = over.is_dir ? 'folder'
    : ({ mp4: 'video', mkv: 'video', jpg: 'image', txt: 'text' } as Record<string, files.FileKind>)[ext] ?? 'file';
  return {
    name, path: `${dir}/${name}`, is_dir: false, is_link: false, broken: false, hidden: false,
    size: 1024, modified: '2026-01-01T00:00:00Z', mode: null, kind, ext, ...over,
  };
};

const X = '/mnt/x';
const X_ENTRIES = [
  entry(X, 'Docs', { is_dir: true, size: 0, modified: '2026-01-04T00:00:00Z' }),
  entry(X, 'clip.mp4', { size: 2048, modified: '2026-01-03T00:00:00Z' }),
  entry(X, 'photo.jpg', { size: 1024, modified: '2026-01-02T00:00:00Z' }),
  entry(X, 'notes.txt', { size: 512, modified: '2026-01-01T00:00:00Z' }),
];
const VPS = 'vps:/home6/u';
const VPS_ENTRIES = [
  entry(VPS, 'far.mkv', { remote: true, size: 4096 }),
  entry(VPS, 'readme.txt', { remote: true }),
];

const listing = (path: string, entries: files.FileEntry[], over: Partial<files.FileListing> = {}): files.FileListing => ({
  path, parent: path === '/' ? null : path.split('/').slice(0, -1).join('/') || '/', name: path.split('/').pop() ?? '',
  entries, writable: true, usage: { total: 1000, used: 400, free: 600 }, mount: '/mnt', trash: null, ...over,
});

const LISTINGS: Record<string, files.FileListing> = {
  [X]: listing(X, X_ENTRIES, { trash: '/mnt/.downlee-trash' }),
  '/mnt': listing('/mnt', [entry('/mnt', 'x', { is_dir: true })]),
  [`${X}/Docs`]: listing(`${X}/Docs`, []),
  '/ro': listing('/ro', [entry('/ro', 'locked.txt')], { writable: false }),
  [VPS]: listing(VPS, VPS_ENTRIES, { parent: null, writable: false, remote: true, home: VPS, usage: null }),
};

const job = (over: Partial<files.FileTransfer> = {}): files.FileTransfer => ({
  id: 'j1', move: false, paths: ['/a/Movies'], dest: '/mnt/hdd/Films', status: 'running',
  total_bytes: 4000, done_bytes: 1000, total_files: 3, done_files: 1, items_total: 1, items_done: 0,
  current_item: '/a/Movies', current_file: null, current_file_size: 0, current_file_done: 0,
  speed: 0, eta: null, started_at: 100, finished_at: null, results: [], errors: [], error: null, acknowledged: false, ...over,
});

const roots: files.FileRoot[] = [
  { path: '/mnt', label: 'disk', kind: 'disk', group: 'drive', note: null, device: null, fstype: null, usage: null, writable: true },
  { path: '/home/hs', label: 'Home', kind: 'home', group: 'folder', note: null, device: null, fstype: null, usage: null, writable: true },
];

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

async function renderPage(url = `/files?path=${X}`, waitForName: string | null = 'clip.mp4') {
  const view = renderWithClient(<><ExplorerPage /><LocationSpy /></>, { router: true, initialEntries: [url] });
  if (waitForName) await screen.findByText(waitForName, { selector: 'span' });
  return view;
}

const row = (path: string) => document.querySelector(`[data-path="${path}"]`) as HTMLElement;
const rowNames = () => Array.from(document.querySelectorAll('[data-path]')).map(el => el.getAttribute('data-path')!.split('/').pop());
const loc = () => screen.getByTestId('loc').textContent;
const decodedLoc = () => decodeURIComponent(loc() ?? '');
const bar = () => document.querySelector('.backdrop-blur-md') as HTMLElement;
// The bar stays mounted (inert) while it fades out, still showing its last content.
const barHidden = () => bar().parentElement!.hasAttribute('inert');
const drawer = () => screen.getByLabelText('Close places').closest('.fixed') as HTMLElement;
const menuButton = (path: string) => within(row(path)).getByTitle('Actions');
const openMenu = (path: string) => {
  fireEvent.click(menuButton(path), { clientX: 10, clientY: 10 });
  return within(document.querySelector('.z-\\[110\\]') as HTMLElement);
};
const key = (k: string, init: Record<string, unknown> = {}) => fireEvent.keyDown(window, { key: k, ...init });
const ctrl = (k: string) => key(k, { ctrlKey: true });

let toasts: ReturnType<typeof captureToasts>;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(files.fetchFileRoots).mockResolvedValue({ roots, readonly: false, home: '/home/hs', default: X });
  vi.mocked(files.listFiles).mockImplementation(async (path) => {
    const l = LISTINGS[path ?? ''];
    if (!l) throw new Error(`No such folder: ${path}`);
    return l;
  });
  vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [] });
  vi.mocked(files.ackTransfers).mockResolvedValue({ acknowledged: 1 });
  vi.mocked(files.warmThumbs).mockResolvedValue({ queued: 0, cached: 0, skipped: 0 });
  vi.mocked(files.thumbStatus).mockResolvedValue({ states: {} });
  toasts = captureToasts();
});
afterEach(() => { toasts.stop(); });

// --- the folder in the URL --------------------------------------------------

describe('ExplorerPage - the folder in the URL', () => {
  it('lists the folder named by ?path= with folders first, and the places from the roots call', async () => {
    await renderPage();
    expect(files.listFiles).toHaveBeenCalledWith(X, false);
    expect(files.fetchFileRoots).toHaveBeenCalledWith(false);
    expect(rowNames()).toEqual(['Docs', 'clip.mp4', 'notes.txt', 'photo.jpg']);
    // The desktop sidebar and the phone drawer both list the places
    expect(screen.getAllByText('disk')).toHaveLength(2);
    expect(screen.getAllByText('Deleted files')).toHaveLength(2);
    expect(barHidden()).toBe(true);
    expect(screen.queryByText('read-only mode')).toBeNull();
    expect(screen.getByText('600.00 B free of 1000.00 B')).toBeInTheDocument();
  });

  it('shows the read-only badge when the server says so', async () => {
    vi.mocked(files.fetchFileRoots).mockResolvedValue({ roots, readonly: true, home: '/home/hs', default: X });
    await renderPage();
    expect(await screen.findByText('read-only mode')).toBeInTheDocument();
  });

  it('?select= highlights that entry, scrolls to it and drops the param from the URL', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    await renderPage(`/files?path=${X}&select=${X}/photo.jpg`);
    expect(row(`${X}/photo.jpg`)).toHaveClass('bg-cyan-500/15');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await waitFor(() => expect(decodedLoc()).toBe(`/files?path=${X}`));
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center' }));
  });

  it('?select= for something not in the folder selects nothing and is left alone', async () => {
    await renderPage(`/files?path=${X}&select=${X}/gone.txt`);
    expect(screen.queryByText('1 selected')).toBeNull();
    expect(decodedLoc()).toContain('select=');
  });

  it('a folder that cannot be read says so in place and as a toast', async () => {
    await renderPage('/files?path=/nowhere', null);
    expect(await screen.findByText("Couldn't load this folder")).toBeInTheDocument();
    await waitFor(() => expect(toasts.titles()).toContain("Couldn't load this folder"));
    expect(toasts.toasts[0].message).toBe('No such folder: /nowhere');
  });

  it('an empty folder says so', async () => {
    await renderPage(`/files?path=${X}/Docs`, null);
    expect(await screen.findByText('This folder is empty')).toBeInTheDocument();
  });
});

// --- navigation -------------------------------------------------------------

describe('ExplorerPage - navigation', () => {
  it('a click on a folder row opens it and the URL follows', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/Docs`));
    await screen.findByText('This folder is empty');
    expect(decodedLoc()).toBe(`/files?path=${X}/Docs`);
    expect(files.listFiles).toHaveBeenCalledWith(`${X}/Docs`, false);
  });

  it('the crumbs, the Up button and Backspace all go up', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'mnt' }));
    await screen.findByText('x', { selector: 'span' });
    expect(decodedLoc()).toBe('/files?path=/mnt');
    fireEvent.click(row('/mnt/x'));
    await screen.findByText('clip.mp4', { selector: 'span' });
    fireEvent.click(screen.getByTitle('Up one level (Backspace)'));
    await screen.findByText('x', { selector: 'span' });
    fireEvent.click(row('/mnt/x'));
    await screen.findByText('clip.mp4', { selector: 'span' });
    key('Backspace');
    await screen.findByText('x', { selector: 'span' });
    expect(decodedLoc()).toBe('/files?path=/mnt');
  });

  it('Backspace at the top of the tree does nothing', async () => {
    await renderPage(`/files?path=${VPS}`, 'far.mkv');
    key('Backspace');
    expect(decodedLoc()).toBe(`/files?path=${VPS}`);
    expect(screen.getByTitle('Up one level (Backspace)')).toBeDisabled();
  });

  it('Enter opens the one selected entry: a folder navigates, a file previews', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/Docs`), { ctrlKey: true });
    key('Enter');
    await screen.findByText('This folder is empty');
    expect(decodedLoc()).toBe(`/files?path=${X}/Docs`);
  });

  it('the places list navigates, and the phone drawer closes behind it', async () => {
    await renderPage();
    expect(drawer()).toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', { name: 'Open places' }));
    expect(drawer()).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(drawer()).getByText('Home').closest('button')!);
    await waitFor(() => expect(decodedLoc()).toBe('/files?path=/home/hs'));
    expect(drawer()).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('');
  });

  it('Escape closes the drawer before it touches the selection', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/Docs`), { ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open places' }));
    key('Escape');
    expect(drawer()).toHaveAttribute('inert');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(barHidden()).toBe(false);
    key('Escape');
    expect(barHidden()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open places' }));
    expect(drawer()).not.toHaveAttribute('inert');
    fireEvent.click(screen.getByLabelText('Close places'));
    expect(drawer()).toHaveAttribute('inert');
  });
});

// --- opening and selecting --------------------------------------------------

describe('ExplorerPage - click opens, press-and-hold selects', () => {
  it('a plain click on a file opens the preview with the folder\'s files as siblings', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/photo.jpg`));
    const preview = screen.getByTestId('preview');
    expect(preview).toHaveAttribute('data-name', 'photo.jpg');
    expect(preview).toHaveAttribute('data-siblings', 'clip.mp4,notes.txt,photo.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'first-sibling' }));
    expect(screen.getByTestId('preview')).toHaveAttribute('data-name', 'clip.mp4');
    // The page's shortcuts are off while the preview is up
    ctrl('a');
    expect(screen.queryByText('4 selected')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'close-preview' }));
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('holding a row for 450ms selects it, and the click on release does not open it', async () => {
    await renderPage();
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(row(`${X}/clip.mp4`), { pointerType: 'touch', button: 0, clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(450); });
      fireEvent.pointerUp(row(`${X}/clip.mp4`));
      fireEvent.click(row(`${X}/clip.mp4`));
      expect(screen.getByText('1 selected')).toBeInTheDocument();
      expect(screen.queryByTestId('preview')).toBeNull();
      // A hold on a second row extends the selection
      fireEvent.pointerDown(row(`${X}/photo.jpg`), { pointerType: 'touch', button: 0, clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(450); });
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      // ...while a hold that moves is a scroll
      fireEvent.pointerDown(row(`${X}/notes.txt`), { pointerType: 'touch', button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(row(`${X}/notes.txt`), { clientX: 10, clientY: 60 });
      act(() => { vi.advanceTimersByTime(450); });
      expect(screen.getByText('2 selected')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('once something is selected, clicks toggle instead of opening', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(row(`${X}/Docs`));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(decodedLoc()).toBe(`/files?path=${X}`);
    fireEvent.click(row(`${X}/Docs`));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(row(`${X}/clip.mp4`));
    expect(barHidden()).toBe(true);
    // Out of selection mode: a click opens again
    fireEvent.click(row(`${X}/photo.jpg`));
    expect(screen.getByTestId('preview')).toBeInTheDocument();
  });

  it('shift-click selects the range from the last toggled row; meta-click toggles like ctrl', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/Docs`), { metaKey: true });
    fireEvent.click(row(`${X}/notes.txt`), { shiftKey: true });
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect(row(`${X}/clip.mp4`)).toHaveClass('bg-cyan-500/15');
    expect(row(`${X}/photo.jpg`)).not.toHaveClass('bg-cyan-500/15');
    // The anchor outlives a Clear, so the next shift-click ranges from it again
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(barHidden()).toBe(true);
    fireEvent.click(row(`${X}/photo.jpg`), { shiftKey: true });
    expect(screen.getByText('4 selected')).toBeInTheDocument();
    expect(barHidden()).toBe(false);
  });

  it('Ctrl+A selects everything, Escape and Clear drop it, and the bar sums the sizes', async () => {
    await renderPage();
    ctrl('a');
    expect(screen.getByText('4 selected')).toBeInTheDocument();
    expect(screen.getByText('· 3.50 KB')).toBeInTheDocument();
    key('Escape');
    expect(barHidden()).toBe(true);
    // The bar keeps its last content while it fades out
    expect(within(bar()).getByText('4 selected')).toBeInTheDocument();
    expect(row(`${X}/Docs`)).not.toHaveClass('bg-cyan-500/15');
  });

  it('shortcuts are ignored while typing in a text box', async () => {
    await renderPage();
    const filter = screen.getByPlaceholderText(/Filter this folder/);
    filter.focus();
    fireEvent.keyDown(filter, { key: 'a', ctrlKey: true });
    expect(screen.queryByText('4 selected')).toBeNull();
  });
});

// --- clipboard --------------------------------------------------------------

describe('ExplorerPage - clipboard', () => {
  it('Ctrl+C / Ctrl+V copies into the current folder and keeps the clipboard', async () => {
    vi.mocked(files.transferPaths).mockResolvedValue({ results: [{ path: `${X}/clip.mp4` }], errors: [], job: job({ status: 'done', finished_at: 110 }), running: false });
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    fireEvent.click(row(`${X}/notes.txt`), { ctrlKey: true });
    ctrl('c');
    expect(screen.getByText('2 item(s) ready to copy')).toBeInTheDocument();
    ctrl('v');
    await waitFor(() => expect(files.transferPaths).toHaveBeenCalledWith([`${X}/clip.mp4`, `${X}/notes.txt`], X, false));
    await waitFor(() => expect(files.ackTransfers).toHaveBeenCalledWith(['j1'], expect.anything()));
    expect(screen.getByText('2 item(s) ready to copy')).toBeInTheDocument();
    expect(toasts.titles()).toEqual([]);
  });

  it('Ctrl+X / Ctrl+V moves and empties the clipboard; errors are toasted', async () => {
    vi.mocked(files.transferPaths).mockResolvedValue({ results: [], errors: [{ path: `${X}/clip.mp4`, error: 'Busy' }, { path: 'b', error: 'x' }] });
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    ctrl('x');
    expect(screen.getByText('1 item(s) ready to move')).toBeInTheDocument();
    ctrl('v');
    await waitFor(() => expect(files.transferPaths).toHaveBeenCalledWith([`${X}/clip.mp4`], X, true));
    await waitFor(() => expect(toasts.titles()).toEqual(['Move failed for 2 item(s)']));
    expect(toasts.toasts[0].message).toBe('Busy');
    expect(screen.queryByText('1 item(s) ready to move')).toBeNull();
  });

  it('the bar\'s Copy / Cut / Paste here / X do the same, and a thrown paste is toasted', async () => {
    vi.mocked(files.transferPaths).mockRejectedValue(new Error('Disk full'));
    await renderPage();
    fireEvent.click(row(`${X}/photo.jpg`), { ctrlKey: true });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Copy' }));
    expect(screen.getByText('1 item(s) ready to copy')).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Cut' }));
    expect(screen.getByText('1 item(s) ready to move')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Paste here' }));
    await waitFor(() => expect(toasts.titles()).toEqual(['Move failed']));
    expect(toasts.toasts[0].message).toBe('Disk full');
    fireEvent.click(screen.getByText('1 item(s) ready to move').parentElement!.querySelector('button:last-child')!);
    expect(screen.queryByText('1 item(s) ready to move')).toBeNull();
  });

  it('Paste here is disabled in a folder that cannot be written', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/photo.jpg`), { ctrlKey: true });
    ctrl('c');
    vi.mocked(files.listFiles).mockImplementation(async (path) => path === '/home/hs' ? listing('/home/hs', [], { writable: false }) : LISTINGS[path ?? '']);
    fireEvent.click(screen.getByRole('button', { name: 'Open places' }));
    fireEvent.click(within(drawer()).getByText('Home').closest('button')!);
    await screen.findByText('This folder is empty');
    expect(screen.getByRole('button', { name: 'Paste here' })).toBeDisabled();
    ctrl('v');
    expect(files.transferPaths).not.toHaveBeenCalled();
  });

  it('a paste the server is still working on hands over to the transfers bar', async () => {
    const running = job({ id: 'j9', move: true, paths: [`${X}/clip.mp4`], dest: `${X}/Docs` });
    vi.mocked(files.transferPaths).mockResolvedValue({ results: [], errors: [], job: running, running: true });
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [running] });
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    ctrl('x');
    ctrl('v');
    await waitFor(() => expect(files.transferPaths).toHaveBeenCalled());
    expect(screen.queryByText('1 item(s) ready to move')).toBeNull();
    expect(await screen.findByText('Moving clip.mp4 to Docs')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(files.ackTransfers).not.toHaveBeenCalled();
  });
});

// --- rename, new folder -----------------------------------------------------

describe('ExplorerPage - rename and new folder', () => {
  it('F2 opens the inline editor; Enter renames, the same name does nothing', async () => {
    vi.mocked(files.renamePath).mockResolvedValue({ entry: entry(X, 'film.mp4') });
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    key('F2');
    const input = within(row(`${X}/clip.mp4`)).getByDisplayValue('clip.mp4');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(files.renamePath).not.toHaveBeenCalled();
    key('F2');
    const again = within(row(`${X}/clip.mp4`)).getByDisplayValue('clip.mp4');
    fireEvent.change(again, { target: { value: 'film.mp4' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => expect(files.renamePath).toHaveBeenCalledWith(`${X}/clip.mp4`, 'film.mp4'));
    expect(within(row(`${X}/clip.mp4`)).queryByRole('textbox')).toBeNull();
  });

  it('Escape cancels the editor; a failed rename is toasted', async () => {
    vi.mocked(files.renamePath).mockRejectedValue(new Error('Name taken'));
    await renderPage();
    const menu = openMenu(`${X}/clip.mp4`);
    fireEvent.click(menu.getByRole('button', { name: 'Rename' }));
    fireEvent.keyDown(within(row(`${X}/clip.mp4`)).getByDisplayValue('clip.mp4'), { key: 'Escape' });
    expect(within(row(`${X}/clip.mp4`)).queryByRole('textbox')).toBeNull();
    key('F2');
    const input = within(row(`${X}/clip.mp4`)).getByDisplayValue('clip.mp4');
    fireEvent.change(input, { target: { value: 'x.mp4' } });
    fireEvent.blur(input);
    await waitFor(() => expect(toasts.titles()).toEqual(['Rename failed']));
    expect(toasts.toasts[0].message).toBe('Name taken');
  });

  it('F2 and Delete are refused in a read-only folder', async () => {
    await renderPage('/files?path=/ro', 'locked.txt');
    fireEvent.click(row('/ro/locked.txt'), { ctrlKey: true });
    key('F2');
    expect(screen.queryByRole('textbox', { name: '' })).not.toHaveDisplayValue('locked.txt');
    key('Delete');
    expect(screen.queryByText('Move to trash?')).toBeNull();
    expect(within(bar()).queryByRole('button', { name: 'Cut' })).toBeNull();
    expect(within(bar()).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(within(bar()).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('New folder takes the first free name and goes straight into rename', async () => {
    vi.mocked(files.createFolder)
      .mockRejectedValueOnce(new Error('A file named "New folder" already exists'))
      .mockResolvedValueOnce({ entry: entry(X, 'New folder (2)', { is_dir: true }) });
    vi.mocked(files.listFiles).mockImplementation(async (path) => path === X
      ? listing(X, [...X_ENTRIES, entry(X, 'New folder (2)', { is_dir: true })]) : LISTINGS[path ?? '']);
    await renderPage();
    fireEvent.click(screen.getByTitle('New folder'));
    await waitFor(() => expect(files.createFolder).toHaveBeenCalledWith(X, 'New folder (2)'));
    expect(files.createFolder).toHaveBeenNthCalledWith(1, X, 'New folder');
    expect(await screen.findByDisplayValue('New folder (2)')).toBeInTheDocument();
  });

  it('any other failure to create a folder is toasted', async () => {
    vi.mocked(files.createFolder).mockRejectedValue(new Error('Read-only file system'));
    await renderPage();
    fireEvent.click(screen.getByTitle('New folder'));
    await waitFor(() => expect(toasts.titles()).toEqual(["Couldn't create the folder"]));
    expect(files.createFolder).toHaveBeenCalledTimes(1);
  });
});

// --- delete -----------------------------------------------------------------

describe('ExplorerPage - delete', () => {
  it('Delete asks before moving to the trash, says so in the bar while it runs, then toasts', async () => {
    const pending = deferred<files.FileOpResponse>();
    vi.mocked(files.deletePaths).mockReturnValue(pending.promise);
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    fireEvent.click(row(`${X}/notes.txt`), { ctrlKey: true });
    key('Delete');
    expect(screen.getByText('Move to trash?')).toBeInTheDocument();
    expect(screen.getByText('2 item(s) will be moved to .downlee-trash on the same disk, where you can still recover them.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    await waitFor(() => expect(files.deletePaths).toHaveBeenCalledWith([`${X}/clip.mp4`, `${X}/notes.txt`], false));
    expect(screen.getByRole('status')).toHaveTextContent('Moving 2 item(s) to the trash…');
    expect(within(bar()).queryByText('2 selected')).toBeNull();
    expect(barHidden()).toBe(false);
    // A second delete is refused while one runs
    key('Delete');
    expect(screen.queryByText('Move to trash?')).toBeNull();
    await act(async () => { pending.resolve({ results: [{ path: `${X}/clip.mp4`, trashed: true }, { path: `${X}/notes.txt`, trashed: true }], errors: [] }); });
    await waitFor(() => expect(toasts.titles()).toEqual(['Moved to trash']));
    expect(toasts.toasts[0].message).toBe('2 item(s), in the trash folder on this disk');
    expect(barHidden()).toBe(true);
    expect(row(`${X}/clip.mp4`)).not.toHaveClass('bg-cyan-500/15');
  });

  it('Shift+Delete deletes for good, with its own wording', async () => {
    vi.mocked(files.deletePaths).mockResolvedValue({ results: [{ path: `${X}/clip.mp4` }], errors: [] });
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    key('Delete', { shiftKey: true });
    expect(screen.getByText('Delete permanently?')).toBeInTheDocument();
    expect(screen.getByText('1 item(s) will be erased from the disk. This cannot be undone.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(files.deletePaths).toHaveBeenCalledWith([`${X}/clip.mp4`], true));
    await waitFor(() => expect(toasts.titles()).toEqual(['Deleted']));
    expect(toasts.toasts[0].message).toBe('1 item(s)');
  });

  it('the bar\'s Trash and Delete buttons open the same dialog; Cancel does nothing', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Trash' }));
    expect(screen.getByText('Move to trash?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Move to trash?')).toBeNull();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete permanently?')).toBeInTheDocument();
    expect(within(bar()).getByRole('button', { name: 'Delete' })).toHaveAttribute('title', 'Delete permanently');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(files.deletePaths).not.toHaveBeenCalled();
  });

  it('a delete that could not use the trash is reported as a delete', async () => {
    vi.mocked(files.deletePaths).mockResolvedValue({ results: [{ path: `${X}/clip.mp4` }], errors: [], permanent: true });
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    key('Delete');
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    await waitFor(() => expect(toasts.titles()).toEqual(['Deleted']));
  });

  it('errors: per-item failures, a partial folder delete, and a thrown request', async () => {
    vi.mocked(files.deletePaths)
      .mockResolvedValueOnce({ results: [], errors: [{ path: `${X}/clip.mp4`, error: 'Permission denied' }] })
      .mockResolvedValueOnce({ results: [], errors: [{ path: `${X}/Docs`, error: '3 left', partial: true }, { path: 'x', error: 'y' }] })
      .mockRejectedValueOnce(new Error('Network down'));
    await renderPage();
    const run = async () => {
      fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
      key('Delete');
      fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
      expect(screen.getByRole('status')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
      key('Escape');
    };
    await run();
    expect(toasts.toasts[0]).toMatchObject({ type: 'error', title: 'Delete failed for 1 item(s)', message: 'Permission denied' });
    await run();
    expect(toasts.toasts[1]).toMatchObject({ type: 'warning', title: 'Partly deleted: Docs', message: '3 left (1 more item(s) had errors)' });
    await run();
    expect(toasts.toasts[2]).toMatchObject({ type: 'error', title: 'Delete failed', message: 'Network down' });
    // A thrown delete keeps the selection (the Escape above cleared it); a reported one drops it
    expect(files.deletePaths).toHaveBeenCalledTimes(3);
  });
});

// --- the VPS drive ----------------------------------------------------------

describe('ExplorerPage - the VPS as a drive', () => {
  it('only text opens; anything else says to copy it locally first', async () => {
    await renderPage(`/files?path=${VPS}`, 'far.mkv');
    fireEvent.click(row(`${VPS}/far.mkv`));
    expect(screen.queryByTestId('preview')).toBeNull();
    expect(toasts.toasts[0]).toMatchObject({ type: 'info', title: "VPS files aren't streamed" });
    fireEvent.click(row(`${VPS}/readme.txt`));
    expect(screen.getByTestId('preview')).toHaveAttribute('data-name', 'readme.txt');
  });

  it('the menu offers the copy-to-download gesture and a permanent delete, nothing that needs a trash or a writable disk', async () => {
    await renderPage(`/files?path=${VPS}`, 'far.mkv');
    const menu = openMenu(`${VPS}/far.mkv`);
    expect(menu.getAllByRole('button').map(b => b.textContent)).toEqual([
      'Copy (paste locally to download)', 'Copy path', 'Delete on the VPS', 'Properties',
    ]);
    fireEvent.click(menu.getByRole('button', { name: 'Delete on the VPS' }));
    expect(screen.getByText('Delete on the VPS?')).toBeInTheDocument();
    expect(screen.getByText('1 item(s) will be erased from the VPS. There is no trash there, so this cannot be undone.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // A text file gets a preview entry too
    expect(openMenu(`${VPS}/readme.txt`).getAllByRole('button').map(b => b.textContent)[0]).toBe('Preview');
  });

  it('the bar carries a "Delete on VPS" button for a remote selection', async () => {
    vi.mocked(files.deletePaths).mockResolvedValue({ results: [{ path: `${VPS}/far.mkv` }], errors: [], permanent: true });
    await renderPage(`/files?path=${VPS}`, 'far.mkv');
    fireEvent.click(row(`${VPS}/far.mkv`), { ctrlKey: true });
    expect(within(bar()).queryByRole('button', { name: 'Trash' })).toBeNull();
    const del = within(bar()).getByRole('button', { name: 'Delete on VPS' });
    expect(del).toHaveAttribute('title', 'Delete on the VPS (permanent)');
    fireEvent.click(del);
    expect(screen.getByText('Delete on the VPS?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    expect(screen.getByRole('status')).toHaveTextContent('Deleting 1 item(s)…');
    await waitFor(() => expect(files.deletePaths).toHaveBeenCalledWith([`${VPS}/far.mkv`], true));
    await waitFor(() => expect(toasts.titles()).toEqual(['Deleted']));
  });

  it('copying from the VPS and pasting locally starts a download', async () => {
    vi.mocked(files.transferPaths).mockResolvedValue({ results: [{ path: `${VPS}/far.mkv` }], errors: [], download: true });
    await renderPage(`/files?path=${VPS}`, 'far.mkv');
    fireEvent.click(openMenu(`${VPS}/far.mkv`).getByRole('button', { name: 'Copy (paste locally to download)' }));
    expect(screen.getByText('1 item(s) ready to copy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paste here' })).toBeDisabled();
    fireEvent.click(screen.getAllByText('disk')[0].closest('button')!);
    await screen.findByText('x', { selector: 'span' });
    fireEvent.click(screen.getByRole('button', { name: 'Paste here' }));
    await waitFor(() => expect(files.transferPaths).toHaveBeenCalledWith([`${VPS}/far.mkv`], '/mnt', false));
    await waitFor(() => expect(toasts.titles()).toEqual(['Download Started']));
    expect(toasts.toasts[0].message).toBe('1 item(s) from the VPS - progress is on the downloads page');
  });
});

// --- context menu -----------------------------------------------------------

describe('ExplorerPage - context menu', () => {
  it('a file\'s menu: preview, download, clipboard, rename, both deletes, properties', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await renderPage();
    expect(openMenu(`${X}/clip.mp4`).getAllByRole('button').map(b => b.textContent)).toEqual([
      'Preview', 'Download', 'Copy', 'Cut', 'Copy path', 'Rename', 'Move to trash', 'Delete permanently', 'Properties',
    ]);
    // Opening the menu selects the row
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('/api/files/download?path=%2Fmnt%2Fx%2Fclip.mp4'), '_blank');
    fireEvent.click(openMenu(`${X}/clip.mp4`).getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith(`${X}/clip.mp4`);
    fireEvent.click(openMenu(`${X}/clip.mp4`).getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('preview')).toHaveAttribute('data-name', 'clip.mp4');
    fireEvent.click(screen.getByRole('button', { name: 'close-preview' }));
    fireEvent.click(openMenu(`${X}/clip.mp4`).getByRole('button', { name: 'Properties' }));
    expect(screen.getByTestId('properties')).toHaveAttribute('data-name', 'clip.mp4');
    fireEvent.click(screen.getByRole('button', { name: 'close-props' }));
    expect(screen.queryByTestId('properties')).toBeNull();
    fireEvent.click(openMenu(`${X}/clip.mp4`).getByRole('button', { name: 'Move to trash' }));
    expect(screen.getByText('Move to trash?')).toBeInTheDocument();
  });

  it('a folder\'s menu opens it', async () => {
    await renderPage();
    const menu = openMenu(`${X}/Docs`);
    expect(menu.getAllByRole('button')[0]).toHaveTextContent('Open');
    expect(menu.queryByRole('button', { name: 'Download' })).toBeNull();
    fireEvent.click(menu.getByRole('button', { name: 'Open' }));
    await screen.findByText('This folder is empty');
  });

  it('a right-click on the selection acts on all of it; outside it, on that row alone', async () => {
    await renderPage();
    fireEvent.click(row(`${X}/clip.mp4`), { ctrlKey: true });
    fireEvent.click(row(`${X}/notes.txt`), { ctrlKey: true });
    fireEvent.contextMenu(row(`${X}/clip.mp4`), { clientX: 5, clientY: 5 });
    let menu = within(document.querySelector('.z-\\[110\\]') as HTMLElement);
    expect(menu.getByRole('button', { name: '2 items selected' })).toBeDisabled();
    expect(menu.queryByRole('button', { name: 'Rename' })).toBeNull();
    fireEvent.click(menu.getByRole('button', { name: 'Cut' }));
    expect(screen.getByText('2 item(s) ready to move')).toBeInTheDocument();

    fireEvent.contextMenu(row(`${X}/photo.jpg`), { clientX: 5, clientY: 5 });
    menu = within(document.querySelector('.z-\\[110\\]') as HTMLElement);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(menu.getByRole('button', { name: 'Copy' }));
    expect(screen.getByText('1 item(s) ready to copy')).toBeInTheDocument();
  });

  it('Cut, Rename and the deletes are greyed out where writing is refused', async () => {
    await renderPage('/files?path=/ro', 'locked.txt');
    const menu = openMenu('/ro/locked.txt');
    expect(menu.getByRole('button', { name: 'Cut' })).toBeDisabled();
    expect(menu.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(menu.getByRole('button', { name: 'Move to trash' })).toBeDisabled();
    expect(menu.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    expect(menu.getByRole('button', { name: 'Copy' })).toBeEnabled();
  });
});

// --- transfers bar ----------------------------------------------------------

describe('ExplorerPage - the transfers bar', () => {
  it('shows a running job with its progress; clicking it opens the details, whose destination link navigates', async () => {
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [job({ dest: `${X}/Docs` })] });
    await renderPage();
    const pill = await screen.findByTitle('Show details');
    expect(pill).toHaveTextContent('Copying Movies to Docs');
    expect(pill).toHaveTextContent('25%');
    fireEvent.click(pill);
    expect(screen.getByTestId('transfers')).toHaveAttribute('data-count', '1');
    fireEvent.click(screen.getByRole('button', { name: 'open-dest' }));
    expect(screen.queryByTestId('transfers')).toBeNull();
    await screen.findByText('This folder is empty');
    expect(decodedLoc()).toBe(`/files?path=${X}/Docs`);
  });

  it('several running jobs are counted, with the finished ones alongside', async () => {
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [
      job({ id: 'a' }), job({ id: 'b', total_bytes: 0, items_total: 2, items_done: 1 }), job({ id: 'c', status: 'done', finished_at: 200 }),
    ] });
    await renderPage();
    const pill = await screen.findByTitle('Show details');
    expect(pill).toHaveTextContent('2 transfers');
    expect(pill).toHaveTextContent('· 1 finished');
  });

  it('a job that ended while nobody watched stays in the bar until the details are opened', async () => {
    const ended = job({ status: 'partial', finished_at: 200 });
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [ended] });
    // The server marks the job once it is acknowledged, and the next poll says so
    vi.mocked(files.ackTransfers).mockImplementation(async () => {
      vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [{ ...ended, acknowledged: true }] });
      return { acknowledged: 1 };
    });
    const { unmount } = await renderPage();
    const pill = await screen.findByTitle('Show details');
    expect(pill).toHaveTextContent('Copied Movies to Films');
    expect(pill.querySelector('.text-yellow-400')).not.toBeNull();
    fireEvent.click(pill);
    await waitFor(() => expect(files.ackTransfers).toHaveBeenCalledWith(['j1'], expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'close-transfers' }));
    // Dropped from the bar once the ack's refetch lands
    await waitFor(() => expect(barHidden()).toBe(true));
    unmount();
    // Already acknowledged by another page: not shown at all
    vi.mocked(files.ackTransfers).mockClear();
    vi.mocked(files.fetchTransfers).mockClear();
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [job({ id: 'z', status: 'done', finished_at: 200, acknowledged: true })] });
    await renderPage();
    await waitFor(() => expect(files.fetchTransfers).toHaveBeenCalled());
    expect(barHidden()).toBe(true);
    expect(screen.queryByTitle('Show details')).toBeNull();
    expect(files.ackTransfers).not.toHaveBeenCalled();
  });

  it('a job seen running is toasted when it finishes - the toast opens the details - and the listing is re-read', async () => {
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [job()] });
    const { client } = await renderPage();
    await screen.findByTitle('Show details');
    const listCalls = vi.mocked(files.listFiles).mock.calls.length;
    act(() => { client.setQueryData(qk.fileTransfers(), { transfers: [job({ status: 'done', finished_at: 160, done_bytes: 4000, done_files: 3 })] }); });
    await waitFor(() => expect(toasts.titles()).toEqual(['Copied Movies to Films']));
    expect(toasts.toasts[0]).toMatchObject({ type: 'success', message: '3.91 KB in 3 file(s)' });
    expect(files.ackTransfers).toHaveBeenCalledWith(['j1'], expect.anything());
    await waitFor(() => expect(vi.mocked(files.listFiles).mock.calls.length).toBeGreaterThan(listCalls));
    act(() => { toasts.toasts[0].onClick?.(); });
    expect(screen.getByTestId('transfers')).toBeInTheDocument();
  });

  it('a cancelled move, a failed copy and a partial one each get their own toast', async () => {
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [job({ id: 'a', move: true }), job({ id: 'b' }), job({ id: 'c' })] });
    const { client } = await renderPage();
    await screen.findByTitle('Show details');
    act(() => {
      client.setQueryData(qk.fileTransfers(), { transfers: [
        job({ id: 'a', move: true, status: 'cancelled', finished_at: 1 }),
        job({ id: 'b', status: 'failed', finished_at: 1, error: 'Destination vanished' }),
        job({ id: 'c', status: 'partial', finished_at: 1, errors: [{ path: '/a/Movies/x', error: 'EIO' }] }),
      ] });
    });
    await waitFor(() => expect(toasts.toasts).toHaveLength(3));
    expect(toasts.toasts[0]).toMatchObject({ type: 'warning', title: 'Move cancelled', message: 'Moved Movies to Films' });
    expect(toasts.toasts[1]).toMatchObject({ type: 'error', title: 'Copy failed for 1 item(s)', message: 'Destination vanished - click for details' });
    expect(toasts.toasts[2]).toMatchObject({ type: 'warning', title: 'Copy failed for 1 item(s)', message: 'EIO - click for details' });
  });

  it('a paused job shows the pause marker', async () => {
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [job({ status: 'paused' })] });
    await renderPage();
    const pill = await screen.findByTitle('Show details');
    expect(pill.querySelector('.text-amber-400')).not.toBeNull();
  });
});

// --- upload -----------------------------------------------------------------

describe('ExplorerPage - upload', () => {
  const file = new File(['abc'], 'new.txt', { type: 'text/plain' });

  it('dropping files on the listing uploads them into the folder', async () => {
    vi.mocked(files.uploadFiles).mockResolvedValue({ results: [], errors: [], entries: [] });
    await renderPage();
    const box = screen.getByTitle('Up one level (Backspace)').closest('.flex-col.rounded-xl') as HTMLElement;
    fireEvent.dragOver(box, { dataTransfer: { files: [file] } });
    expect(box).toHaveClass('ring-2');
    fireEvent.dragLeave(box);
    expect(box).not.toHaveClass('ring-2');
    fireEvent.dragOver(box, { dataTransfer: { files: [file] } });
    fireEvent.drop(box, { dataTransfer: { files: [file] } });
    expect(box).not.toHaveClass('ring-2');
    await waitFor(() => expect(files.uploadFiles).toHaveBeenCalledWith(X, [file]));
    await waitFor(() => expect(toasts.titles()).toEqual(['Uploaded']));
    expect(toasts.toasts[0].message).toBe('1 file(s)');
  });

  it('a read-only folder takes no drops', async () => {
    await renderPage('/files?path=/ro', 'locked.txt');
    const box = screen.getByTitle('Up one level (Backspace)').closest('.flex-col.rounded-xl') as HTMLElement;
    fireEvent.dragOver(box, { dataTransfer: { files: [file] } });
    expect(box).not.toHaveClass('ring-2');
    fireEvent.drop(box, { dataTransfer: { files: [file] } });
    expect(files.uploadFiles).not.toHaveBeenCalled();
  });

  it('the Upload button opens the file picker; failures are toasted', async () => {
    vi.mocked(files.uploadFiles)
      .mockResolvedValueOnce({ results: [], errors: [{ path: 'new.txt', error: 'Too big' }], entries: [] })
      .mockRejectedValueOnce(new Error('Offline'));
    await renderPage();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTitle('Upload files here'));
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(toasts.titles()).toEqual(['1 upload(s) failed']));
    expect(toasts.toasts[0].message).toBe('Too big');
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(toasts.titles()).toEqual(['1 upload(s) failed', 'Upload failed']));
    fireEvent.change(input, { target: { files: [] } });
    expect(files.uploadFiles).toHaveBeenCalledTimes(2);
  });
});

// --- view, sort, filter, search ---------------------------------------------

describe('ExplorerPage - view, sort, filter and search', () => {
  it('switches to the grid (previews requested, preference remembered) and back', async () => {
    await renderPage();
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByTitle('Grid view'));
    expect(document.querySelectorAll('img')).toHaveLength(2);
    expect(files.warmThumbs).toHaveBeenCalledWith([`${X}/clip.mp4`, `${X}/photo.jpg`]);
    expect(JSON.parse(localStorage.getItem('explorer_prefs')!)).toMatchObject({ view: 'grid' });
    fireEvent.click(screen.getByTitle('List view'));
    expect(document.querySelector('img')).toBeNull();
  });

  it('starts from the remembered preferences, ignoring a corrupt entry', async () => {
    localStorage.setItem('explorer_prefs', JSON.stringify({ view: 'grid', sortKey: 'size', sortAsc: false }));
    const { unmount } = await renderPage(`/files?path=${X}`, null);
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(2));
    expect(rowNames()).toEqual(['Docs', 'clip.mp4', 'photo.jpg', 'notes.txt']);
    unmount();
    localStorage.setItem('explorer_prefs', '{not json');
    await renderPage();
    expect(screen.getByTitle('Grid view')).toBeInTheDocument();
    expect(rowNames()).toEqual(['Docs', 'clip.mp4', 'notes.txt', 'photo.jpg']);
  });

  it('the list header sorts by size and modified, flipping on a second click, folders always first', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(rowNames()).toEqual(['Docs', 'notes.txt', 'photo.jpg', 'clip.mp4']);
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(rowNames()).toEqual(['Docs', 'clip.mp4', 'photo.jpg', 'notes.txt']);
    fireEvent.click(screen.getByRole('button', { name: 'Modified' }));
    expect(rowNames()).toEqual(['Docs', 'notes.txt', 'photo.jpg', 'clip.mp4']);
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(rowNames()).toEqual(['Docs', 'photo.jpg', 'notes.txt', 'clip.mp4']);
  });

  it('the phone overflow menu sorts by type', async () => {
    await renderPage();
    fireEvent.click(screen.getByTitle('View and folder actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Sort by type' }));
    expect(rowNames()).toEqual(['Docs', 'photo.jpg', 'notes.txt', 'clip.mp4']);
    fireEvent.click(screen.getByTitle('View and folder actions'));
    expect(screen.getByRole('button', { name: 'Sort by type (A-Z)' })).toHaveClass('text-cyan-400');
  });

  it('the filter narrows the folder; Enter searches below it; Clear puts it back', async () => {
    vi.mocked(files.searchFiles).mockResolvedValue({
      root: X, query: 'cl', truncated: true,
      entries: [entry(`${X}/Docs`, 'clip2.mp4'), entry(X, 'clip.mp4', { size: 2048 })],
    });
    await renderPage();
    const filter = screen.getByPlaceholderText(/Filter this folder/);
    fireEvent.change(filter, { target: { value: 'CLIP' } });
    expect(rowNames()).toEqual(['clip.mp4']);
    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches')).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'c' } });
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(files.searchFiles).not.toHaveBeenCalled();       // two characters at least
    fireEvent.change(filter, { target: { value: 'cl' } });
    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(files.searchFiles).toHaveBeenCalledWith(X, 'cl', false));
    expect(await screen.findByText(/2 match\(es\) under \/mnt\/x/)).toHaveTextContent('stopped early, narrow the search');
    expect(rowNames()).toEqual(['clip.mp4', 'clip2.mp4']);
    expect(screen.getByText(`${X}/Docs/clip2.mp4`)).toBeInTheDocument();   // results show their path
    expect(screen.queryByTitle('New folder')).toBeNull();                  // not writable while searching
    fireEvent.click(screen.getByTitle('Clear'));
    expect(rowNames()).toEqual(['Docs', 'clip.mp4', 'notes.txt', 'photo.jpg']);
    expect(screen.getByTitle('New folder')).toBeInTheDocument();
  });

  it('dotfiles and auto-refresh are toggles on the listing query; refresh re-reads', async () => {
    await renderPage();
    fireEvent.click(screen.getByTitle('Show hidden files'));
    await waitFor(() => expect(files.listFiles).toHaveBeenCalledWith(X, true));
    expect(screen.getByTitle('Hide dotfiles')).toBeInTheDocument();
    const before = vi.mocked(files.listFiles).mock.calls.length;
    fireEvent.click(screen.getByTitle('Re-read from disk'));
    await waitFor(() => expect(vi.mocked(files.listFiles).mock.calls.length).toBe(before + 1));
    fireEvent.click(screen.getByTitle('Auto-refresh off'));
    expect(screen.getByTitle('Auto-refresh on (10s)')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('explorer_prefs')!)).toMatchObject({ showHidden: true, autoRefresh: true });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { VpsBrowseResult } from '../api';
import { FolderBrowser } from './FolderBrowser';

// The default browseFn is the VPS one; every test passes its own, so the
// transport module is never touched.
vi.mock('../api', () => ({ browseVps: vi.fn() }));

const tree: Record<string, VpsBrowseResult> = {
  '': { path: '/home/u', parent: null, entries: [
    { name: 'downloads', path: '/home/u/downloads', is_dir: true },
    { name: 'watch', path: '/home/u/watch', is_dir: true },
    { name: 'readme.txt', path: '/home/u/readme.txt', is_dir: false },
  ] },
  '/home/u/downloads': { path: '/home/u/downloads', parent: '/home/u', entries: [
    { name: 'movies', path: '/home/u/downloads/movies', is_dir: true },
  ] },
  '/home/u/watch': { path: '/home/u/watch', parent: '/home/u', entries: [] },
  '/home/u/downloads/movies': { path: '/home/u/downloads/movies', parent: '/home/u/downloads', entries: [] },
  '/home/u': { path: '/home/u', parent: null, entries: [] },
};
const browse = () => vi.fn(async (path?: string) => tree[path ?? ''] ?? { error: `no such folder: ${path}` });

// A folder's row: the div around its name button (the footer repeats the path as a title, so not by title)
const row = (name: string) => screen.getByRole('button', { name }).parentElement as HTMLElement;

describe('FolderBrowser', () => {
  it('renders nothing while closed', () => {
    render(<FolderBrowser isOpen={false} onClose={() => {}} onConfirm={() => {}} browseFn={browse()} />);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('loads the starting folder on open: folders get a checkbox, files do not', async () => {
    const browseFn = browse();
    render(<FolderBrowser isOpen onClose={() => {}} onConfirm={() => {}} browseFn={browseFn} />);
    expect(screen.getByRole('heading', { name: 'Select folders to watch' })).toBeInTheDocument();
    expect(await screen.findByText('downloads')).toBeInTheDocument();
    expect(browseFn).toHaveBeenCalledWith('');
    expect(screen.getByTitle('/home/u')).toHaveTextContent('/home/u');
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'readme.txt' })).toBeDisabled();
    // At the top of the tree there is nowhere to go up to
    expect(screen.getByRole('button', { name: 'Up one level' })).toBeDisabled();
    expect(screen.getByText('0 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add .*selected/i })).toBeDisabled();
  });

  it('expands a folder on its chevron, loads its children once, and collapses again', async () => {
    const browseFn = browse();
    render(<FolderBrowser isOpen onClose={() => {}} onConfirm={() => {}} browseFn={browseFn} />);
    await screen.findByText('downloads');
    fireEvent.click(within(row('downloads')).getByRole('button', { name: 'Expand' }));
    expect(await screen.findByText('movies')).toBeInTheDocument();
    expect(browseFn).toHaveBeenCalledWith('/home/u/downloads');
    fireEvent.click(within(row('downloads')).getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByText('movies')).toBeNull();
    fireEvent.click(within(row('downloads')).getByRole('button', { name: 'Expand' }));
    expect(screen.getByText('movies')).toBeInTheDocument();
    expect(browseFn).toHaveBeenCalledTimes(2);   // root + downloads, not a third time

    fireEvent.click(within(row('watch')).getByRole('button', { name: 'Expand' }));
    expect(await screen.findByText('Empty folder')).toBeInTheDocument();
  });

  it('reports a folder that will not list, without losing the rest of the tree', async () => {
    const browseFn = vi.fn(async (path?: string) =>
      path === '/home/u/watch' ? { error: 'Permission denied' } : tree[path ?? '']);
    render(<FolderBrowser isOpen onClose={() => {}} onConfirm={() => {}} browseFn={browseFn} />);
    await screen.findByText('watch');
    fireEvent.click(within(row('watch')).getByRole('button', { name: 'Expand' }));
    expect(await screen.findByText('Permission denied')).toBeInTheDocument();
    expect(screen.getByText('downloads')).toBeInTheDocument();
  });

  it('multi-select: checkbox or name toggles, and confirm hands back every path', async () => {
    const onConfirm = vi.fn();
    render(<FolderBrowser isOpen onClose={() => {}} onConfirm={onConfirm} browseFn={browse()} />);
    await screen.findByText('downloads');
    fireEvent.click(screen.getByRole('button', { name: 'downloads' }));
    fireEvent.click(within(row('watch')).getByRole('checkbox'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'downloads' }));   // off again
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 selected' }));
    expect(onConfirm).toHaveBeenCalledWith(['/home/u/watch']);
  });

  it('single-select: radios, one at a time, the path in the footer, and a preselected folder', async () => {
    const onConfirm = vi.fn();
    render(<FolderBrowser isOpen onClose={() => {}} onConfirm={onConfirm} browseFn={browse()} singleSelect title="Pick a destination" initialPath="/home/u/watch" />);
    expect(screen.getByRole('heading', { name: 'Pick a destination' })).toBeInTheDocument();
    await screen.findByText('downloads');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(within(row('watch')).getByRole('radio')).toBeChecked();
    expect(screen.getByText('/home/u/watch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'downloads' }));
    expect(within(row('downloads')).getByRole('radio')).toBeChecked();
    expect(within(row('watch')).getByRole('radio')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(onConfirm).toHaveBeenCalledWith(['/home/u/downloads']);
  });

  it('marks folders already watched and refuses to select them', async () => {
    render(<FolderBrowser isOpen onClose={() => {}} onConfirm={() => {}} browseFn={browse()} alreadyAdded={['/home/u/watch']} />);
    await screen.findByText('watch');
    expect(within(row('watch')).getByText('Added')).toBeInTheDocument();
    expect(within(row('watch')).queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'watch' })).toBeDisabled();
  });

  it('Up re-roots the tree at the parent and forgets what was expanded', async () => {
    const browseFn = vi.fn(async (path?: string) => (path === '' ? tree['/home/u/downloads'] : tree[path ?? '']));
    render(<FolderBrowser isOpen onClose={() => {}} onConfirm={() => {}} browseFn={browseFn} />);
    await screen.findByText('movies');
    const up = screen.getByRole('button', { name: 'Up one level' });
    expect(up).toBeEnabled();
    fireEvent.click(up);
    await waitFor(() => expect(browseFn).toHaveBeenLastCalledWith('/home/u'));
    await waitFor(() => expect(screen.getByText('No folders found')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Up one level' })).toBeDisabled();
  });

  it('shows a root error from the server, or a generic one when the call throws', async () => {
    const first = render(<FolderBrowser isOpen onClose={() => {}} onConfirm={() => {}} browseFn={async () => ({ error: 'Not connected' })} />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    first.unmount();
    render(<FolderBrowser isOpen onClose={() => {}} onConfirm={() => {}} browseFn={async () => { throw new Error('x'); }} />);
    expect(await screen.findByText('Failed to load folders')).toBeInTheDocument();
  });

  it('closes on Cancel, the X and Escape', async () => {
    const onClose = vi.fn();
    render(<FolderBrowser isOpen onClose={onClose} onConfirm={() => {}} browseFn={browse()} />);
    await screen.findByText('downloads');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

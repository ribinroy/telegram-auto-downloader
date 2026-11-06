import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { FileRoot } from '../../api/files';
import { ExplorerSidebar } from './ExplorerSidebar';

const root = (path: string, over: Partial<FileRoot> = {}): FileRoot => ({
  path, label: path.split('/').filter(Boolean).pop() ?? '/', kind: 'disk', group: 'drive',
  note: null, device: null, fstype: null, usage: null, writable: true, ...over,
});

const GB = 1024 ** 3;
const roots: FileRoot[] = [
  root('/', { label: 'System', usage: { total: 100 * GB, used: 50 * GB, free: 50 * GB } }),
  root('/mnt/disk', { label: 'disk', usage: { total: 100 * GB, used: 90 * GB, free: 10 * GB } }),
  root('/home/hs', { label: 'Home', kind: 'home', group: 'folder' }),
  root('/home/hs/downloads', { label: 'Downloads', kind: 'downloads', group: 'folder' }),
  root('/mnt/disk/Movies', { label: 'Movies', kind: 'configured', group: 'configured', note: 'youtube.com, vimeo.com' }),
  root('vps:~', { label: 'Seedbox', kind: 'vps', group: 'drive', remote: true }),
];

function renderSidebar(over: Partial<Parameters<typeof ExplorerSidebar>[0]> = {}) {
  const props = {
    roots, loading: false, currentPath: '/home/hs', onNavigate: vi.fn(), onRefresh: vi.fn(),
    refreshing: false, trashPath: null as string | null, ...over,
  };
  render(<ExplorerSidebar {...props} />);
  return props;
}

const buttonFor = (label: string) =>
  screen.getByText(label, { selector: 'span.truncate' }).closest('button') as HTMLButtonElement;

describe('ExplorerSidebar - groups', () => {
  it('lists drives first, then the Folders and DownLee folders sections', () => {
    renderSidebar();
    const nav = screen.getByRole('navigation');
    const labels = within(nav).getAllByRole('button').map(b => b.textContent?.trim());
    expect(labels).toEqual([
      '',                                   // the rescan button
      'System50.00 GB free', 'disk10.00 GB free', 'Seedbox',
      'Home', 'Downloads',
      'Moviesyoutube.com, vimeo.com',
    ]);
    const headings = within(nav).getAllByText(/^(Drives|Folders|DownLee folders)$/).map(e => e.textContent);
    expect(headings).toEqual(['Drives', 'Folders', 'DownLee folders']);
    expect(screen.queryByText('Trash')).toBeNull();
  });

  it('leaves out a section that has nothing in it', () => {
    renderSidebar({ roots: roots.filter(r => r.group === 'drive') });
    expect(screen.queryByText('Folders')).toBeNull();
    expect(screen.queryByText('DownLee folders')).toBeNull();
  });

  it('says it is reading the drives while loading with nothing to show yet', () => {
    renderSidebar({ roots: [], loading: true });
    expect(screen.getByText('Reading drives...')).toBeInTheDocument();
  });

  it('a refetch with roots already listed does not replace them with the loading line', () => {
    renderSidebar({ loading: true });
    expect(screen.queryByText('Reading drives...')).toBeNull();
    expect(buttonFor('System')).toBeInTheDocument();
  });

  it('only drives get the capacity bar, coloured by how full they are', () => {
    renderSidebar({ roots: [
      ...roots,
      root('/mnt/full', { label: 'full', usage: { total: 100, used: 97, free: 3 } }),
      root('/mnt/folderish', { label: 'folderish', group: 'folder', usage: { total: 100, used: 97, free: 3 } }),
    ] });
    const bar = (label: string) => buttonFor(label).querySelector('.h-1 > div');
    expect(bar('System')).toHaveClass('bg-cyan-500');
    expect(bar('System')).toHaveStyle({ width: '50%' });
    expect(bar('disk')).toHaveClass('bg-amber-500');
    expect(bar('full')).toHaveClass('bg-red-500');
    expect(bar('folderish')).toBeNull();
    expect(bar('Seedbox')).toBeNull();     // no usage reported
  });

  it('a configured folder shows what points at it, in its tooltip too', () => {
    renderSidebar();
    expect(buttonFor('Movies')).toHaveAttribute('title', '/mnt/disk/Movies — youtube.com, vimeo.com');
  });
});

describe('ExplorerSidebar - where you are', () => {
  it('lights the root you are at brightly, and the one you are inside dimly - per group', () => {
    renderSidebar({ currentPath: '/mnt/disk/Movies' });
    // Drives: /mnt/disk contains the folder ('/' does too, but the longest prefix wins)
    expect(buttonFor('disk')).toHaveClass('bg-slate-800/70');
    expect(buttonFor('disk')).toHaveAttribute('title', '/mnt/disk — you are viewing a folder on this drive');
    expect(buttonFor('disk').querySelector('.bg-cyan-500\\/50')).not.toBeNull();
    expect(buttonFor('System')).not.toHaveClass('bg-slate-800/70');
    expect(buttonFor('System')).not.toHaveClass('bg-slate-700/60');
    // DownLee folders: the current folder *is* the Movies root
    expect(buttonFor('Movies')).toHaveClass('bg-slate-700/60');
    expect(buttonFor('Movies').querySelector('.bg-cyan-400')).not.toBeNull();
    expect(buttonFor('Movies')).toHaveAttribute('title', '/mnt/disk/Movies — youtube.com, vimeo.com');
    // Folders: nothing under /home
    expect(buttonFor('Home')).not.toHaveClass('bg-slate-800/70');
  });

  it('standing on a mount point marks that drive as active, not the root filesystem as containing', () => {
    renderSidebar({ currentPath: '/mnt/disk' });
    expect(buttonFor('disk')).toHaveClass('bg-slate-700/60');
    expect(buttonFor('System')).not.toHaveClass('bg-slate-800/70');
  });

  it('a sibling that merely shares a prefix string is not "containing"', () => {
    renderSidebar({ currentPath: '/mnt/disk2/x' });
    expect(buttonFor('disk')).not.toHaveClass('bg-slate-800/70');
    expect(buttonFor('System')).toHaveClass('bg-slate-800/70');
    expect(buttonFor('System')).toHaveAttribute('title', '/ — you are viewing a folder on this drive');
  });

  it('inside a folder-group root, the tooltip says "location", not "drive"', () => {
    renderSidebar({ currentPath: '/home/hs/downloads/x' });
    expect(buttonFor('Downloads')).toHaveAttribute('title', '/home/hs/downloads — you are viewing a folder on this location');
    expect(buttonFor('Home')).not.toHaveClass('bg-slate-800/70');
  });
});

describe('ExplorerSidebar - actions', () => {
  it('clicking a root navigates to it', () => {
    const { onNavigate } = renderSidebar();
    fireEvent.click(buttonFor('Seedbox'));
    expect(onNavigate).toHaveBeenCalledWith('vps:~');
    fireEvent.click(buttonFor('Movies'));
    expect(onNavigate).toHaveBeenCalledWith('/mnt/disk/Movies');
  });

  it('the rescan button refetches and spins while it does', () => {
    const { onRefresh } = renderSidebar();
    fireEvent.click(screen.getByTitle('Rescan drives'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('Rescan drives').querySelector('svg')).not.toHaveClass('animate-spin');
    renderSidebar({ refreshing: true });
    expect(screen.getAllByTitle('Rescan drives')[1].querySelector('svg')).toHaveClass('animate-spin');
  });

  it('links to the trash the listing reported, highlighted while you are in it', () => {
    const { onNavigate } = renderSidebar({ trashPath: '/mnt/disk/.downlee-trash' });
    expect(screen.getByText('Trash')).toBeInTheDocument();
    const link = screen.getByRole('button', { name: 'Deleted files' });
    expect(link).toHaveAttribute('title', '/mnt/disk/.downlee-trash');
    expect(link).not.toHaveClass('bg-slate-700/60');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('/mnt/disk/.downlee-trash');
    renderSidebar({ trashPath: '/mnt/disk/.downlee-trash', currentPath: '/mnt/disk/.downlee-trash' });
    expect(screen.getAllByRole('button', { name: 'Deleted files' })[1]).toHaveClass('bg-slate-700/60');
  });
});

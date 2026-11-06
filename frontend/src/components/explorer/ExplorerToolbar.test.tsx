import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ExplorerToolbar } from './ExplorerToolbar';

type Props = Parameters<typeof ExplorerToolbar>[0];

function renderToolbar(over: Partial<Props> = {}) {
  const props: Props = {
    path: '/mnt/disk/Movies', parent: '/mnt/disk', usage: null, writable: true, filter: '', searchQuery: null,
    view: 'list', sortKey: 'name', sortAsc: true, showHidden: false, autoRefresh: false, refreshing: false,
    onNavigate: vi.fn(), onFilterChange: vi.fn(), onSearch: vi.fn(), onClearSearch: vi.fn(), onViewChange: vi.fn(),
    onSortChange: vi.fn(), onToggleHidden: vi.fn(), onToggleAutoRefresh: vi.fn(), onRefresh: vi.fn(),
    onNewFolder: vi.fn(), onUpload: vi.fn(), ...over,
  };
  const view = render(<ExplorerToolbar {...props} />);
  return { ...view, props };
}

const filterBox = () => screen.getByPlaceholderText(/Filter this folder|Results for/) as HTMLInputElement;

describe('ExplorerToolbar - path row', () => {
  it('renders the crumbs and navigates on a click', () => {
    const { props } = renderToolbar();
    const crumbs = screen.getAllByRole('button').filter(b => ['/', 'mnt', 'disk', 'Movies'].includes(b.textContent ?? ''));
    expect(crumbs.map(b => b.textContent)).toEqual(['/', 'mnt', 'disk', 'Movies']);
    expect(crumbs[3]).toHaveClass('text-white');       // the folder you are in
    expect(crumbs[2]).not.toHaveClass('text-white');
    fireEvent.click(crumbs[1]);
    expect(props.onNavigate).toHaveBeenCalledWith('/mnt');
    fireEvent.click(crumbs[0]);
    expect(props.onNavigate).toHaveBeenCalledWith('/');
  });

  it('on the VPS the crumbs start at the login home', () => {
    const { props } = renderToolbar({ path: 'vps:/home6/tester/downloads', root: 'vps:/home6/tester', parent: 'vps:/home6/tester' });
    expect(screen.getByRole('button', { name: 'tester' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'home6' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'downloads' }));
    expect(props.onNavigate).toHaveBeenCalledWith('vps:/home6/tester/downloads');
    fireEvent.click(screen.getByRole('button', { name: 'tester' }));
    expect(props.onNavigate).toHaveBeenCalledWith('vps:/home6/tester');
  });

  it('the Up button goes to the parent and is disabled when there is none', () => {
    const { props, unmount } = renderToolbar();
    const up = screen.getByTitle('Up one level (Backspace)');
    expect(up).toBeEnabled();
    fireEvent.click(up);
    expect(props.onNavigate).toHaveBeenCalledWith('/mnt/disk');
    unmount();
    const { props: p2 } = renderToolbar({ path: '/', parent: null });
    const up2 = screen.getByTitle('Up one level (Backspace)');
    expect(up2).toBeDisabled();
    fireEvent.click(up2);
    expect(p2.onNavigate).not.toHaveBeenCalled();
  });

  it('the pencil turns the crumbs into a path box: Enter navigates, Escape gives up', () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByTitle('Type a path'));
    const box = screen.getByDisplayValue('/mnt/disk/Movies') as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: '  /mnt/other  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(props.onNavigate).toHaveBeenCalledWith('/mnt/other');
    expect(screen.queryByDisplayValue('/mnt/other')).toBeNull();     // back to crumbs

    // The draft is kept until the path prop changes (the page navigates)
    fireEvent.click(screen.getByTitle('Type a path'));
    const again = document.querySelector('input.font-mono') as HTMLInputElement;
    expect(again.value).toBe('  /mnt/other  ');
    fireEvent.change(again, { target: { value: '/typo' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(props.onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Movies' })).toBeInTheDocument();
    // Escape put the real path back in the draft
    fireEvent.click(screen.getByTitle('Type a path'));
    expect(screen.getByDisplayValue('/mnt/disk/Movies')).toBeInTheDocument();
  });

  it('leaving the path box closes it, and a new path refreshes the draft', () => {
    const { rerender, props } = renderToolbar();
    fireEvent.click(screen.getByTitle('Type a path'));
    fireEvent.blur(screen.getByDisplayValue('/mnt/disk/Movies'));
    expect(screen.getByRole('button', { name: 'Movies' })).toBeInTheDocument();
    rerender(<ExplorerToolbar {...props} path="/srv" parent="/" />);
    fireEvent.click(screen.getByTitle('Type a path'));
    expect(screen.getByDisplayValue('/srv')).toBeInTheDocument();
  });

  it('shows the disk usage when the listing reports it', () => {
    renderToolbar({ usage: { total: 2 * 1024 ** 3, used: 1024 ** 3, free: 1024 ** 3 } });
    expect(screen.getByText('1.00 GB free of 2.00 GB')).toBeInTheDocument();
  });
});

describe('ExplorerToolbar - filter and search', () => {
  it('types into the filter, searches on Enter and clears both', () => {
    const { props, rerender } = renderToolbar();
    fireEvent.change(filterBox(), { target: { value: 'mov' } });
    expect(props.onFilterChange).toHaveBeenCalledWith('mov');
    expect(screen.queryByTitle('Clear')).toBeNull();
    fireEvent.keyDown(filterBox(), { key: 'Enter' });
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(filterBox(), { key: 'a' });
    expect(props.onSearch).toHaveBeenCalledTimes(1);

    rerender(<ExplorerToolbar {...props} filter="mov" searchQuery="mov" />);
    expect(filterBox().placeholder).toBe('Results for "mov"');
    fireEvent.click(screen.getByTitle('Clear'));
    expect(props.onFilterChange).toHaveBeenLastCalledWith('');
    expect(props.onClearSearch).toHaveBeenCalledTimes(1);
  });
});

describe('ExplorerToolbar - action buttons', () => {
  it('toggles view, dotfiles and auto-refresh, and re-reads the folder', () => {
    const { props, rerender } = renderToolbar();
    fireEvent.click(screen.getByTitle('Grid view'));
    expect(props.onViewChange).toHaveBeenCalledWith('grid');
    fireEvent.click(screen.getByTitle('Show hidden files'));
    expect(props.onToggleHidden).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle('Auto-refresh off'));
    expect(props.onToggleAutoRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle('Re-read from disk'));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('Re-read from disk').querySelector('svg')).not.toHaveClass('animate-spin');

    rerender(<ExplorerToolbar {...props} view="grid" showHidden autoRefresh refreshing />);
    fireEvent.click(screen.getByTitle('List view'));
    expect(props.onViewChange).toHaveBeenCalledWith('list');
    expect(screen.getByTitle('Hide dotfiles')).toHaveClass('text-cyan-400');
    expect(screen.getByTitle('Auto-refresh on (10s)')).toHaveClass('text-cyan-400');
    expect(screen.getByTitle('Re-read from disk').querySelector('svg')).toHaveClass('animate-spin');
  });

  it('offers New folder and Upload only where writing is allowed', () => {
    const { props, rerender } = renderToolbar();
    fireEvent.click(screen.getByTitle('New folder'));
    expect(props.onNewFolder).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTitle('Upload files here'));
    expect(props.onUpload).toHaveBeenCalledTimes(1);
    rerender(<ExplorerToolbar {...props} writable={false} />);
    expect(screen.queryByTitle('New folder')).toBeNull();
    expect(screen.queryByTitle('Upload files here')).toBeNull();
  });

  it('in grid view a sort select stands in for the list header', () => {
    const { props, rerender } = renderToolbar({ view: 'grid', sortKey: 'size', sortAsc: false });
    const select = screen.getByTitle(/^Sort by \(currently descending/) as HTMLSelectElement;
    expect(select.value).toBe('size');
    fireEvent.change(select, { target: { value: 'modified' } });
    expect(props.onSortChange).toHaveBeenCalledWith('modified');
    rerender(<ExplorerToolbar {...props} view="list" />);
    expect(screen.queryByTitle(/^Sort by \(currently/)).toBeNull();
  });
});

describe('ExplorerToolbar - the phone overflow menu', () => {
  it('opens a menu carrying the view toggle, the sorts (current one marked), the toggles and the folder actions', () => {
    const { props } = renderToolbar({ sortKey: 'modified', sortAsc: false, showHidden: true });
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByText('Grid view').closest('.fixed') as HTMLElement;
    const labels = within(menu).getAllByRole('button').map(b => b.textContent);
    expect(labels).toEqual([
      'Grid view',
      'Sort by name', 'Sort by size', 'Sort by modified (Z-A)', 'Sort by type',
      'Hide dotfiles', 'Auto-refresh off', 'Refresh now',
      'New folder', 'Upload files',
    ]);
    expect(within(menu).getByRole('button', { name: 'Sort by modified (Z-A)' })).toHaveClass('text-cyan-400');
    expect(within(menu).getByRole('button', { name: 'Sort by name' })).not.toHaveClass('text-cyan-400');
    expect(within(menu).getByRole('button', { name: 'Hide dotfiles' })).toHaveClass('text-cyan-400');
    expect(within(menu).getByRole('button', { name: 'Auto-refresh off' })).not.toHaveClass('text-cyan-400');

    fireEvent.click(within(menu).getByRole('button', { name: 'Sort by size' }));
    expect(props.onSortChange).toHaveBeenCalledWith('size');
    // Picking an item closes the menu
    expect(screen.queryByText('Grid view')).toBeNull();
  });

  it('each menu entry calls through to the same handler as its button', () => {
    const { props } = renderToolbar({ view: 'grid', autoRefresh: true, writable: false });
    const openMenu = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
      return within(document.querySelector('.z-\\[110\\]') as HTMLElement);
    };
    const pick = (label: string) => fireEvent.click(openMenu().getByRole('button', { name: label }));
    pick('List view');
    expect(props.onViewChange).toHaveBeenCalledWith('list');
    pick('Show hidden files');
    expect(props.onToggleHidden).toHaveBeenCalledTimes(1);
    pick('Auto-refresh on (10s)');
    expect(props.onToggleAutoRefresh).toHaveBeenCalledTimes(1);
    pick('Refresh now');
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    pick('Sort by name (A-Z)');
    expect(props.onSortChange).toHaveBeenCalledWith('name');
    const menu = openMenu();
    expect(menu.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(menu.queryByRole('button', { name: 'Upload files' })).toBeNull();
  });

  it('the click that opens the menu does not also close it; the next outside click does', () => {
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByText('Refresh now')).toBeInTheDocument();
    fireEvent.click(document.body);
    expect(screen.queryByText('Refresh now')).toBeNull();
  });
});

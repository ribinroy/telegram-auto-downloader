import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp, RefreshCw, Search, X, LayoutGrid, List as ListIcon, Eye, EyeOff,
  FolderPlus, Upload, Radio, ChevronRight, Pencil, SlidersHorizontal, ArrowDownUp,
} from 'lucide-react';
import { formatBytes } from '../../utils/format';
import { FileContextMenu, type MenuItem } from './FileContextMenu';
import type { DiskUsage } from '../../api/files';
import type { SortKey, ViewMode } from './FileList';

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name', size: 'Size', modified: 'Modified', kind: 'Type',
};

/** Clickable path segments, with a click-to-type escape hatch for deep paths. */
function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(path); }, [path]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        autoFocus
        onChange={e => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={e => {
          if (e.key === 'Enter') { setEditing(false); onNavigate(draft.trim()); }
          if (e.key === 'Escape') { setEditing(false); setDraft(path); }
        }}
        className="flex-1 min-w-0 bg-slate-900 border border-cyan-500 rounded-lg px-3 py-1.5 text-sm text-white font-mono focus:outline-none"
      />
    );
  }

  const parts = path.split('/').filter(Boolean);
  return (
    <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto">
      <button
        onClick={() => onNavigate('/')}
        className="px-1.5 py-1 text-sm text-slate-400 hover:text-white transition-colors shrink-0"
      >
        /
      </button>
      {parts.map((part, i) => {
        const target = '/' + parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <div key={target} className="flex items-center shrink-0">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-600" />}
            <button
              onClick={() => onNavigate(target)}
              className={`px-1.5 py-1 text-sm rounded transition-colors ${
                last ? 'text-white font-medium' : 'text-slate-400 hover:text-white'
              }`}
            >
              {part}
            </button>
          </div>
        );
      })}
      <button
        onClick={() => setEditing(true)}
        className="ml-1 p-1 text-slate-600 hover:text-slate-300 transition-colors shrink-0"
        title="Type a path"
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

interface ToolbarProps {
  path: string;
  parent: string | null;
  usage: DiskUsage | null;
  writable: boolean;
  filter: string;
  searchQuery: string | null;
  view: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  showHidden: boolean;
  autoRefresh: boolean;
  refreshing: boolean;
  onNavigate: (path: string) => void;
  onFilterChange: (value: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
  onViewChange: (view: ViewMode) => void;
  onSortChange: (key: SortKey) => void;
  onToggleHidden: () => void;
  onToggleAutoRefresh: () => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
}

export function ExplorerToolbar({
  path, parent, usage, writable, filter, searchQuery, view, sortKey, sortAsc, showHidden,
  autoRefresh, refreshing, onNavigate, onFilterChange, onSearch, onClearSearch, onViewChange,
  onSortChange, onToggleHidden, onToggleAutoRefresh, onRefresh, onNewFolder, onUpload,
}: ToolbarProps) {
  // A phone fits the filter box and one button, not seven - below `sm` the
  // actions collapse into a menu instead of wrapping onto a second and third
  // row that pushed the file list off the screen.
  const [actionsAt, setActionsAt] = useState<{ x: number; y: number } | null>(null);

  const actionItems = (): MenuItem[] => {
    const items: MenuItem[] = [
      {
        label: view === 'list' ? 'Grid view' : 'List view',
        icon: view === 'list' ? <LayoutGrid className="w-4 h-4" /> : <ListIcon className="w-4 h-4" />,
        onClick: () => onViewChange(view === 'list' ? 'grid' : 'list'),
      },
    ];
    // The list header can only sort by name at this width (size and modified
    // are hidden columns), so sorting has to live here too.
    (Object.keys(SORT_LABELS) as SortKey[]).forEach((key, i) => items.push({
      label: `Sort by ${SORT_LABELS[key].toLowerCase()}${
        sortKey === key ? (sortAsc ? ' (A-Z)' : ' (Z-A)') : ''}`,
      icon: <ArrowDownUp className="w-4 h-4" />,
      active: sortKey === key,
      separated: i === 0,
      onClick: () => onSortChange(key),
    }));
    items.push({
      label: showHidden ? 'Hide dotfiles' : 'Show hidden files',
      icon: showHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />,
      active: showHidden,
      separated: true,
      onClick: onToggleHidden,
    });
    items.push({
      label: autoRefresh ? 'Auto-refresh on (10s)' : 'Auto-refresh off',
      icon: <Radio className="w-4 h-4" />,
      active: autoRefresh,
      onClick: onToggleAutoRefresh,
    });
    items.push({
      label: 'Refresh now',
      icon: <RefreshCw className="w-4 h-4" />,
      onClick: onRefresh,
    });
    if (writable) {
      items.push({
        label: 'New folder', icon: <FolderPlus className="w-4 h-4" />,
        separated: true, onClick: onNewFolder,
      });
      items.push({ label: 'Upload files', icon: <Upload className="w-4 h-4" />, onClick: onUpload });
    }
    return items;
  };

  const iconButton = (active: boolean) =>
    `p-2 rounded-lg transition-colors ${
      active ? 'bg-cyan-500/20 text-cyan-400' : 'bg-slate-800/60 text-slate-400 hover:text-white hover:bg-slate-700/60'
    }`;

  return (
    <div className="space-y-2 mb-3">
      {/* Path row */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => parent && onNavigate(parent)}
          disabled={!parent}
          className="p-2 rounded-lg bg-slate-800/60 text-slate-400 hover:text-white hover:bg-slate-700/60 disabled:opacity-30 disabled:hover:bg-slate-800/60 transition-colors"
          title="Up one level (Backspace)"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
        <Breadcrumbs path={path} onNavigate={onNavigate} />
        {usage && (
          <span className="hidden md:block text-xs text-slate-500 tabular-nums shrink-0">
            {formatBytes(usage.free)} free of {formatBytes(usage.total)}
          </span>
        )}
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={filter}
            onChange={e => onFilterChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSearch(); }}
            placeholder={searchQuery ? `Results for "${searchQuery}"` : 'Filter this folder - Enter to search subfolders'}
            className="w-full bg-slate-800/50 border border-slate-700 rounded-lg py-2 pl-9 pr-9 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
          />
          {(filter || searchQuery) && (
            <button
              onClick={() => { onFilterChange(''); onClearSearch(); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors"
              title="Clear"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Overflow menu - phones only */}
        <button
          onClick={e => {
            // Without this the menu's own outside-click listener, registered
            // in the effect React flushes before this event finishes bubbling,
            // would close it again on the very click that opened it.
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setActionsAt({ x: r.left, y: r.bottom + 6 });
          }}
          className={`sm:hidden ${iconButton(false)}`}
          title="View and folder actions"
          aria-label="Actions"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>

        {view === 'grid' && (
          <select
            value={sortKey}
            onChange={e => onSortChange(e.target.value as SortKey)}
            className="hidden sm:block bg-slate-800/60 border border-slate-700 rounded-lg py-2 px-2 text-xs text-slate-300 focus:outline-none focus:border-cyan-500 cursor-pointer"
            title={`Sort by (currently ${sortAsc ? 'ascending' : 'descending'} - pick the same field again to flip)`}
          >
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="modified">Modified</option>
            <option value="kind">Type</option>
          </select>
        )}

        <div className="hidden sm:flex items-center gap-2">
        <button onClick={() => onViewChange(view === 'list' ? 'grid' : 'list')}
          className={iconButton(false)} title={view === 'list' ? 'Grid view' : 'List view'}>
          {view === 'list' ? <LayoutGrid className="w-4 h-4" /> : <ListIcon className="w-4 h-4" />}
        </button>

        <button onClick={onToggleHidden} className={iconButton(showHidden)}
          title={showHidden ? 'Hide dotfiles' : 'Show hidden files'}>
          {showHidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
        </button>

        <button onClick={onToggleAutoRefresh} className={iconButton(autoRefresh)}
          title={autoRefresh ? 'Auto-refresh on (10s)' : 'Auto-refresh off'}>
          <Radio className="w-4 h-4" />
        </button>

        <button onClick={onRefresh} className={iconButton(false)} title="Re-read from disk">
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>

        {writable && (
          <>
            <button onClick={onNewFolder} className={iconButton(false)} title="New folder">
              <FolderPlus className="w-4 h-4" />
            </button>
            <button onClick={onUpload} className={iconButton(false)} title="Upload files here">
              <Upload className="w-4 h-4" />
            </button>
          </>
        )}
        </div>
      </div>

      {actionsAt && (
        <FileContextMenu
          x={actionsAt.x}
          y={actionsAt.y}
          items={actionItems()}
          onClose={() => setActionsAt(null)}
        />
      )}
    </div>
  );
}

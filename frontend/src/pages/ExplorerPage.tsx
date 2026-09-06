import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  FolderOpen, Loader2, AlertTriangle, X, Download, Copy, Scissors, ClipboardPaste,
  Pencil, Trash2, Info, Eye, Link as LinkIcon, CheckSquare, HardDrive, Search,
} from 'lucide-react';
import { useLayoutContext } from '../components/Layout';
import { ExplorerSidebar } from '../components/explorer/ExplorerSidebar';
import { ExplorerToolbar } from '../components/explorer/ExplorerToolbar';
import { FileList, type SortKey, type ViewMode } from '../components/explorer/FileList';
import { FileContextMenu, type MenuItem } from '../components/explorer/FileContextMenu';
import { FilePreviewModal } from '../components/explorer/FilePreviewModal';
import { PropertiesModal } from '../components/explorer/PropertiesModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  useFileRoots, useFileList, useFileSearch, useCreateFolder, useRenamePath,
  useDeletePaths, useTransferPaths, useUploadFiles,
} from '../hooks/useFiles';
import { getFileDownloadUrl, type FileEntry, type FileOpResponse } from '../api/files';
import { formatBytes } from '../utils/format';

const PREFS_KEY = 'explorer_prefs';
const AUTO_REFRESH_MS = 10_000;

interface Prefs {
  view: ViewMode;
  showHidden: boolean;
  sortKey: SortKey;
  sortAsc: boolean;
  autoRefresh: boolean;
}

function loadPrefs(): Prefs {
  const fallback: Prefs = { view: 'list', showHidden: false, sortKey: 'name', sortAsc: true, autoRefresh: false };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return fallback;
  }
}

export function ExplorerPage() {
  const [params, setParams] = useSearchParams();
  const requestedPath = params.get('path') ?? '';

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }, [prefs]);
  const patchPrefs = (patch: Partial<Prefs>) => setPrefs(p => ({ ...p, ...patch }));

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{ paths: string[]; move: boolean } | null>(null);
  const [menu, setMenu] = useState<{ entry: FileEntry; x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [properties, setProperties] = useState<FileEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ entries: FileEntry[]; permanent: boolean } | null>(null);
  const [filter, setFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  // Secured sources are hidden app-wide until the secured toggle is on; their
  // destination folders follow the same rule in the sidebar.
  const { showSecured } = useLayoutContext();
  const rootsQuery = useFileRoots(showSecured);
  const listing = useFileList(requestedPath, prefs.showHidden, prefs.autoRefresh ? AUTO_REFRESH_MS : 0);
  const currentPath = listing.data?.path ?? requestedPath;
  const search = useFileSearch(currentPath, searchQuery ?? '', prefs.showHidden, !!searchQuery);

  const createFolder = useCreateFolder();
  const renameMut = useRenamePath();
  const deleteMut = useDeletePaths();
  const transferMut = useTransferPaths();
  const uploadMut = useUploadFiles();

  const navigate = useCallback((path: string) => {
    setSelected(new Set());
    setSearchQuery(null);
    setFilter('');
    setParams(path ? { path } : {});
  }, [setParams]);

  // --- Entries ------------------------------------------------------------

  const rawEntries = useMemo(
    () => (searchQuery ? search.data?.entries : listing.data?.entries) ?? [],
    [searchQuery, search.data, listing.data]);

  const visible = useMemo(() => {
    const needle = searchQuery ? '' : filter.trim().toLowerCase();
    const filtered = needle
      ? rawEntries.filter(e => e.name.toLowerCase().includes(needle))
      : rawEntries;
    const dir = prefs.sortAsc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      // Folders keep their block at the top regardless of sort direction -
      // every file manager does this and reversing it feels broken.
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      switch (prefs.sortKey) {
        case 'size': return (a.size - b.size) * dir;
        case 'modified':
          return ((a.modified ? Date.parse(a.modified) : 0) - (b.modified ? Date.parse(b.modified) : 0)) * dir;
        case 'kind': return (a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) * dir;
        default: return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * dir;
      }
    });
  }, [rawEntries, filter, searchQuery, prefs.sortKey, prefs.sortAsc]);

  const selectedEntries = useMemo(
    () => visible.filter(e => selected.has(e.path)), [visible, selected]);
  const previewable = useMemo(
    () => visible.filter(e => !e.is_dir), [visible]);
  const writable = !!listing.data?.writable && !searchQuery;

  // --- Selection ----------------------------------------------------------

  const toggle = (entry: FileEntry) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    anchorRef.current = entry.path;
  };

  /**
   * A plain click opens. Selection is the deliberate gesture: press and hold,
   * or ctrl/shift-click with a mouse. Once anything is selected the list is in
   * selection mode, so further clicks tick items off instead of navigating
   * away mid-selection.
   */
  const handleActivate = (entry: FileEntry, e: MouseEvent) => {
    if (e.shiftKey && anchorRef.current) {
      const from = visible.findIndex(x => x.path === anchorRef.current);
      const to = visible.findIndex(x => x.path === entry.path);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(new Set(visible.slice(lo, hi + 1).map(x => x.path)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || selected.size > 0) {
      toggle(entry);
      return;
    }
    open(entry);
  };

  const handleLongPress = (entry: FileEntry) => toggle(entry);

  const open = useCallback((entry: FileEntry) => {
    if (entry.is_dir) navigate(entry.path);
    else setPreview(entry);
  }, [navigate, setPreview]);

  // --- Mutations ----------------------------------------------------------

  const reportErrors = (res: FileOpResponse, verb: string) => {
    if (res.errors?.length) {
      setNotice({ kind: 'error', text: `${verb} failed for ${res.errors.length} item(s): ${res.errors[0].error}` });
    }
    return !res.errors?.length;
  };

  const runRename = async (entry: FileEntry, name: string) => {
    setRenaming(null);
    if (!name || name === entry.name) return;
    try {
      await renameMut.mutateAsync({ path: entry.path, name });
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message });
    }
  };

  const runDelete = async () => {
    if (!confirmDelete) return;
    const { entries, permanent } = confirmDelete;
    setConfirmDelete(null);
    try {
      const res = await deleteMut.mutateAsync({ paths: entries.map(e => e.path), permanent });
      if (reportErrors(res, 'Delete') && !permanent) {
        setNotice({ kind: 'info', text: `Moved ${entries.length} item(s) to the trash folder on this disk.` });
      }
      setSelected(new Set());
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message });
    }
  };

  const runPaste = async () => {
    if (!clipboard || !writable) return;
    try {
      const res = await transferMut.mutateAsync({ paths: clipboard.paths, dest: currentPath, move: clipboard.move });
      reportErrors(res, clipboard.move ? 'Move' : 'Copy');
      if (clipboard.move) setClipboard(null);
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message });
    }
  };

  const runNewFolder = async () => {
    // Pick the first free "New folder (n)" rather than making the user name it
    // up front; the created row goes straight into inline rename.
    for (let n = 1; n <= 20; n++) {
      const name = n === 1 ? 'New folder' : `New folder (${n})`;
      try {
        const { entry } = await createFolder.mutateAsync({ path: currentPath, name });
        setRenaming(entry.path);
        setSelected(new Set([entry.path]));
        return;
      } catch (e) {
        if (!(e as Error).message.includes('already exists')) {
          setNotice({ kind: 'error', text: (e as Error).message });
          return;
        }
      }
    }
  };

  const runUpload = async (files: File[]) => {
    if (!files.length || !writable) return;
    try {
      const res = await uploadMut.mutateAsync({ dest: currentPath, files });
      if (res.errors?.length) {
        setNotice({ kind: 'error', text: `${res.errors.length} upload(s) failed: ${res.errors[0].error}` });
      } else {
        setNotice({ kind: 'info', text: `Uploaded ${files.length} file(s).` });
      }
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message });
    }
  };

  // --- Context menu -------------------------------------------------------

  const menuItems = (entry: FileEntry): MenuItem[] => {
    // Right-clicking outside the selection acts on that row alone, matching
    // every desktop file manager.
    const targets = selected.has(entry.path) && selectedEntries.length > 1 ? selectedEntries : [entry];
    const single = targets.length === 1;
    const items: MenuItem[] = [];

    if (single && entry.is_dir) {
      items.push({ label: 'Open', icon: <FolderOpen className="w-4 h-4" />, onClick: () => open(entry) });
    } else if (single) {
      items.push({ label: 'Preview', icon: <Eye className="w-4 h-4" />, onClick: () => setPreview(entry) });
      items.push({
        label: 'Download',
        icon: <Download className="w-4 h-4" />,
        onClick: () => window.open(getFileDownloadUrl(entry.path), '_blank'),
      });
    }
    if (!single) {
      items.push({
        label: `${targets.length} items selected`,
        icon: <CheckSquare className="w-4 h-4" />,
        onClick: () => {},
        disabled: true,
      });
    }

    items.push({
      label: 'Copy', icon: <Copy className="w-4 h-4" />, separated: true,
      onClick: () => setClipboard({ paths: targets.map(t => t.path), move: false }),
    });
    items.push({
      label: 'Cut', icon: <Scissors className="w-4 h-4" />,
      onClick: () => setClipboard({ paths: targets.map(t => t.path), move: true }),
      disabled: !writable,
    });
    items.push({
      label: 'Copy path', icon: <LinkIcon className="w-4 h-4" />,
      onClick: () => navigator.clipboard?.writeText(targets.map(t => t.path).join('\n')),
    });

    if (single) {
      items.push({
        label: 'Rename', icon: <Pencil className="w-4 h-4" />, separated: true,
        onClick: () => setRenaming(entry.path), disabled: !writable,
      });
    }
    items.push({
      label: 'Move to trash', icon: <Trash2 className="w-4 h-4" />, danger: true, separated: single ? false : true,
      onClick: () => setConfirmDelete({ entries: targets, permanent: false }),
      disabled: !writable,
    });
    items.push({
      label: 'Delete permanently', icon: <Trash2 className="w-4 h-4" />, danger: true,
      onClick: () => setConfirmDelete({ entries: targets, permanent: true }),
      disabled: !writable,
    });

    if (single) {
      items.push({
        label: 'Properties', icon: <Info className="w-4 h-4" />, separated: true,
        onClick: () => setProperties(entry),
      });
    }
    return items;
  };

  // --- Keyboard -----------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (preview || properties || confirmDelete) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(visible.map(v => v.path)));
      } else if (mod && e.key.toLowerCase() === 'c' && selectedEntries.length) {
        setClipboard({ paths: selectedEntries.map(s => s.path), move: false });
      } else if (mod && e.key.toLowerCase() === 'x' && selectedEntries.length) {
        setClipboard({ paths: selectedEntries.map(s => s.path), move: true });
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard) {
        runPaste();
      } else if (e.key === 'Backspace' && listing.data?.parent) {
        e.preventDefault();
        navigate(listing.data.parent);
      } else if (e.key === 'Enter' && selectedEntries.length === 1) {
        open(selectedEntries[0]);
      } else if (e.key === 'F2' && selectedEntries.length === 1 && writable) {
        e.preventDefault();
        setRenaming(selectedEntries[0].path);
      } else if (e.key === 'Delete' && selectedEntries.length && writable) {
        setConfirmDelete({ entries: selectedEntries, permanent: e.shiftKey });
      } else if (e.key === 'Escape') {
        setSelected(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // No dependency list on purpose: the handler closes over the selection,
    // clipboard and listing, all of which change constantly, and re-binding
    // one window listener per render is cheaper than keeping refs in sync.
  });

  // --- Render -------------------------------------------------------------

  // The backend decides where a disk's trash lives (per-mount, so a delete
  // stays a rename); the sidebar just links to whatever it reports.
  const trashPath = listing.data?.trash ?? null;
  const loading = searchQuery ? search.isLoading : (listing.isLoading && !listing.data);
  const listError = (searchQuery ? search.error : listing.error) as Error | null;
  const selectedSize = selectedEntries.reduce((sum, e) => sum + e.size, 0);

  return (
    <div className="max-w-[1600px] mx-auto px-3 sm:px-4 pt-2 sm:pt-4 pb-24 w-full">
      <div className="flex items-center gap-2 mb-3">
        <HardDrive className="w-5 h-5 text-cyan-400 shrink-0" />
        <h1 className="text-lg sm:text-xl font-semibold text-white">Files</h1>
        {rootsQuery.data?.readonly && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
            read-only mode
          </span>
        )}
      </div>

      <div className="flex flex-col lg:flex-row gap-4">
        <ExplorerSidebar
          roots={rootsQuery.data?.roots ?? []}
          loading={rootsQuery.isLoading}
          currentPath={currentPath}
          onNavigate={navigate}
          onRefresh={() => rootsQuery.refetch()}
          refreshing={rootsQuery.isFetching}
          trashPath={trashPath}
        />

        <div
          className={`flex-1 min-w-0 rounded-xl transition-colors ${dragging ? 'ring-2 ring-cyan-500 ring-offset-2 ring-offset-slate-900' : ''}`}
          onDragOver={e => { if (writable) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            if (!writable) return;
            e.preventDefault();
            setDragging(false);
            runUpload(Array.from(e.dataTransfer.files));
          }}
        >
          <ExplorerToolbar
            path={currentPath}
            parent={listing.data?.parent ?? null}
            usage={listing.data?.usage ?? null}
            writable={writable}
            filter={filter}
            searchQuery={searchQuery}
            view={prefs.view}
            sortKey={prefs.sortKey}
            sortAsc={prefs.sortAsc}
            showHidden={prefs.showHidden}
            autoRefresh={prefs.autoRefresh}
            refreshing={listing.isFetching || search.isFetching}
            onNavigate={navigate}
            onFilterChange={setFilter}
            onSearch={() => filter.trim().length >= 2 && setSearchQuery(filter.trim())}
            onClearSearch={() => setSearchQuery(null)}
            onViewChange={view => patchPrefs({ view })}
            onSortChange={key => patchPrefs({ sortKey: key, sortAsc: prefs.sortKey === key ? !prefs.sortAsc : true })}
            onToggleHidden={() => patchPrefs({ showHidden: !prefs.showHidden })}
            onToggleAutoRefresh={() => patchPrefs({ autoRefresh: !prefs.autoRefresh })}
            onRefresh={() => (searchQuery ? search.refetch() : listing.refetch())}
            onNewFolder={runNewFolder}
            onUpload={() => uploadRef.current?.click()}
          />

          <input
            ref={uploadRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => {
              runUpload(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />

          {notice && (
            <div className={`flex items-start gap-2 rounded-xl p-3 mb-3 text-sm ${
              notice.kind === 'error'
                ? 'bg-red-500/15 border border-red-500/40 text-red-300'
                : 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-300'
            }`}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="flex-1">{notice.text}</span>
              <button onClick={() => setNotice(null)} className="text-current opacity-70 hover:opacity-100">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {listError && (
            <div className="bg-red-500/15 border border-red-500/40 rounded-xl p-3 mb-3 text-sm text-red-300">
              {listError.message}
            </div>
          )}

          {/* Selection / clipboard bar */}
          {(selectedEntries.length > 0 || clipboard) && (
            <div className="flex items-center gap-2 flex-wrap rounded-xl border border-slate-700/60 bg-slate-800/50 px-3 py-2 mb-3">
              {selectedEntries.length > 0 && (
                <>
                  <span className="text-sm text-slate-300">
                    {selectedEntries.length} selected
                    {selectedSize > 0 && <span className="text-slate-500"> · {formatBytes(selectedSize)}</span>}
                  </span>
                  <button
                    onClick={() => setClipboard({ paths: selectedEntries.map(s => s.path), move: false })}
                    className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-slate-700/60 text-slate-300 hover:text-white transition-colors"
                  >
                    <Copy className="w-3.5 h-3.5" /> Copy
                  </button>
                  {writable && (
                    <>
                      <button
                        onClick={() => setClipboard({ paths: selectedEntries.map(s => s.path), move: true })}
                        className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-slate-700/60 text-slate-300 hover:text-white transition-colors"
                      >
                        <Scissors className="w-3.5 h-3.5" /> Cut
                      </button>
                      <button
                        onClick={() => setConfirmDelete({ entries: selectedEntries, permanent: false })}
                        className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Trash
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => setSelected(new Set())}
                    className="text-xs text-slate-500 hover:text-white transition-colors"
                  >
                    Clear
                  </button>
                </>
              )}
              {clipboard && (
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-xs text-slate-500">
                    {clipboard.paths.length} item(s) ready to {clipboard.move ? 'move' : 'copy'}
                  </span>
                  <button
                    onClick={runPaste}
                    disabled={!writable || transferMut.isPending}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white disabled:bg-slate-700 disabled:text-slate-500 transition-colors"
                  >
                    {transferMut.isPending
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <ClipboardPaste className="w-3.5 h-3.5" />}
                    Paste here
                  </button>
                  <button onClick={() => setClipboard(null)} className="text-slate-500 hover:text-white transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          {searchQuery && (
            <p className="text-xs text-slate-500 mb-2">
              {search.data?.entries.length ?? 0} match(es) under {currentPath}
              {search.data?.truncated && ' - stopped early, narrow the search'}
            </p>
          )}

          {loading ? (
            <div className="min-h-[40vh] flex items-center justify-center text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-cyan-500" />
            </div>
          ) : visible.length === 0 ? (
            <div className="min-h-[40vh] flex items-center justify-center text-slate-400">
              <div className="text-center">
                {searchQuery || filter
                  ? <Search className="w-12 h-12 mx-auto mb-4 opacity-40" />
                  : <FolderOpen className="w-12 h-12 mx-auto mb-4 opacity-40" />}
                <p>{searchQuery || filter ? 'Nothing matches' : 'This folder is empty'}</p>
              </div>
            </div>
          ) : (
            <FileList
              entries={visible}
              selected={selected}
              view={prefs.view}
              sortKey={prefs.sortKey}
              sortAsc={prefs.sortAsc}
              renaming={renaming}
              showPath={!!searchQuery}
              onSort={key => patchPrefs({ sortKey: key, sortAsc: prefs.sortKey === key ? !prefs.sortAsc : true })}
              onActivate={handleActivate}
              onLongPress={handleLongPress}
              onContext={(entry, x, y) => {
                // Touch reaches this through the ⋮ button only - a long press
                // there is the select gesture, not "open the menu".
                if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
                setMenu({ entry, x, y });
              }}
              onRename={runRename}
              onRenameCancel={() => setRenaming(null)}
            />
          )}
        </div>
      </div>

      {menu && (
        <FileContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />
      )}
      {preview && (
        <FilePreviewModal
          entry={preview}
          siblings={previewable}
          onClose={() => setPreview(null)}
          onNavigate={setPreview}
        />
      )}
      {properties && <PropertiesModal entry={properties} onClose={() => setProperties(null)} />}
      <ConfirmDialog
        isOpen={!!confirmDelete}
        title={confirmDelete?.permanent ? 'Delete permanently?' : 'Move to trash?'}
        message={
          confirmDelete?.permanent
            ? `${confirmDelete.entries.length} item(s) will be erased from the disk. This cannot be undone.`
            : `${confirmDelete?.entries.length ?? 0} item(s) will be moved to .downlee-trash on the same disk, where you can still recover them.`
        }
        confirmText={confirmDelete?.permanent ? 'Delete forever' : 'Move to trash'}
        variant="danger"
        onConfirm={runDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, Loader2, AlertCircle, Check, X, ArrowUp } from 'lucide-react';
import { browseVps, type VpsBrowseEntry, type VpsBrowseResult } from '../api';

interface FolderBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (paths: string[]) => void;
  /** Directory-listing function. Defaults to the VPS browser; pass browseLocal for the home server. */
  browseFn?: (path?: string) => Promise<VpsBrowseResult>;
  /** Pick a single folder (radio-style) instead of multiple. */
  singleSelect?: boolean;
  /** Modal heading. */
  title?: string;
  /** Pre-selected path (single-select edit flows). */
  initialPath?: string | null;
  /** Paths already being watched — shown as already-added and not re-selectable. */
  alreadyAdded?: string[];
}

interface NodeState {
  entries: VpsBrowseEntry[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
}

export function FolderBrowser({
  isOpen,
  onClose,
  onConfirm,
  browseFn = browseVps,
  singleSelect = false,
  title,
  initialPath = null,
  alreadyAdded = [],
}: FolderBrowserProps) {
  const [rootPath, setRootPath] = useState<string>('');
  const [rootParent, setRootParent] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootEntries, setRootEntries] = useState<VpsBrowseEntry[]>([]);
  // Children keyed by parent path
  const [children, setChildren] = useState<Record<string, NodeState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const addedSet = new Set(alreadyAdded);

  // Re-root the tree at `path` (undefined = the default starting folder).
  const loadRoot = useCallback(async (path?: string) => {
    setRootLoading(true);
    setRootError(null);
    try {
      const result = await browseFn(path ?? '');
      if (result.error) {
        setRootError(result.error);
      } else {
        setRootPath(result.path || '');
        setRootParent(result.parent ?? null);
        setRootEntries(result.entries || []);
        // A new root invalidates previously expanded/loaded subtrees.
        setChildren({});
        setExpanded(new Set());
      }
    } catch {
      setRootError('Failed to load folders');
    } finally {
      setRootLoading(false);
    }
  }, [browseFn]);

  // Reset and load on open
  useEffect(() => {
    if (isOpen) {
      setChildren({});
      setExpanded(new Set());
      setSelected(initialPath ? new Set([initialPath]) : new Set());
      setRootEntries([]);
      loadRoot();
    }
  }, [isOpen, loadRoot, initialPath]);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (isOpen && e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const loadChildren = useCallback(async (path: string) => {
    setChildren(prev => ({ ...prev, [path]: { entries: [], loading: true, error: null, loaded: false } }));
    try {
      const result = await browseFn(path);
      if (result.error) {
        setChildren(prev => ({ ...prev, [path]: { entries: [], loading: false, error: result.error!, loaded: false } }));
      } else {
        setChildren(prev => ({ ...prev, [path]: { entries: result.entries || [], loading: false, error: null, loaded: true } }));
      }
    } catch {
      setChildren(prev => ({ ...prev, [path]: { entries: [], loading: false, error: 'Failed to load', loaded: false } }));
    }
  }, [browseFn]);

  const toggleExpand = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!children[path]?.loaded && !children[path]?.loading) loadChildren(path);
      }
      return next;
    });
  }, [children, loadChildren]);

  const toggleSelect = useCallback((path: string) => {
    setSelected(prev => {
      if (singleSelect) return prev.has(path) ? new Set() : new Set([path]);
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, [singleSelect]);

  if (!isOpen) return null;

  const renderEntries = (entries: VpsBrowseEntry[], depth: number) => (
    entries.map(entry => {
      const isExpanded = expanded.has(entry.path);
      const isSelected = selected.has(entry.path);
      const isAdded = addedSet.has(entry.path);
      const childState = children[entry.path];
      return (
        <div key={entry.path}>
          <div
            className={`flex items-center gap-1.5 py-1.5 pr-2 rounded-md hover:bg-slate-700/40 ${isSelected ? 'bg-cyan-500/10' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
          >
            {/* Expand chevron (folders only) */}
            {entry.is_dir ? (
              <button
                onClick={() => toggleExpand(entry.path)}
                className="p-0.5 text-slate-400 hover:text-white shrink-0"
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
              >
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}

            {/* Selection control (folders only, not already-added) */}
            {entry.is_dir && !isAdded ? (
              <input
                type={singleSelect ? 'radio' : 'checkbox'}
                checked={isSelected}
                onChange={() => toggleSelect(entry.path)}
                className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0 shrink-0"
              />
            ) : (
              <span className="w-4 shrink-0" />
            )}

            {/* Icon */}
            {entry.is_dir ? (
              isExpanded
                ? <FolderOpen className="w-4 h-4 text-cyan-400 shrink-0" />
                : <Folder className="w-4 h-4 text-cyan-400 shrink-0" />
            ) : (
              <File className="w-4 h-4 text-slate-500 shrink-0" />
            )}

            {/* Name — clicking a folder selects it; the chevron handles expand/collapse */}
            <button
              onClick={() => entry.is_dir && !isAdded && toggleSelect(entry.path)}
              disabled={!entry.is_dir || isAdded}
              className={`text-sm truncate text-left flex-1 ${entry.is_dir ? 'text-slate-200' : 'text-slate-500'} ${entry.is_dir && !isAdded ? 'cursor-pointer' : 'cursor-default'}`}
              title={entry.path}
            >
              {entry.name}
            </button>

            {isAdded && (
              <span className="text-xs text-green-400 bg-green-500/15 px-1.5 py-0.5 rounded shrink-0">Added</span>
            )}
          </div>

          {/* Children */}
          {entry.is_dir && isExpanded && (
            <div>
              {childState?.loading && (
                <div className="flex items-center gap-2 text-slate-500 text-xs py-1.5" style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
                </div>
              )}
              {childState?.error && (
                <div className="flex items-center gap-2 text-red-400 text-xs py-1.5" style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}>
                  <AlertCircle className="w-3.5 h-3.5" /> {childState.error}
                </div>
              )}
              {childState?.loaded && childState.entries.length === 0 && (
                <div className="text-slate-600 text-xs py-1.5" style={{ paddingLeft: `${(depth + 1) * 16 + 24}px` }}>
                  Empty folder
                </div>
              )}
              {childState?.loaded && renderEntries(childState.entries, depth + 1)}
            </div>
          )}
        </div>
      );
    })
  );

  const selectedArr = Array.from(selected);
  const footerHint = singleSelect
    ? (selectedArr[0] || 'No folder selected')
    : `${selected.size} selected`;
  const confirmText = singleSelect
    ? 'Use this folder'
    : `Add ${selected.size > 0 ? selected.size : ''} selected`;

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
      <div className="bg-slate-800 rounded-xl w-full max-w-lg border border-slate-700 shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center gap-2 p-4 border-b border-slate-700">
          <button
            onClick={() => rootParent && loadRoot(rootParent)}
            disabled={!rootParent || rootLoading}
            title="Up one level"
            aria-label="Up one level"
            className="p-1.5 text-slate-300 hover:text-white rounded-lg hover:bg-slate-700/50 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-white">{title || (singleSelect ? 'Select a folder' : 'Select folders to watch')}</h3>
            <p className="text-xs text-slate-400 truncate" title={rootPath}>{rootPath || 'Loading…'}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700/50 shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto p-2 min-h-[200px]">
          {rootLoading ? (
            <div className="flex items-center justify-center py-12 text-cyan-500">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : rootError ? (
            <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 m-2 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{rootError}</span>
            </div>
          ) : rootEntries.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">No folders found</div>
          ) : (
            renderEntries(rootEntries, 0)
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-3 border-t border-slate-700">
          <span className="text-xs text-slate-400 truncate min-w-0" title={footerHint}>{footerHint}</span>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={onClose}
              className="py-2 px-4 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(selectedArr)}
              disabled={selected.size === 0}
              className="py-2 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors flex items-center gap-2"
            >
              <Check className="w-4 h-4" />
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

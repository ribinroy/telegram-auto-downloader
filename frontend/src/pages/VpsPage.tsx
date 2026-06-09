import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HardDrive, Folder, File as FileIcon, Download as DownloadIcon, RefreshCw, Loader2,
  CheckCircle, XCircle, StopCircle, Calendar, Square, Play, Settings, Trash2, Search, X,
} from 'lucide-react';
import ReactTimeAgo from 'react-time-ago';
import { useLayoutContext } from '../components/Layout';
import { fetchVpsFiles, downloadVpsFile, deleteVpsRemote, type VpsFileEntry, type VpsFolderGroup } from '../api';
import { formatBytes, formatSpeed, formatTime } from '../utils/format';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ROUTES } from '../routes';
import type { Download } from '../types';

function statusIcon(status?: string) {
  switch (status) {
    case 'done': return <CheckCircle className="w-4 h-4 text-green-400" />;
    case 'failed': return <XCircle className="w-4 h-4 text-red-400" />;
    case 'stopped': return <StopCircle className="w-4 h-4 text-yellow-400" />;
    default: return null;
  }
}

function VpsFileRow({
  entry, live, onDownload, onStop, onRetry, onDeleteRemote,
}: {
  entry: VpsFileEntry;
  live: Download | undefined;
  onDownload: (entry: VpsFileEntry) => void;
  onStop: (messageId: string) => void;
  onRetry: (id: number) => void;
  onDeleteRemote: (entry: VpsFileEntry) => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Live status from the WebSocket-backed downloads list takes priority,
  // falling back to the snapshot from the file listing.
  const status = live?.status ?? entry.status;
  const progress = live?.progress ?? 0;
  const downloading = status === 'downloading';
  const done = status === 'done';

  const handleDownload = async () => {
    setStarting(true);
    try { await onDownload(entry); } finally { setStarting(false); }
  };

  const handleConfirmDelete = async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try { await onDeleteRemote(entry); } finally { setDeleting(false); }
  };

  return (
    <div className="relative rounded-xl p-3 sm:p-4 border border-slate-700/50 bg-slate-800/30 transition-all">
      <div className="flex items-center gap-3">
        {/* Icon */}
        <div className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center bg-slate-700/50 rounded-lg shrink-0">
          {entry.is_dir
            ? <Folder className="w-5 h-5 text-cyan-400" />
            : <FileIcon className="w-5 h-5 text-slate-300" />}
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <h3 className="text-white font-medium text-sm sm:text-base truncate pr-2" title={entry.name}>
            {entry.name}
          </h3>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 mt-0.5">
            <span className="truncate max-w-[200px] sm:max-w-[360px]" title={entry.folder}>{entry.folder}</span>
            <span>{entry.is_dir ? 'folder' : formatBytes(entry.size)}</span>
            {entry.modified && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                <ReactTimeAgo date={new Date(entry.modified)} locale="en-US" timeStyle="twitter" />
              </span>
            )}
          </div>

          {/* Progress bar when downloading */}
          {downloading && (
            <div className="mt-2">
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>{formatBytes(live?.downloaded_bytes ?? 0)} / {formatBytes(live?.total_bytes ?? entry.size)}</span>
                <span>{progress.toFixed(1)}% · {formatSpeed(live?.speed ?? 0)} · ETA {formatTime(live?.pending_time ?? null)}</span>
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full progress-shimmer transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
        </div>

        {/* Right: status + action */}
        <div className="flex items-center gap-2 shrink-0">
          {!downloading && status && status !== 'done' && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-700/30 rounded-lg">
              {statusIcon(status)}
              <span className="text-xs capitalize text-slate-300">{status}</span>
            </div>
          )}

          {downloading && live?.message_id && (
            <button
              onClick={() => onStop(live.message_id as string)}
              className="p-2 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg transition-colors"
              title="Stop download"
            >
              <Square className="w-4 h-4" />
            </button>
          )}

          {done && (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/15 text-green-400 rounded-lg">
              <CheckCircle className="w-4 h-4" />
              <span className="text-xs">Downloaded</span>
            </div>
          )}

          {(status === 'failed' || status === 'stopped') && live && (
            <button
              onClick={() => onRetry(live.id)}
              className="p-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg transition-colors"
              title="Retry"
            >
              <Play className="w-4 h-4" />
            </button>
          )}

          {!downloading && !done && (
            <button
              onClick={handleDownload}
              disabled={starting}
              className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm py-2 px-3 rounded-lg transition-colors"
              title="Download to server"
            >
              {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadIcon className="w-4 h-4" />}
              <span className="hidden sm:inline">Download</span>
            </button>
          )}

          {/* Delete on the VPS (remote) - destructive, distinct from list actions */}
          {!downloading && (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              className="p-2 border border-red-500/40 bg-red-500/10 hover:bg-red-500/25 text-red-400 rounded-lg transition-colors disabled:opacity-50"
              title="Delete from VPS (permanent)"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete from VPS?"
        message={`This permanently deletes ${entry.is_dir ? 'the folder' : 'the file'} "${entry.name}" on the remote VPS${entry.is_dir ? ' and everything inside it' : ''}. This cannot be undone and does not affect files already downloaded to the server.`}
        confirmText="Delete from VPS"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

export function VpsPage() {
  const { downloads, onStop, onRetry, vpsReady } = useLayoutContext();
  const navigate = useNavigate();
  const [groups, setGroups] = useState<VpsFolderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState('');
  const [search, setSearch] = useState('');

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGroups(await fetchVpsFiles());
    } catch {
      setError('Failed to load VPS files');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // Active folders (current connection) provide the file list & filter options.
  const activeGroups = useMemo(() => groups.filter(g => g.active), [groups]);
  const inactiveCount = groups.length - activeGroups.length;
  const folderOptions = useMemo(() => activeGroups.map(g => g.path), [activeGroups]);
  const folderErrors = useMemo(
    () => activeGroups.filter(g => g.error).map(g => ({ path: g.path, error: g.error as string })),
    [activeGroups],
  );

  // Flatten all files/folders across active watched folders into one list.
  const allEntries = useMemo(
    () => activeGroups.flatMap(g => (g.error ? [] : g.entries)),
    [activeGroups],
  );
  const visibleEntries = useMemo(() => {
    let entries = folderFilter ? allEntries.filter(e => e.folder === folderFilter) : allEntries;
    const query = search.trim().toLowerCase();
    if (query) entries = entries.filter(e => e.name.toLowerCase().includes(query));
    return entries;
  }, [allEntries, folderFilter, search]);

  const handleDownload = async (entry: VpsFileEntry) => {
    const res = await downloadVpsFile(entry.path, entry.size);
    if (res?.error) setError(res.error);
    // The WebSocket download:new event updates the shared downloads list,
    // which this page reads for live progress.
  };

  const handleDeleteRemote = async (entry: VpsFileEntry) => {
    const res = await deleteVpsRemote(entry.path);
    if (res?.error) {
      setError(res.error);
    } else {
      // Drop it from the list immediately, then re-sync with the server.
      setGroups(prev => prev.map(g => ({ ...g, entries: g.entries.filter(e => e.path !== entry.path) })));
      loadFiles();
    }
  };

  // Match a file to its live download by remote path (url) for live progress.
  const liveFor = (path: string): Download | undefined =>
    downloads.find(d => d.downloaded_from === 'vps' && d.url === path);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 pt-2 sm:pt-4 pb-24 w-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4 sm:mb-6">
        <div className="flex items-center gap-2 min-w-0">
          <HardDrive className="w-5 h-5 text-purple-400 shrink-0" />
          <h1 className="text-lg sm:text-xl font-semibold text-white">VPS Files</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Folder filter */}
          {folderOptions.length > 1 && (
            <select
              value={folderFilter}
              onChange={(e) => setFolderFilter(e.target.value)}
              className="bg-slate-800/50 border border-slate-700 rounded-lg py-2 px-2 sm:px-3 text-xs sm:text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer max-w-[160px] sm:max-w-[260px]"
              title="Filter by watched folder"
            >
              <option value="">All folders</option>
              {folderOptions.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
          <button
            onClick={loadFiles}
            disabled={loading}
            className="flex items-center gap-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 text-sm py-2 px-3 rounded-lg transition-colors"
            title="Refresh listing"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            onClick={() => navigate(ROUTES.SETTINGS_VPS)}
            className="flex items-center gap-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 text-sm py-2 px-3 rounded-lg transition-colors"
            title="VPS settings"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Settings</span>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search files..."
          className="w-full bg-slate-800/50 border border-slate-700 rounded-lg py-2 pl-9 pr-9 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors"
            title="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-500/20 border border-red-500/50 rounded-xl p-4 mb-6 text-red-400">
          {error}
        </div>
      )}

      {/* Per-folder listing errors */}
      {folderErrors.map(fe => (
        <div key={fe.path} className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3 text-red-400 text-sm">
          <span className="font-medium">{fe.path}</span>: {fe.error}
        </div>
      ))}

      {loading ? (
        <div className="min-h-[50vh] flex items-center justify-center text-slate-400">
          <div className="text-center">
            <Loader2 className="w-12 h-12 mx-auto mb-4 animate-spin text-cyan-500" />
            <p>Loading VPS files...</p>
          </div>
        </div>
      ) : !vpsReady && groups.length === 0 ? (
        <div className="min-h-[50vh] flex items-center justify-center text-slate-400">
          <div className="text-center">
            <HardDrive className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No VPS connection or watched folders</p>
            <button onClick={() => navigate(ROUTES.SETTINGS_VPS)} className="text-sm text-cyan-400 hover:text-cyan-300 mt-1">
              Configure a VPS and add folders in Settings
            </button>
          </div>
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="min-h-[40vh] flex items-center justify-center text-slate-400">
          <div className="text-center">
            {search.trim() ? (
              <>
                <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No files match "{search.trim()}"</p>
                <button onClick={() => setSearch('')} className="text-sm text-cyan-400 hover:text-cyan-300 mt-1">
                  Clear search
                </button>
              </>
            ) : (
              <>
                <Folder className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No files found</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleEntries.map((entry) => (
            <VpsFileRow
              key={entry.path}
              entry={entry}
              live={liveFor(entry.path)}
              onDownload={handleDownload}
              onStop={onStop}
              onRetry={onRetry}
              onDeleteRemote={handleDeleteRemote}
            />
          ))}
        </div>
      )}

      {/* Note about folders on other VPS connections */}
      {!loading && inactiveCount > 0 && (
        <p className="text-xs text-slate-500 mt-4 text-center">
          {inactiveCount} folder{inactiveCount !== 1 ? 's' : ''} on other VPS connections hidden.
        </p>
      )}
    </div>
  );
}

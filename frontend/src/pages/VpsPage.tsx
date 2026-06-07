import { useCallback, useEffect, useState } from 'react';
import {
  HardDrive, Folder, File as FileIcon, Download as DownloadIcon, RefreshCw, Loader2,
  CheckCircle, XCircle, StopCircle, Calendar, Lock, Square, Play,
} from 'lucide-react';
import ReactTimeAgo from 'react-time-ago';
import { useLayoutContext } from '../components/Layout';
import { fetchVpsFiles, downloadVpsFile, type VpsFolderGroup, type VpsFileEntry } from '../api';
import { formatBytes, formatSpeed, formatTime } from '../utils/format';
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
  entry, live, onDownload, onStop, onRetry,
}: {
  entry: VpsFileEntry;
  live: Download | undefined;
  onDownload: (entry: VpsFileEntry) => void;
  onStop: (messageId: string) => void;
  onRetry: (id: number) => void;
}) {
  const [starting, setStarting] = useState(false);
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

  return (
    <div className="relative rounded-xl p-3 sm:p-4 border border-slate-700/50 bg-slate-800/30 transition-all">
      <div className="flex items-center gap-3">
        {/* Icon */}
        <div className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center bg-slate-700/50 rounded-lg shrink-0">
          <FileIcon className="w-5 h-5 text-slate-300" />
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <h3 className="text-white font-medium text-sm sm:text-base truncate pr-2" title={entry.name}>
            {entry.name}
          </h3>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 mt-0.5">
            <span className="truncate max-w-[200px] sm:max-w-[360px]" title={entry.folder}>{entry.folder}</span>
            <span>{formatBytes(entry.size)}</span>
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
        </div>
      </div>
    </div>
  );
}

export function VpsPage() {
  const { downloads, onStop, onRetry, vpsReady } = useLayoutContext();
  const [groups, setGroups] = useState<VpsFolderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const handleDownload = async (entry: VpsFileEntry) => {
    const res = await downloadVpsFile(entry.path, entry.size);
    if (res?.error) setError(res.error);
    // The WebSocket download:new event updates the shared downloads list,
    // which this page reads for live progress.
  };

  // Match a file to its live download by remote path (url) for live progress.
  const liveFor = (path: string): Download | undefined =>
    downloads.find(d => d.downloaded_from === 'vps' && d.url === path);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 pt-2 sm:pt-4 pb-24 w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <div className="flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-purple-400" />
          <h1 className="text-lg sm:text-xl font-semibold text-white">VPS Files</h1>
        </div>
        <button
          onClick={loadFiles}
          disabled={loading}
          className="flex items-center gap-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 text-sm py-2 px-3 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {error && (
        <div className="bg-red-500/20 border border-red-500/50 rounded-xl p-4 mb-6 text-red-400">
          {error}
        </div>
      )}

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
            <p className="text-sm">Configure a VPS and add folders in Settings</p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => {
            const inactive = !group.active;
            return (
              <div key={`${group.host ?? ''}:${group.path}`}>
                {/* Folder heading */}
                <div className={`flex items-center gap-2 mb-2 ${inactive ? 'text-slate-500' : 'text-slate-300'}`}>
                  <Folder className="w-4 h-4" />
                  <span className="text-sm font-medium truncate" title={group.path}>{group.path}</span>
                  {group.auto_sync && !inactive && (
                    <span className="text-[10px] uppercase tracking-wide bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded px-1.5 py-0.5">
                      autoSync
                    </span>
                  )}
                  {inactive && (
                    <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide bg-slate-700/50 text-slate-400 rounded px-1.5 py-0.5">
                      <Lock className="w-3 h-3" /> other VPS
                    </span>
                  )}
                </div>

                {inactive ? (
                  <div className="rounded-xl border border-slate-700/40 bg-slate-800/20 p-3 text-sm text-slate-500 opacity-60">
                    {group.host ? `Belongs to ${group.username ?? ''}@${group.host}` : 'Belongs to a different VPS connection'} — connect to it to browse.
                  </div>
                ) : group.error ? (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                    {group.error}
                  </div>
                ) : group.entries.length === 0 ? (
                  <div className="rounded-xl border border-slate-700/40 bg-slate-800/20 p-3 text-sm text-slate-500">
                    Empty folder
                  </div>
                ) : (
                  <div className="space-y-2">
                    {group.entries.map((entry) =>
                      entry.is_dir ? (
                        <div key={entry.path} className="flex items-center gap-3 rounded-xl p-3 border border-slate-700/40 bg-slate-800/20 text-slate-400">
                          <div className="w-9 h-9 flex items-center justify-center bg-slate-700/40 rounded-lg shrink-0">
                            <Folder className="w-5 h-5 text-cyan-500/70" />
                          </div>
                          <span className="text-sm truncate" title={entry.name}>{entry.name}</span>
                          <span className="text-xs text-slate-600 ml-auto">folder</span>
                        </div>
                      ) : (
                        <VpsFileRow
                          key={entry.path}
                          entry={entry}
                          live={liveFor(entry.path)}
                          onDownload={handleDownload}
                          onStop={onStop}
                          onRetry={onRetry}
                        />
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

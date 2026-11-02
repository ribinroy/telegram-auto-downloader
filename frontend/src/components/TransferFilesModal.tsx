import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, Circle, FolderOpen, HardDrive, Loader2, Search, X, AlertTriangle } from 'lucide-react';
import type { Download } from '../types';
import type { TransferFileState } from '../api';
import { useTransferFiles } from '../hooks/useDownloads';
import { formatBytes } from '../utils/format';

const STATE_LABEL: Record<TransferFileState, string> = {
  done: 'Done',
  downloading: 'Downloading',
  partial: 'Partial',
  pending: 'Waiting',
  on_disk: 'On disk',
};

function StateIcon({ state }: { state: TransferFileState }) {
  switch (state) {
    case 'done':
      return <CheckCircle className="w-4 h-4 text-green-400" />;
    case 'on_disk':
      return <HardDrive className="w-4 h-4 text-green-400" />;
    case 'downloading':
      return <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />;
    case 'partial':
      return <Circle className="w-4 h-4 text-amber-400" />;
    default:
      return <Circle className="w-4 h-4 text-slate-600" />;
  }
}

/** Every file inside one VPS folder pull (a multi-file torrent pulled as a
 *  single download) and how far each one has got on the home server. */
export function TransferFilesModal({ download, onClose }: { download: Download; onClose: () => void }) {
  const live = download.status === 'downloading';
  const { data, isLoading, error } = useTransferFiles(download.id, live);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const files = useMemo(() => data?.files ?? [], [data]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // Active and unfinished first, so the interesting rows are on top
    const rank: Record<TransferFileState, number> = { downloading: 0, partial: 1, pending: 2, done: 3, on_disk: 3 };
    return files
      .filter(f => !q || f.path.toLowerCase().includes(q))
      .sort((a, b) => rank[a.state] - rank[b.state] || a.path.localeCompare(b.path));
  }, [files, filter]);

  const doneCount = files.filter(f => f.state === 'done' || f.state === 'on_disk').length;
  const activeCount = files.filter(f => f.state === 'downloading').length;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-files-title"
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[88dvh] flex flex-col bg-slate-800 border border-slate-700 rounded-t-2xl sm:rounded-2xl shadow-2xl pb-[env(safe-area-inset-bottom)]"
      >
        <div className="shrink-0 flex items-start gap-3 px-4 pt-4 pb-3 border-b border-slate-700/60">
          <FolderOpen className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h2 id="transfer-files-title" className="text-base font-semibold text-white break-words">{download.file}</h2>
            {data && (
              <p className="text-xs text-slate-400">
                {doneCount} of {files.length} file{files.length !== 1 ? 's' : ''} done
                {activeCount > 0 && ` · ${activeCount} downloading`}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60">
            <X className="w-5 h-5" />
          </button>
        </div>

        {data?.source === 'local' && (
          <p className="shrink-0 flex items-start gap-1.5 px-4 py-2 text-xs text-amber-300 border-b border-slate-700/60">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Couldn't compare with the VPS{data.error ? ` (${data.error})` : ''} - showing only what is on disk here.
          </p>
        )}

        {files.length > 8 && (
          <div className="shrink-0 px-4 pt-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Filter files..."
                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg py-1.5 pl-8 pr-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3">
          {isLoading ? (
            <div className="py-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-cyan-500" /></div>
          ) : error ? (
            <p className="py-10 text-center text-sm text-slate-400">Couldn't load the file list: {(error as Error).message}</p>
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">{filter ? 'No files match' : 'No files found'}</p>
          ) : (
            <ul className="space-y-1.5">
              {shown.map(f => {
                const pct = f.size ? Math.min(100, (f.local_size / f.size) * 100) : 0;
                const unfinished = f.state === 'downloading' || f.state === 'partial';
                return (
                  <li key={f.path} className="rounded-lg bg-slate-900/40 px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <span className="shrink-0" title={STATE_LABEL[f.state]}><StateIcon state={f.state} /></span>
                      <span className="flex-1 min-w-0 text-sm text-slate-200 break-all">{f.path}</span>
                      <span className="shrink-0 text-xs text-slate-400 tabular-nums">
                        {unfinished ? `${formatBytes(f.local_size)} / ${formatBytes(f.size)}` : formatBytes(f.size)}
                      </span>
                    </div>
                    {unfinished && (
                      <div className="mt-1.5 ml-6.5 h-1 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${f.state === 'downloading' ? 'progress-shimmer' : 'bg-amber-500/70'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

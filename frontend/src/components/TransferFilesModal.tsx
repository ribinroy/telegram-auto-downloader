import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle, Circle, FolderOpen, HardDrive, Loader2, Search, X, AlertTriangle,
  Pause, Play, PauseCircle, SkipForward, Undo2, Eye, Ban,
} from 'lucide-react';
import type { Download } from '../types';
import type { FileDecision, TransferFileState } from '../api';
import { getFileStreamUrl } from '../api/files';
import { ensureMediaToken } from '../api';
import { useTransferFiles, useSetTransferFilesStatus } from '../hooks/useDownloads';
import { notify } from '../lib/notify';
import { ROUTES } from '../routes';
import { formatBytes } from '../utils/format';
import { VideoPlayerModal } from './VideoPlayerModal';

const VIDEO_EXTENSIONS = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv)$/i;

const STATE_LABEL: Record<TransferFileState, string> = {
  done: 'Done',
  downloading: 'Downloading',
  partial: 'Partial',
  pending: 'Waiting',
  paused: 'Paused',
  skipped: 'Skipped',
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
    case 'paused':
      return <PauseCircle className="w-4 h-4 text-slate-400" />;
    case 'skipped':
      return <Ban className="w-4 h-4 text-slate-500" />;
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
  const setStatus = useSetTransferFilesStatus(download.id);
  // The rows whose request is in flight, so each row's buttons wait on their own
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const decide = (path: string, status: FileDecision) => {
    setBusy(prev => new Set(prev).add(path));
    setStatus.mutate({ paths: [path], status }, {
      onSuccess: r => {
        if (r.restarted === 'waiting') notify({ type: 'info', title: 'Transfer queued', message: download.file });
        else if (r.restarted === 'started') notify({ type: 'success', title: 'Transfer resumed', message: download.file });
        else if (r.status === 'done' && download.status !== 'done') {
          notify({ type: 'success', title: 'Transfer complete', message: `${download.file} - the rest is skipped` });
        }
      },
      onError: e => notify({
        type: 'error',
        title: status === 'paused' ? "Couldn't pause the file" : status === 'skipped' ? "Couldn't skip the file" : "Couldn't resume the file",
        message: e.message,
      }),
      onSettled: () => setBusy(prev => { const next = new Set(prev); next.delete(path); return next; }),
    });
  };

  // View a finished file: a video plays here, anything else opens in the explorer
  const navigate = useNavigate();
  const [playing, setPlaying] = useState<{ url: string; title: string } | null>(null);
  const view = (localPath: string, name: string) => {
    if (VIDEO_EXTENSIONS.test(localPath)) {
      void ensureMediaToken().then(() =>
        setPlaying({ url: getFileStreamUrl(localPath), title: name }));
      return;
    }
    const parent = localPath.replace(/\/[^/]*$/, '') || '/';
    onClose();
    navigate(`${ROUTES.FILES}?path=${encodeURIComponent(parent)}&select=${encodeURIComponent(localPath)}`);
  };

  useEffect(() => {
    // While the player is up, Escape is its to handle
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !playing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, playing]);

  const files = useMemo(() => data?.files ?? [], [data]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // Active and unfinished first, so the interesting rows are on top
    const rank: Record<TransferFileState, number> = { downloading: 0, partial: 1, pending: 2, paused: 3, done: 4, on_disk: 4, skipped: 5 };
    return files
      .filter(f => !q || f.path.toLowerCase().includes(q))
      .sort((a, b) => rank[a.state] - rank[b.state] || a.path.localeCompare(b.path));
  }, [files, filter]);

  const doneCount = files.filter(f => f.state === 'done' || f.state === 'on_disk').length;
  const activeCount = files.filter(f => f.state === 'downloading').length;
  const pausedCount = files.filter(f => f.state === 'paused').length;
  const skippedCount = files.filter(f => f.state === 'skipped').length;
  // Without the VPS side there is no plan to pause or skip anything in
  const canControl = data?.source !== 'local';

  return createPortal(
    <>
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
                {doneCount} of {files.length - skippedCount} file{files.length - skippedCount !== 1 ? 's' : ''} done
                {activeCount > 0 && ` · ${activeCount} downloading`}
                {pausedCount > 0 && ` · ${pausedCount} paused`}
                {skippedCount > 0 && ` · ${skippedCount} skipped`}
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
              {/* Column header: status · file · size · action */}
              <li className={`${GRID} px-3 pb-1 text-[11px] uppercase tracking-wide text-slate-500`}>
                <span />
                <span>File</span>
                <span className="text-right">Size</span>
                <span className="text-right">Action</span>
              </li>
              {shown.map(f => {
                const pct = f.size ? Math.min(100, (f.local_size / f.size) * 100) : 0;
                const unfinished = f.state === 'downloading' || f.state === 'partial'
                  || ((f.state === 'paused' || f.state === 'skipped') && f.local_size > 0);
                const finished = f.state === 'done' || f.state === 'on_disk';
                const isBusy = busy.has(f.path);
                const dim = f.state === 'paused' || f.state === 'skipped';
                return (
                  <li key={f.path} className="rounded-lg bg-slate-900/40 px-3 py-2">
                    <div className={GRID}>
                      <span title={STATE_LABEL[f.state]}><StateIcon state={f.state} /></span>
                      <span className={`min-w-0 text-sm break-all ${dim ? 'text-slate-500' : 'text-slate-200'} ${f.state === 'skipped' ? 'line-through decoration-slate-600' : ''}`}>{f.path}</span>
                      <span className="text-xs text-slate-400 tabular-nums text-right">
                        {unfinished ? `${formatBytes(f.local_size)} / ${formatBytes(f.size)}` : formatBytes(f.size)}
                      </span>
                      <span className="flex justify-end gap-1">
                        {finished && f.local_path && (
                          <RowButton
                            label={VIDEO_EXTENSIONS.test(f.local_path) ? `Play ${f.path}` : `Show ${f.path} in the file explorer`}
                            onClick={() => view(f.local_path!, f.path)}
                            tone="view"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </RowButton>
                        )}
                        {canControl && !finished && f.state === 'skipped' && (
                          <RowButton label={`Download ${f.path} after all`} onClick={() => decide(f.path, null)} busy={isBusy} tone="on">
                            <Undo2 className="w-3.5 h-3.5" />
                          </RowButton>
                        )}
                        {canControl && !finished && f.state !== 'skipped' && (
                          <>
                            <RowButton
                              label={f.state === 'paused' ? `Resume ${f.path}` : `Pause ${f.path}`}
                              onClick={() => decide(f.path, f.state === 'paused' ? null : 'paused')}
                              busy={isBusy}
                              tone={f.state === 'paused' ? 'on' : 'plain'}
                            >
                              {f.state === 'paused' ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                            </RowButton>
                            <RowButton label={`Skip ${f.path} - don't download it`} onClick={() => decide(f.path, 'skipped')} busy={isBusy} tone="plain">
                              <SkipForward className="w-3.5 h-3.5" />
                            </RowButton>
                          </>
                        )}
                      </span>
                    </div>
                    {unfinished && (
                      <div className="mt-1.5 ml-6.5 mr-[4.625rem] h-1 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${f.state === 'downloading' ? 'progress-shimmer' : dim ? 'bg-slate-500' : 'bg-amber-500/70'}`}
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
    </div>
    {playing && (
      <VideoPlayerModal isOpen onClose={() => setPlaying(null)} videoUrl={playing.url} title={playing.title} />
    )}
    </>,
    document.body,
  );
}

// status · file · size · action - the header and every row share it
const GRID = 'grid grid-cols-[1rem_1fr_auto_4rem] items-center gap-2.5';

const TONES = {
  plain: 'bg-slate-700/60 hover:bg-slate-600/60 text-slate-300',
  on: 'bg-cyan-500/15 hover:bg-cyan-500/30 text-cyan-300',
  view: 'bg-green-500/15 hover:bg-green-500/30 text-green-300',
};

function RowButton({ label, onClick, busy = false, tone, children }: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  tone: keyof typeof TONES;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${TONES[tone]}`}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : children}
    </button>
  );
}

import { createPortal } from 'react-dom';
import {
  X, Copy, Scissors, Loader2, CheckCircle, XCircle, AlertCircle, Ban, FolderOpen,
} from 'lucide-react';
import { formatBytes, formatTime } from '../../utils/format';
import { useCancelTransfer, useDismissTransfer } from '../../hooks/useFiles';
import {
  isTransferActive, transferPercent, transferTitle, pathBaseName as baseName, type FileTransfer,
} from '../../api/files';

const STATUS: Record<FileTransfer['status'], { label: string; cls: string; icon: React.ReactNode }> = {
  preparing: { label: 'Preparing', cls: 'text-cyan-300', icon: <Loader2 className="w-4 h-4 animate-spin text-cyan-400" /> },
  running: { label: 'In progress', cls: 'text-cyan-300', icon: <Loader2 className="w-4 h-4 animate-spin text-cyan-400" /> },
  done: { label: 'Done', cls: 'text-green-300', icon: <CheckCircle className="w-4 h-4 text-green-400" /> },
  partial: { label: 'Some items failed', cls: 'text-yellow-300', icon: <AlertCircle className="w-4 h-4 text-yellow-400" /> },
  failed: { label: 'Failed', cls: 'text-red-300', icon: <XCircle className="w-4 h-4 text-red-400" /> },
  cancelled: { label: 'Cancelled', cls: 'text-slate-400', icon: <Ban className="w-4 h-4 text-slate-500" /> },
};

function TransferCard({ t, onOpenDest }: { t: FileTransfer; onOpenDest: (path: string) => void }) {
  const cancel = useCancelTransfer();
  const dismiss = useDismissTransfer();
  const active = isTransferActive(t);
  const pct = transferPercent(t);
  const status = STATUS[t.status];
  const filePct = t.current_file_size ? (t.current_file_done / t.current_file_size) * 100 : 0;
  // Only shown once finished, so finished_at is set
  const elapsed = (t.finished_at ?? t.started_at) - t.started_at;

  return (
    <div className="rounded-xl border border-slate-700/70 bg-slate-800/40 p-3">
      <div className="flex items-start gap-2">
        {t.move
          ? <Scissors className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
          : <Copy className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white truncate" title={transferTitle(t)}>{transferTitle(t)}</p>
          <p className={`flex items-center gap-1.5 text-xs mt-0.5 ${status.cls}`}>
            {status.icon} {status.label}
            {!active && <span className="text-slate-500">· took {formatTime(Math.max(1, elapsed))}</span>}
          </p>
        </div>
        {active ? (
          <button
            onClick={() => cancel.mutate(t.id)}
            disabled={cancel.isPending}
            className="text-xs px-2 py-1 rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-50 transition-colors"
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : (
          <button
            onClick={() => dismiss.mutate(t.id)}
            title="Dismiss"
            aria-label="Dismiss"
            className="p-1 text-slate-500 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {active && (
        <div className="mt-3 space-y-2">
          <div className="h-2 rounded-full bg-slate-700 overflow-hidden">
            <div
              className={`h-full bg-cyan-500 transition-[width] duration-500 ${t.status === 'preparing' ? 'animate-pulse w-full opacity-40' : ''}`}
              style={t.status === 'preparing' ? undefined : { width: `${pct}%` }}
            />
          </div>
          {t.status === 'preparing' ? (
            <p className="text-xs text-slate-400">Counting what to copy…</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-xs">
              <Stat label="Done" value={t.total_bytes ? `${formatBytes(t.done_bytes)} / ${formatBytes(t.total_bytes)}` : `${Math.round(pct)}%`} />
              <Stat label="Files" value={`${t.done_files} / ${t.total_files}`} />
              <Stat label="Speed" value={t.speed ? `${formatBytes(t.speed)}/s` : '-'} />
              <Stat label="Left" value={t.eta != null ? formatTime(t.eta) : '-'} />
            </div>
          )}
          {t.current_file && (
            <div className="text-xs">
              <p className="text-slate-500">Now</p>
              <p className="text-slate-300 truncate" title={t.current_file}>{baseName(t.current_file)}</p>
              {t.current_file_size > 0 && (
                <div className="mt-1 flex items-center gap-2">
                  <div className="flex-1 h-1 rounded-full bg-slate-700 overflow-hidden">
                    <div className="h-full bg-cyan-400/70" style={{ width: `${filePct}%` }} />
                  </div>
                  <span className="text-slate-500 tabular-nums">{Math.round(filePct)}%</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!active && t.total_bytes > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          {formatBytes(t.done_bytes)} in {t.done_files} file(s)
        </p>
      )}

      {t.error && <p className="mt-2 text-xs text-red-300 break-words">{t.error}</p>}
      {t.errors.length > 0 && (
        <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto">
          {t.errors.map(e => (
            <li key={e.path} className="text-xs">
              <span className="text-slate-300">{baseName(e.path)}</span>
              <span className="text-red-300"> - {e.error}</span>
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={() => onOpenDest(t.dest)}
        className="mt-2 flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors max-w-full"
        title={t.dest}
      >
        <FolderOpen className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{t.dest}</span>
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-slate-500">{label}</p>
      <p className="text-slate-200 tabular-nums truncate">{value}</p>
    </div>
  );
}

export function TransfersModal({
  transfers, onClose, onOpenDest,
}: { transfers: FileTransfer[]; onClose: () => void; onOpenDest: (path: string) => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full sm:max-w-lg max-h-[85dvh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <h3 className="text-white font-medium">Copy &amp; move</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] overflow-y-auto space-y-3">
          {transfers.length === 0
            ? <p className="text-sm text-slate-400 py-6 text-center">No transfers right now</p>
            : transfers.map(t => <TransferCard key={t.id} t={t} onOpenDest={onOpenDest} />)}
        </div>
      </div>
    </div>,
    document.body,
  );
}

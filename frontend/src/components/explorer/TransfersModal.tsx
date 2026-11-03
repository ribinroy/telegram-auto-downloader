import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Copy, Scissors, Loader2, CheckCircle, XCircle, AlertCircle, Ban, FolderOpen,
  Circle, MinusCircle, ArrowRightLeft, Pause, Play,
} from 'lucide-react';
import { formatBytes, formatTime } from '../../utils/format';
import { useCancelTransfer, useDismissTransfer, useTransferFiles, usePauseTransferFiles } from '../../hooks/useFiles';
import {
  isTransferActive, transferPercent, transferTitle, pathBaseName as baseName, sortTransferFiles,
  canPauseFile, canResumeFile,
  type FileTransfer, type TransferFile, type TransferFileState,
} from '../../api/files';

// A 20k-file folder is a lot of DOM to re-render every poll; the filter
// narrows it down, and the rest is counted.
const MAX_ROWS = 300;
const FILTER_FROM = 8;

const STATUS: Record<FileTransfer['status'], { label: string; cls: string; icon: React.ReactNode }> = {
  preparing: { label: 'Preparing', cls: 'text-cyan-300', icon: <Loader2 className="w-4 h-4 animate-spin text-cyan-400" /> },
  running: { label: 'In progress', cls: 'text-cyan-300', icon: <Loader2 className="w-4 h-4 animate-spin text-cyan-400" /> },
  paused: { label: 'Paused - resume files below to carry on', cls: 'text-amber-300', icon: <Pause className="w-4 h-4 text-amber-400" /> },
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
    <div className="space-y-3">
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
              className={`h-full transition-[width] duration-500 ${t.status === 'paused' ? 'bg-amber-500' : 'bg-cyan-500'} ${t.status === 'preparing' ? 'animate-pulse w-full opacity-40' : ''}`}
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
    <TransferFiles t={t} />
    </div>
  );
}

const FILE_STATE: Record<TransferFileState, { label: string; icon: React.ReactNode }> = {
  copying: { label: 'Copying', icon: <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" /> },
  failed: { label: 'Failed', icon: <XCircle className="w-3.5 h-3.5 text-red-400" /> },
  paused: { label: 'Paused', icon: <Pause className="w-3.5 h-3.5 text-amber-400" /> },
  pending: { label: 'To copy', icon: <Circle className="w-3.5 h-3.5 text-slate-600" /> },
  done: { label: 'Copied', icon: <CheckCircle className="w-3.5 h-3.5 text-green-400" /> },
  skipped: { label: 'Not copied', icon: <MinusCircle className="w-3.5 h-3.5 text-slate-500" /> },
  cancelled: { label: 'Cancelled', icon: <Ban className="w-3.5 h-3.5 text-slate-500" /> },
};
const STATE_ORDER: TransferFileState[] = ['copying', 'failed', 'paused', 'pending', 'done', 'skipped', 'cancelled'];

function TransferFiles({ t }: { t: FileTransfer }) {
  const active = isTransferActive(t);
  const listing = useTransferFiles(t.id, active);
  const [state, setState] = useState<TransferFileState | 'all'>('all');
  const [needle, setNeedle] = useState('');
  const pause = usePauseTransferFiles(t.id);
  const data = listing.data?.id === t.id ? listing.data : undefined;
  // Polling stops with the job, so fetch once more when its status moves -
  // otherwise the list would freeze on its last "copying" snapshot.
  const { refetch } = listing;
  useEffect(() => { refetch(); }, [t.status, refetch]);

  const sorted = useMemo(() => sortTransferFiles(data?.files ?? []), [data]);
  const matching = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return sorted.filter(f => (state === 'all' || f.state === state) && (!q || f.rel.toLowerCase().includes(q)));
  }, [sorted, state, needle]);

  if (t.status === 'preparing') return null;
  if (!data) {
    return listing.isLoading
      ? <p className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading files…</p>
      : null;
  }
  if (!data.files.length) return null;

  const total = data.files.length;
  // Bulk actions follow the chips and the filter: "paused" -> Resume all.
  const pausable = active ? matching.filter(canPauseFile) : [];
  const resumable = active ? matching.filter(canResumeFile) : [];
  const setPaused = (files: TransferFile[], paused: boolean) =>
    pause.mutate({ paths: files.map(f => f.path), paused });
  return (
    <div className="rounded-xl border border-slate-700/70 bg-slate-800/20">
      <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3 pb-2">
        <Chip on={state === 'all'} onClick={() => setState('all')}>All {total}</Chip>
        {STATE_ORDER.filter(st => data.counts[st] > 0).map(st => (
          <Chip key={st} on={state === st} onClick={() => setState(st)}>
            {FILE_STATE[st].label} {data.counts[st]}
          </Chip>
        ))}
        {(pausable.length > 1 || resumable.length > 1) && (
          <span className="ml-auto flex gap-1.5">
            {pausable.length > 1 && (
              <BulkButton onClick={() => setPaused(pausable, true)} disabled={pause.isPending}>
                <Pause className="w-3 h-3" /> Pause {pausable.length}
              </BulkButton>
            )}
            {resumable.length > 1 && (
              <BulkButton onClick={() => setPaused(resumable, false)} disabled={pause.isPending}>
                <Play className="w-3 h-3" /> Resume {resumable.length}
              </BulkButton>
            )}
          </span>
        )}
      </div>
      {total > FILTER_FROM && (
        <div className="px-3 pb-2">
          <input
            value={needle}
            onChange={e => setNeedle(e.target.value)}
            placeholder="Filter files"
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
          />
        </div>
      )}
      <ul className="max-h-[40dvh] overflow-y-auto border-t border-slate-800 divide-y divide-slate-800/70">
        {matching.slice(0, MAX_ROWS).map(f => (
          <FileRow
            key={f.path}
            f={f}
            actions={active}
            busy={pause.isPending && !!pause.variables?.paths.includes(f.path)}
            onPause={paused => setPaused([f], paused)}
          />
        ))}
        {matching.length === 0 && <li className="px-3 py-4 text-xs text-slate-500 text-center">Nothing matches</li>}
      </ul>
      {(matching.length > MAX_ROWS || data.truncated) && (
        <p className="px-3 py-2 border-t border-slate-800 text-[11px] text-slate-500">
          {matching.length > MAX_ROWS && `Showing ${MAX_ROWS} of ${matching.length} - filter to find the rest. `}
          {data.truncated && `Only the first ${total} of ${t.total_files} files are listed.`}
        </p>
      )}
    </div>
  );
}

function FileRow({ f, actions, busy, onPause }: {
  f: TransferFile;
  /** The job is still running, so files can be paused / resumed. */
  actions: boolean;
  busy: boolean;
  onPause: (paused: boolean) => void;
}) {
  const pct = f.state === 'copying' && f.size ? ((f.done ?? 0) / f.size) * 100 : null;
  return (
    <li className="px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0" title={FILE_STATE[f.state].label}>
          {f.rename ? (f.state === 'done' ? <ArrowRightLeft className="w-3.5 h-3.5 text-green-400" /> : FILE_STATE[f.state].icon) : FILE_STATE[f.state].icon}
        </span>
        <span
          className={`flex-1 min-w-0 truncate ${f.state === 'done' ? 'text-slate-400' : 'text-slate-200'}`}
          title={f.rel}
        >
          {f.rel}
        </span>
        <span className="shrink-0 text-slate-500 tabular-nums">
          {f.rename ? 'moved' : pct != null ? `${Math.round(pct)}% of ${formatBytes(f.size)}` : formatBytes(f.size)}
        </span>
        {actions && (
          <span className="shrink-0 w-6 flex justify-end">
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />
            ) : canPauseFile(f) ? (
              <button
                onClick={() => onPause(true)}
                title="Pause this file"
                aria-label={`Pause ${f.rel}`}
                className="p-0.5 rounded text-slate-500 hover:text-amber-300 hover:bg-slate-700/60 transition-colors"
              >
                <Pause className="w-3.5 h-3.5" />
              </button>
            ) : canResumeFile(f) ? (
              <button
                onClick={() => onPause(false)}
                title="Resume this file (carries on from the bytes already copied)"
                aria-label={`Resume ${f.rel}`}
                className="p-0.5 rounded text-amber-300 hover:text-cyan-300 hover:bg-slate-700/60 transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
            ) : null}
          </span>
        )}
      </div>
      {pct != null && (
        <div className="mt-1 ml-5 h-1 rounded-full bg-slate-700 overflow-hidden">
          <div className="h-full bg-cyan-400/70 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {f.error && <p className="ml-5 mt-0.5 text-red-300 break-words">{f.error}</p>}
    </li>
  );
}

function BulkButton({ onClick, disabled, children }: { onClick: () => void; disabled: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300 hover:text-white disabled:opacity-50 transition-colors"
    >
      {children}
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
        on ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200' : 'border-slate-700 text-slate-400 hover:text-white'
      }`}
    >
      {children}
    </button>
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
  const [picked, setPicked] = useState<string | null>(null);
  // The picked tab, or - before a pick, or once it's dismissed - the first
  // running job, else the newest.
  const current = transfers.find(t => t.id === picked)
    ?? transfers.find(isTransferActive) ?? transfers[0];

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full sm:max-w-2xl max-h-[90dvh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <h3 className="text-white font-medium">Copy &amp; move</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        {transfers.length > 1 && (
          <div role="tablist" className="flex gap-1 px-5 pb-3 overflow-x-auto shrink-0">
            {transfers.map(t => {
              const on = t.id === current?.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setPicked(t.id)}
                  title={transferTitle(t)}
                  className={`flex items-center gap-1.5 shrink-0 max-w-[12rem] text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                    on ? 'border-cyan-500/60 bg-cyan-500/10 text-white' : 'border-slate-700 text-slate-400 hover:text-white'
                  }`}
                >
                  <span className="shrink-0">{STATUS[t.status].icon}</span>
                  <span className="truncate">{t.paths.length === 1 ? baseName(t.paths[0]) : `${t.paths.length} items`}</span>
                  {(t.status === 'running' || t.status === 'paused') && (
                    <span className="shrink-0 tabular-nums text-slate-500">{Math.floor(transferPercent(t))}%</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <div className="px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] overflow-y-auto">
          {current
            ? <TransferCard key={current.id} t={current} onOpenDest={onOpenDest} />
            : <p className="text-sm text-slate-400 py-6 text-center">No transfers right now</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

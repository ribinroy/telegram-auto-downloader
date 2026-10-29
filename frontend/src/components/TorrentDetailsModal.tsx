import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Magnet, X, Loader2, Search, File, Lock, ArrowDown, ArrowUp, Check, CheckCircle, Minus, Pencil, AlertTriangle, RotateCw } from 'lucide-react';
import { useTorrentDetails, useSetTorrentFilePriority, useRenameTorrent, useDownloadTorrentFiles } from '../hooks/useTorrents';
import { useLayoutContext } from './Layout';
import type { Download } from '../types';
import { notify, useErrorToast } from '../lib/notify';
import { formatBytes, formatTime } from '../utils/format';
import { commonRoot } from '../utils/torrent';
import type { TorrentClient, TorrentFile, TorrentFilePriority } from '../api';

/** Above this many files the list gets a filter box. */
const FILTER_FROM = 8;

const PRIORITY_LABEL: Record<TorrentFilePriority, string> = {
  skip: 'Skip', low: 'Low', normal: 'Normal', high: 'High', max: 'Max',
};

// Colours the per-file select, so a list's priorities read at a glance
const PRIORITY_TONE: Record<TorrentFilePriority, string> = {
  skip: 'text-slate-500 border-slate-700',
  low: 'text-slate-300 border-slate-600',
  normal: 'text-slate-300 border-slate-700',
  high: 'text-amber-300 border-amber-500/40',
  max: 'text-red-300 border-red-500/40',
};

function Checkbox({ state, onClick, label }: { state: boolean | 'some'; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-checked={state === 'some' ? 'mixed' : state}
      role="checkbox"
      className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
        state ? 'bg-purple-500 border-purple-500' : 'border-slate-500 hover:border-slate-300'
      }`}
    >
      {state === true && <Check className="w-3 h-3 text-white" />}
      {state === 'some' && <Minus className="w-3 h-3 text-white" />}
    </button>
  );
}

/** One file's pull to DownLee: the server's match, overridden by the
 *  WebSocket-fed downloads list while it runs (same idea as downleeState). */
function filePullState(file: TorrentFile, downloads: Download[], requested: boolean) {
  const transfer = file.downlee ?? null;
  const live = transfer?.message_id ? downloads.find(d => d.message_id === transfer.message_id) : undefined;
  const status = live?.status ?? transfer?.status ?? null;
  return {
    transfer,
    progress: live?.progress ?? transfer?.progress ?? 0,
    done: status === 'done',
    // `requested` bridges "accepted" -> the refetch that first reports it
    running: status === 'downloading' || status === 'waiting' || (!status && requested),
    retryable: (status === 'failed' || status === 'stopped') && !!transfer,
  };
}

/** The per-file DownLee control: pulled, in flight, retryable, or offered. */
function PullButton({ state, canPull, pulledWhole, onPull, onRetry }: {
  state: ReturnType<typeof filePullState>;
  canPull: boolean;
  pulledWhole: boolean;
  onPull: () => void;
  onRetry: () => void;
}) {
  if (state.done || (pulledWhole && !state.transfer)) {
    return (
      <span title={state.done ? 'On DownLee' : 'Pulled with the whole torrent'} className="shrink-0 p-1 text-green-400">
        <CheckCircle className="w-4 h-4" />
      </span>
    );
  }
  if (state.running) {
    return (
      <span title="Downloading to DownLee" className="shrink-0 flex items-center gap-1 px-1 text-cyan-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span className="text-[11px] tabular-nums">{Math.round(state.progress)}%</span>
      </span>
    );
  }
  if (state.retryable) {
    return (
      <button onClick={onRetry} title="Transfer to DownLee stopped - retry" aria-label="Retry the download to DownLee"
        className="shrink-0 p-1 rounded text-amber-300 hover:bg-amber-500/20">
        <RotateCw className="w-4 h-4" />
      </button>
    );
  }
  if (!canPull) return null;
  return (
    <button onClick={onPull} title="Download this file to DownLee" aria-label="Download this file to DownLee"
      className="shrink-0 flex items-center p-1 rounded border border-purple-400/40 bg-gradient-to-r from-purple-500/25 to-cyan-500/25 hover:from-purple-500/45 hover:to-cyan-500/45 transition-colors">
      <img src="/logo.png" alt="" className="w-3.5 h-3.5" />
      <ArrowDown className="w-3 h-3 text-white" />
    </button>
  );
}

function formatDate(seconds: number | null) {
  return seconds ? new Date(seconds * 1000).toLocaleString() : '—';
}

function Stat({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 rounded-lg bg-slate-900/50 border border-slate-700/50 px-3 py-2 ${wide ? 'col-span-2' : ''}`}>
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <div className="text-sm text-slate-200 tabular-nums truncate">{children}</div>
    </div>
  );
}

/** An in-place name editor: Enter or leaving the field saves, Escape cancels
 *  (without closing the modal). A file's extension starts unselected, so
 *  typing replaces the name and keeps the type. */
function InlineRename({ initial, onSubmit, onCancel, label, className = '' }: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  label: string;
  className?: string;
}) {
  const submit = (value: string) => {
    const name = value.trim();
    if (!name || name === initial) onCancel(); else onSubmit(name);
  };
  return (
    <input
      autoFocus
      defaultValue={initial}
      aria-label={label}
      onFocus={e => {
        const dot = initial.lastIndexOf('.');
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); submit(e.currentTarget.value); }
        if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
      }}
      onBlur={e => submit(e.currentTarget.value)}
      className={`min-w-0 bg-slate-900 border border-purple-500 rounded-md px-2 py-0.5 text-sm text-white focus:outline-none ${className}`}
    />
  );
}

function FileRow({ file, root, priorities, selected, onToggle, onPriority, renaming, onRenameStart, onRename, onRenameCancel, pull }: {
  file: TorrentFile;
  pull: ReactNode;
  root: string | null;
  priorities: TorrentFilePriority[];
  selected: boolean;
  onToggle: () => void;
  onPriority: (p: TorrentFilePriority) => void;
  renaming: boolean;
  onRenameStart: () => void;
  onRename: (name: string) => void;
  onRenameCancel: () => void;
}) {
  // Every path repeats the torrent's own folder; the header already says it
  const relative = root ? file.path.slice(root.length + 1) : file.path;
  const slash = relative.lastIndexOf('/');
  const dir = slash >= 0 ? relative.slice(0, slash + 1) : '';
  const name = slash >= 0 ? relative.slice(slash + 1) : relative;
  const skipped = !file.wanted;

  return (
    <li className={`group px-4 py-2 ${selected ? 'bg-purple-500/5' : ''}`}>
      <div className="flex items-center gap-2">
        <Checkbox state={selected} onClick={onToggle} label={`Select ${name}`} />
        <File className={`w-4 h-4 shrink-0 ${skipped ? 'text-slate-600' : 'text-slate-500'}`} />
        {renaming ? (
          <span className="flex-1 min-w-0 flex items-center gap-1 text-sm">
            {dir && <span className="shrink min-w-0 truncate text-slate-500">{dir}</span>}
            <InlineRename initial={name} label={`New name for ${name}`} onSubmit={onRename} onCancel={onRenameCancel} className="flex-1" />
          </span>
        ) : (
          <>
            <span className={`flex-1 min-w-0 truncate text-sm ${skipped ? 'line-through decoration-slate-600' : ''}`} title={file.path}>
              {dir && <span className="text-slate-500">{dir}</span>}
              <span className={skipped ? 'text-slate-500' : 'text-slate-200'}>{name}</span>
            </span>
            {/* Shown on hover with a mouse; always there on touch */}
            <button
              onClick={onRenameStart}
              aria-label={`Rename ${name}`}
              title="Rename on the VPS"
              className="shrink-0 p-1 rounded text-slate-500 hover:text-white hover:bg-slate-700/60 [@media(pointer:fine)]:opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        {pull}
        <span className="hidden sm:inline shrink-0 w-20 whitespace-nowrap text-right text-xs tabular-nums text-slate-400">
          {formatBytes(file.size)}
        </span>
        <select
          value={file.priority}
          onChange={e => onPriority(e.target.value as TorrentFilePriority)}
          aria-label={`Priority of ${name}`}
          className={`shrink-0 bg-slate-900/70 border rounded-md py-0.5 pl-1.5 pr-1 text-xs focus:outline-none focus:border-purple-500 ${PRIORITY_TONE[file.priority]}`}
        >
          {priorities.map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
      </div>
      {!skipped && (
        <div className="mt-1.5 ml-12 flex items-center gap-2">
          <div className="flex-1 h-1 rounded-full bg-slate-700 overflow-hidden">
            <div
              className={`h-full transition-[width] duration-300 ${file.percent_done >= 100 ? 'bg-green-500' : 'bg-cyan-500'}`}
              style={{ width: `${file.percent_done}%` }}
            />
          </div>
          <span className="shrink-0 w-12 text-right text-[11px] tabular-nums text-slate-500">
            {file.percent_done >= 100 ? 'done' : `${file.percent_done.toFixed(1)}%`}
          </span>
        </div>
      )}
    </li>
  );
}

/**
 * One torrent in depth: transfer totals, its files with per-file progress,
 * and its trackers. Live while open (5s) until the torrent completes.
 */
export function TorrentDetailsModal({ client, hash, name, pulled = false, onClose }: {
  client: TorrentClient;
  hash: string;
  /** Shown while the details load, so the header isn't blank. */
  name: string;
  /** Already pulled to DownLee - renaming its folder breaks that match. */
  pulled?: boolean;
  onClose: () => void;
}) {
  const details = useTorrentDetails(client, hash);
  useErrorToast(details.error, "Couldn't load the torrent");
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const setPriority = useSetTorrentFilePriority(client, hash);
  useErrorToast(setPriority.error, "Couldn't change the file priority");
  const rename = useRenameTorrent(client, hash);
  useErrorToast(rename.error, 'Rename failed');
  const { downloads, onRetry } = useLayoutContext();
  const pullFiles = useDownloadTorrentFiles(client, hash);
  // Files whose pull was accepted but isn't in a refetched `downlee` yet
  const [requested, setRequested] = useState<Set<number>>(new Set());
  const runPull = (indices: number[]) => {
    if (indices.length === 0) return;
    pullFiles.mutate(indices, {
      onSuccess: ({ started, errors }) => {
        setRequested(prev => new Set([...prev, ...started.map(s => s.index)]));
        if (started.length) {
          notify({ type: 'success', title: 'Downloading to DownLee', message: `${started.length} file${started.length !== 1 ? 's' : ''}` });
        }
        if (errors.length) {
          notify({ type: 'error', title: "Couldn't start the download", message: errors.length === 1 ? errors[0].error : `${errors.length} files: ${errors[0].error}` });
        }
      },
      onError: e => notify({ type: 'error', title: "Couldn't start the download", message: e.message }),
    });
  };
  // What is being renamed: a file's index, the torrent itself, or nothing
  const [renaming, setRenaming] = useState<number | 'torrent' | null>(null);
  const runRename = (newName: string, path?: string) => {
    setRenaming(null);
    rename.mutate({ name: newName, path }, {
      onSuccess: () => notify({ type: 'success', title: 'Renamed', message: newName }),
    });
  };

  // Escape closes; the page behind doesn't scroll while the modal is up
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const data = details.data;
  const t = data?.torrent;
  const files = useMemo(() => {
    const all = [...(data?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    const q = filter.trim().toLowerCase();
    return q ? all.filter(f => f.path.toLowerCase().includes(q)) : all;
  }, [data?.files, filter]);
  const root = useMemo(() => commonRoot((data?.files ?? []).map(f => f.path)), [data?.files]);
  const fileCount = data?.files.length ?? 0;
  const selectedInView = files.filter(f => selected.has(f.index));
  const allState: boolean | 'some' = selectedInView.length === 0 ? false
    : selectedInView.length === files.length ? true : 'some';
  const toggle = (index: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  // Select-all works on what the filter shows: filter "sample", select all, Skip
  const toggleAll = () => setSelected(allState === true ? new Set() : new Set(files.map(f => f.index)));
  const applyToSelected = (priority: TorrentFilePriority) => {
    setPriority.mutate({ indices: [...selected], priority });
    setSelected(new Set());
  };
  const skippedCount = data?.files.filter(f => !f.wanted).length ?? 0;
  const active = t ? t.status === 'downloading' || t.status === 'seeding' : false;
  // Until the torrent completes, the client keeps even finished files in its
  // temp dir and moves them at the end - so files are pullable only after that
  const complete = !!t && t.percent_done >= 100 && t.status !== 'checking' && t.status !== 'check-wait';
  const pullState = (f: TorrentFile) => filePullState(f, downloads, requested.has(f.index));
  const isPullable = (f: TorrentFile) => {
    if (!complete || !f.wanted || f.percent_done < 100) return false;
    const st = pullState(f);
    return !st.done && !st.running && !st.retryable && !(pulled && !st.transfer);
  };
  const pullableSelected = (data?.files ?? []).filter(f => selected.has(f.index) && isPullable(f));

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="torrent-title"
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-2xl max-h-[88dvh] flex flex-col bg-slate-800 border border-slate-700 rounded-t-2xl sm:rounded-2xl shadow-2xl pb-[env(safe-area-inset-bottom)]"
      >
        {/* Header */}
        <div className="shrink-0 flex items-start gap-3 px-4 pt-4 pb-3 border-b border-slate-700/60">
          <Magnet className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            {renaming === 'torrent' && t ? (
              <>
                <InlineRename initial={t.name} label="New torrent name" onSubmit={n => runRename(n)} onCancel={() => setRenaming(null)} className="w-full" />
                {/* What this rename actually does differs per client - say so */}
                <p className="mt-1 text-[11px] text-slate-400">
                  {data.rename_renames_folder
                    ? 'Renames its folder on the VPS too.'
                    : 'Changes the name shown in the client; the folder on the VPS keeps its name.'}
                </p>
                {data.rename_renames_folder && pulled && (
                  <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-300">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    Already pulled to DownLee - after this the panel won't recognise it as downloaded.
                  </p>
                )}
              </>
            ) : (
              <h2 id="torrent-title" className="group text-base font-semibold text-white break-words">
                {t?.name ?? name}
                {t && (
                  <button
                    onClick={() => setRenaming('torrent')}
                    aria-label="Rename torrent"
                    title="Rename torrent"
                    className="ml-1.5 inline-flex align-middle p-1 rounded text-slate-500 hover:text-white hover:bg-slate-700/60"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </h2>
            )}
            {t && (
              <p className="text-xs text-slate-400 capitalize">
                {t.status.replace('-', ' ')} · {t.percent_done}% of {formatBytes(t.total_size)}
                {data.info.private && <span className="normal-case"> · <Lock className="inline w-3 h-3 -mt-0.5" /> private</span>}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {!data ? (
            <div className="flex items-center justify-center py-16 text-slate-400">
              {details.isError
                ? <p className="text-sm">Couldn't load this torrent</p>
                : <Loader2 className="w-7 h-7 animate-spin text-purple-400" />}
            </div>
          ) : (
            <>
              {/* Overall progress */}
              <div className="px-4 pt-4">
                <div className="h-2 rounded-full bg-slate-700 overflow-hidden">
                  <div
                    className={`h-full transition-[width] duration-300 ${active ? 'progress-shimmer' : t!.percent_done >= 100 ? 'bg-green-500' : 'bg-slate-500'}`}
                    style={{ width: `${t!.percent_done}%` }}
                  />
                </div>
              </div>

              {/* Details */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-4">
                <Stat label="Speed">
                  <span className="inline-flex items-center gap-1"><ArrowDown className="w-3 h-3 text-cyan-400" />{formatBytes(t!.rate_download)}/s</span>
                  {' '}
                  <span className="inline-flex items-center gap-1"><ArrowUp className="w-3 h-3 text-green-400" />{formatBytes(t!.rate_upload)}/s</span>
                </Stat>
                <Stat label="ETA">{t!.eta != null && t!.percent_done < 100 ? formatTime(t!.eta) : '—'}</Stat>
                <Stat label="Downloaded">{formatBytes(data.info.downloaded)}</Stat>
                <Stat label="Uploaded · ratio">
                  {formatBytes(data.info.uploaded)}{data.info.ratio != null && ` · ${data.info.ratio.toFixed(2)}`}
                </Stat>
                <Stat label="Seeds">
                  {t!.seeds_connected}{t!.seeds_total != null ? ` / ${t!.seeds_total}` : ''}
                </Stat>
                <Stat label="Leeches">
                  {t!.leeches_connected}{t!.leeches_total != null ? ` / ${t!.leeches_total}` : ''}
                </Stat>
                <Stat label="Added">{formatDate(data.info.added_date)}</Stat>
                <Stat label="Completed">{formatDate(data.info.done_date)}</Stat>
                <Stat label="Saved to" wide><span title={t!.download_dir}>{t!.download_dir || '—'}</span></Stat>
                <Stat label="Pieces" wide>
                  {data.info.piece_count != null && data.info.piece_size != null
                    ? `${data.info.piece_count.toLocaleString()} × ${formatBytes(data.info.piece_size)}`
                    : '—'}
                </Stat>
                {data.info.comment && (
                  <div className="col-span-2 sm:col-span-4 rounded-lg bg-slate-900/50 border border-slate-700/50 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500">Comment</p>
                    <p className="text-sm text-slate-300 break-words">{data.info.comment}</p>
                  </div>
                )}
                {t!.error && (
                  <div className="col-span-2 sm:col-span-4 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-300">
                    {t!.error}
                  </div>
                )}
              </div>

              {/* Files */}
              <section className="border-t border-slate-700/60">
                <div className="flex items-center gap-3 px-4 pt-3 pb-2">
                  {files.length > 0 && (
                    <Checkbox state={allState} onClick={toggleAll} label={filter ? 'Select the files shown' : 'Select all files'} />
                  )}
                  <h3 className="min-w-0 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Files · {fileCount}{skippedCount > 0 && ` (${skippedCount} skipped)`}
                    {root && <span className="block normal-case tracking-normal font-normal text-slate-500 truncate" title={root}>in {root}/</span>}
                  </h3>
                  {fileCount > FILTER_FROM && (
                    <label className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-1 w-44 sm:w-56 focus-within:border-purple-500">
                      <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <input
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder="Filter files"
                        className="w-full bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
                      />
                    </label>
                  )}
                </div>
                {files.length === 0 ? (
                  <p className="px-4 pb-4 text-sm text-slate-500">
                    {fileCount === 0 ? 'No file list yet - a magnet has none until its metadata arrives.' : 'No file matches'}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-700/40 pb-2">
                    {files.map(f => (
                      <FileRow
                        key={f.index}
                        file={f}
                        root={root}
                        priorities={data.priorities}
                        selected={selected.has(f.index)}
                        onToggle={() => toggle(f.index)}
                        onPriority={p => setPriority.mutate({ indices: [f.index], priority: p })}
                        renaming={renaming === f.index}
                        onRenameStart={() => setRenaming(f.index)}
                        onRename={n => runRename(n, f.path)}
                        onRenameCancel={() => setRenaming(null)}
                        pull={
                          <PullButton
                            state={pullState(f)}
                            canPull={isPullable(f)}
                            pulledWhole={pulled}
                            onPull={() => runPull([f.index])}
                            onRetry={() => { const id = f.downlee?.id; if (id != null) onRetry(id); }}
                          />
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>

              {/* Bulk priority for the selected files - pinned to the bottom of
                  the scroll area while there is a selection, and collapsed to
                  nothing (no reserved space) when there isn't */}
              <div
                inert={selected.size === 0}
                className={`sticky bottom-0 z-10 flex justify-center px-3 overflow-hidden transition-[max-height,opacity,padding] duration-200 ease-out motion-reduce:transition-none ${
                  selected.size > 0 ? 'max-h-32 opacity-100 py-2' : 'max-h-0 opacity-0 py-0'
                }`}
              >
                <div className="flex flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-slate-600/60 bg-slate-900/95 backdrop-blur-md shadow-2xl shadow-black/50 px-3 py-2">
                  <span className="text-sm text-slate-300 mr-1">{selected.size} selected</span>
                  {data.priorities.map(p => (
                    <button
                      key={p}
                      onClick={() => applyToSelected(p)}
                      className={`text-xs px-2.5 py-1 rounded-lg border bg-slate-800 hover:bg-slate-700 transition-colors ${PRIORITY_TONE[p]}`}
                    >
                      {PRIORITY_LABEL[p]}
                    </button>
                  ))}
                  {pullableSelected.length > 0 && (
                    <button
                      onClick={() => { runPull(pullableSelected.map(f => f.index)); setSelected(new Set()); }}
                      disabled={pullFiles.isPending}
                      className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-purple-400/40 text-white bg-gradient-to-r from-purple-500/30 to-cyan-500/30 hover:from-purple-500/45 hover:to-cyan-500/45 transition-colors disabled:opacity-50"
                    >
                      <img src="/logo.png" alt="" className="w-3.5 h-3.5" />
                      To DownLee{pullableSelected.length < selected.size ? ` (${pullableSelected.length})` : ''}
                    </button>
                  )}
                  <button onClick={() => setSelected(new Set())} className="text-xs px-1.5 text-slate-500 hover:text-white">Clear</button>
                </div>
              </div>

              {/* Trackers */}
              {data.info.trackers.length > 0 && (
                <section className="border-t border-slate-700/60 pb-3">
                  <h3 className="px-4 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    Trackers · {data.info.trackers.length}
                  </h3>
                  <ul className="divide-y divide-slate-700/40">
                    {data.info.trackers.map((tr, i) => (
                      <li key={`${tr.host}-${i}`} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                        <span className="flex-1 min-w-0 truncate text-slate-300" title={tr.message ?? undefined}>{tr.host}</span>
                        {tr.message && <span className="hidden sm:inline max-w-[14rem] truncate text-xs text-slate-500">{tr.message}</span>}
                        <span className="shrink-0 text-xs tabular-nums text-slate-400">
                          {tr.seeds ?? '–'} seeds · {tr.leeches ?? '–'} leeches
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

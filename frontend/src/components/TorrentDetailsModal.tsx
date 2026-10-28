import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Magnet, X, Loader2, Search, File, Lock, ArrowDown, ArrowUp } from 'lucide-react';
import { useTorrentDetails } from '../hooks/useTorrents';
import { useErrorToast } from '../lib/notify';
import { formatBytes, formatTime } from '../utils/format';
import { commonRoot } from '../utils/torrent';
import type { TorrentClient, TorrentFile } from '../api';

/** Above this many files the list gets a filter box. */
const FILTER_FROM = 8;

const PRIORITY_BADGE: Partial<Record<TorrentFile['priority'], string>> = {
  skip: 'bg-slate-700/60 text-slate-400',
  low: 'bg-slate-700/60 text-slate-300',
  high: 'bg-amber-500/15 text-amber-300',
  max: 'bg-red-500/15 text-red-300',
};

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

function FileRow({ file, root }: { file: TorrentFile; root: string | null }) {
  // Every path repeats the torrent's own folder; the header already says it
  const relative = root ? file.path.slice(root.length + 1) : file.path;
  const slash = relative.lastIndexOf('/');
  const dir = slash >= 0 ? relative.slice(0, slash + 1) : '';
  const name = slash >= 0 ? relative.slice(slash + 1) : relative;
  const badge = PRIORITY_BADGE[file.priority];
  const skipped = !file.wanted;

  return (
    <li className={`px-4 py-2 ${skipped ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2">
        <File className="w-4 h-4 shrink-0 text-slate-500" />
        <span className="flex-1 min-w-0 truncate text-sm" title={file.path}>
          {dir && <span className="text-slate-500">{dir}</span>}
          <span className="text-slate-200">{name}</span>
        </span>
        {badge && (
          <span className={`shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${badge}`}>
            {skipped ? 'skipped' : file.priority}
          </span>
        )}
        <span className="shrink-0 w-20 whitespace-nowrap text-right text-xs tabular-nums text-slate-400">
          {formatBytes(file.size)}
        </span>
      </div>
      {!skipped && (
        <div className="mt-1.5 ml-6 flex items-center gap-2">
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
export function TorrentDetailsModal({ client, hash, name, onClose }: {
  client: TorrentClient;
  hash: string;
  /** Shown while the details load, so the header isn't blank. */
  name: string;
  onClose: () => void;
}) {
  const details = useTorrentDetails(client, hash);
  useErrorToast(details.error, "Couldn't load the torrent");
  const [filter, setFilter] = useState('');

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
  const skippedCount = data?.files.filter(f => !f.wanted).length ?? 0;
  const active = t ? t.status === 'downloading' || t.status === 'seeding' : false;

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
            <h2 id="torrent-title" className="text-base font-semibold text-white break-words">{t?.name ?? name}</h2>
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
                    {files.map(f => <FileRow key={f.index} file={f} root={root} />)}
                  </ul>
                )}
              </section>

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

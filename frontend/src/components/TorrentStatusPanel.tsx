import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Magnet, ArrowDown, ArrowUp, Play, Pause, Trash2, Loader2, Search, X,
} from 'lucide-react';
import { fetchTorrentList, torrentAction, type TorrentStatus } from '../api';
import { formatBytes, formatTime } from '../utils/format';
import { ConfirmDialog } from './ConfirmDialog';
import { ROUTES } from '../routes';
import { useNavigate } from 'react-router-dom';

const STATUS_STYLES: Record<TorrentStatus['status'], { label: string; cls: string }> = {
  downloading: { label: 'Downloading', cls: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  seeding: { label: 'Seeding', cls: 'bg-green-500/15 text-green-400 border-green-500/30' },
  stopped: { label: 'Paused', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  checking: { label: 'Checking', cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
  'check-wait': { label: 'Queued (check)', cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
  'download-wait': { label: 'Queued', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  'seed-wait': { label: 'Queued (seed)', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  unknown: { label: 'Unknown', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
};

export function TorrentStatusPanel() {
  const navigate = useNavigate();
  const [torrents, setTorrents] = useState<TorrentStatus[]>([]);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // IDs with an action in flight (buttons disabled), and the torrent pending removal.
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [removeTarget, setRemoveTarget] = useState<TorrentStatus | null>(null);
  const [search, setSearch] = useState('');
  // Guard against overlapping polls when a request runs longer than the interval.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetchTorrentList();
      setConfigured(res.configured);
      setError(res.error ?? null);
      setTorrents(res.torrents ?? []);
    } catch {
      setError('Failed to reach the torrent client');
    } finally {
      inFlight.current = false;
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const runAction = async (action: 'start' | 'stop' | 'remove', t: TorrentStatus, deleteData = false) => {
    setBusy(prev => new Set(prev).add(t.id));
    try {
      const res = await torrentAction(action, [t.id], deleteData);
      if (res.error) setError(res.error);
      await load();
    } finally {
      setBusy(prev => { const next = new Set(prev); next.delete(t.id); return next; });
    }
  };

  if (!loaded) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-slate-400">
        <Loader2 className="w-10 h-10 animate-spin text-purple-500" />
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-slate-400">
        <div className="text-center">
          <Magnet className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No torrent client configured</p>
          <button onClick={() => navigate(ROUTES.SETTINGS_VPS)} className="text-sm text-cyan-400 hover:text-cyan-300 mt-1">
            Configure Transmission in Settings
          </button>
        </div>
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const filtered = query ? torrents.filter(t => t.name.toLowerCase().includes(query)) : torrents;

  return (
    <div className="space-y-2">
      {/* Search */}
      <div className="relative mb-2">
        <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search torrents..."
          className="w-full bg-slate-800/50 border border-slate-700 rounded-lg py-2 pl-9 pr-9 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-colors"
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
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2.5 text-red-400 text-sm">{error}</div>
      )}

      {!error && torrents.length === 0 && (
        <div className="min-h-[40vh] flex items-center justify-center text-slate-400">
          <div className="text-center">
            <Magnet className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No torrents</p>
            <p className="text-sm text-slate-500 mt-1">Paste a magnet link on the downloads page to add one.</p>
          </div>
        </div>
      )}

      {!error && torrents.length > 0 && filtered.length === 0 && (
        <div className="min-h-[30vh] flex items-center justify-center text-slate-400">
          <div className="text-center">
            <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No torrents match "{search.trim()}"</p>
            <button onClick={() => setSearch('')} className="text-sm text-cyan-400 hover:text-cyan-300 mt-1">
              Clear search
            </button>
          </div>
        </div>
      )}

      {filtered.map(t => {
        const style = STATUS_STYLES[t.status] ?? STATUS_STYLES.unknown;
        const active = t.status === 'downloading';
        const paused = t.status === 'stopped';
        const isBusy = busy.has(t.id);
        return (
          <div key={t.hash} className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 sm:p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm sm:text-base text-white font-medium truncate min-w-0" title={t.name}>{t.name}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs border rounded-full px-2 py-0.5 ${style.cls}`}>{style.label}</span>
                <button
                  onClick={() => runAction(paused ? 'start' : 'stop', t)}
                  disabled={isBusy}
                  title={paused ? 'Resume' : 'Pause'}
                  className="p-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 rounded-lg transition-colors disabled:opacity-50"
                >
                  {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => setRemoveTarget(t)}
                  disabled={isBusy}
                  title="Remove torrent"
                  className="p-2 border border-red-500/40 bg-red-500/10 hover:bg-red-500/25 text-red-400 rounded-lg transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="mt-2 h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${active ? 'progress-shimmer' : 'bg-slate-500'}`}
                style={{ width: `${t.percent_done}%` }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 mt-1.5">
              <span>{t.percent_done}% of {formatBytes(t.total_size)}</span>
              {t.rate_download > 0 && (
                <span className="flex items-center gap-1"><ArrowDown className="w-3 h-3 text-cyan-400" />{formatBytes(t.rate_download)}/s</span>
              )}
              {t.rate_upload > 0 && (
                <span className="flex items-center gap-1"><ArrowUp className="w-3 h-3 text-green-400" />{formatBytes(t.rate_upload)}/s</span>
              )}
              {active && t.eta != null && <span>ETA {formatTime(t.eta)}</span>}
              <span className="truncate max-w-[220px]" title={t.download_dir}>{t.download_dir}</span>
            </div>

            {t.error && <p className="text-xs text-red-400 mt-1">{t.error}</p>}
          </div>
        );
      })}

      <ConfirmDialog
        isOpen={removeTarget !== null}
        title="Remove torrent?"
        message={`Remove "${removeTarget?.name}" from the torrent client. "Remove" keeps the downloaded files on the VPS; "Remove with data" also deletes them from the VPS (cannot be undone).`}
        confirmText="Remove"
        extraActionText="Remove with data"
        variant="danger"
        onConfirm={() => { const t = removeTarget; setRemoveTarget(null); if (t) runAction('remove', t, false); }}
        onExtraAction={() => { const t = removeTarget; setRemoveTarget(null); if (t) runAction('remove', t, true); }}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}

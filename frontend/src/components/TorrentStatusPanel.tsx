import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Magnet, ArrowDown, ArrowUp, Play, Pause, Trash2, Loader2, Search, X, Check, Sprout, Users,
} from 'lucide-react';
import { fetchTorrentList, torrentAction, downloadVpsFile, type TorrentStatus } from '../api';
import { formatBytes, formatTime } from '../utils/format';
import { ConfirmDialog } from './ConfirmDialog';
import { Tooltip } from './Tooltip';
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

export function TorrentStatusPanel({ onCountChange }: { onCountChange?: (n: number) => void } = {}) {
  const navigate = useNavigate();
  const [torrents, setTorrents] = useState<TorrentStatus[]>([]);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // IDs with an action in flight (buttons disabled), and the torrent pending removal.
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [removeTarget, setRemoveTarget] = useState<TorrentStatus | null>(null);
  const [search, setSearch] = useState('');
  // DownLee transfer state: torrents with a transfer being started / already started.
  const [dlBusy, setDlBusy] = useState<Set<number>>(new Set());
  const [dlStarted, setDlStarted] = useState<Set<number>>(new Set());
  // Multi-select: chosen torrent ids + whether the bulk remove dialog is open.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkRemove, setBulkRemove] = useState(false);
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
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [load]);

  // Report the torrent count up so the parent can show it in the tab label.
  useEffect(() => { onCountChange?.(torrents.length); }, [torrents.length, onCountChange]);

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

  // Run an action across all currently-selected torrents in one RPC call.
  const runBulkAction = async (action: 'start' | 'stop' | 'remove', deleteData = false) => {
    const ids = torrents.filter(t => selected.has(t.id)).map(t => t.id);
    if (ids.length === 0) return;
    setBusy(prev => { const next = new Set(prev); ids.forEach(i => next.add(i)); return next; });
    try {
      const res = await torrentAction(action, ids, deleteData);
      if (res.error) setError(res.error);
      await load();
    } finally {
      setBusy(prev => { const next = new Set(prev); ids.forEach(i => next.delete(i)); return next; });
      if (action === 'remove') setSelected(new Set());
    }
  };

  const toggleSelect = (id: number) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Pull a finished torrent's files from the VPS down to DownLee (home server).
  const downloadToDownlee = async (t: TorrentStatus) => {
    setError(null);
    setDlBusy(prev => new Set(prev).add(t.id));
    try {
      const remotePath = `${(t.download_dir || '').replace(/\/+$/, '')}/${t.name}`;
      const res = await downloadVpsFile(remotePath);
      if (res.error) setError(res.error);
      else setDlStarted(prev => new Set(prev).add(t.id));
    } catch {
      setError('Failed to start the download to DownLee');
    } finally {
      setDlBusy(prev => { const next = new Set(prev); next.delete(t.id); return next; });
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
  const sorted = [...torrents].sort((a, b) => b.added_date - a.added_date);
  const filtered = query ? sorted.filter(t => t.name.toLowerCase().includes(query)) : sorted;

  const selectedCount = torrents.filter(t => selected.has(t.id)).length;
  const allFilteredSelected = filtered.length > 0 && filtered.every(t => selected.has(t.id));
  const toggleSelectAll = () => setSelected(prev => {
    if (allFilteredSelected) {
      const next = new Set(prev);
      filtered.forEach(t => next.delete(t.id));
      return next;
    }
    return new Set([...prev, ...filtered.map(t => t.id)]);
  });
  const bulkBusy = torrents.some(t => selected.has(t.id) && busy.has(t.id));

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

      {/* Selection toolbar */}
      {filtered.length > 0 && (
        <div className="flex h-5 items-center gap-2 flex-wrap rounded-lg border border-slate-700/50 bg-slate-800/30 px-3 py-2">
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-2 text-sm text-slate-300 hover:text-white transition-colors"
            title={allFilteredSelected ? 'Deselect all' : 'Select all'}
          >
            <span className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              allFilteredSelected ? 'bg-purple-500 border-purple-500' : 'border-slate-500'
            }`}>
              {allFilteredSelected && <Check className="w-3 h-3 text-white" />}
            </span>
            {selectedCount > 0 ? `${selectedCount} selected` : 'Select all'}
          </button>

          {selectedCount > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={() => runBulkAction('start')}
                disabled={bulkBusy}
                className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-lg text-sm bg-slate-700/50 hover:bg-slate-600/50 text-slate-200 transition-colors disabled:opacity-50"
              >
                <Play className="w-4 h-4" /> Resume
              </button>
              <button
                onClick={() => runBulkAction('stop')}
                disabled={bulkBusy}
                className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-lg text-sm bg-slate-700/50 hover:bg-slate-600/50 text-slate-200 transition-colors disabled:opacity-50"
              >
                <Pause className="w-4 h-4" /> Pause
              </button>
              <button
                onClick={() => setBulkRemove(true)}
                disabled={bulkBusy}
                className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-lg text-sm border border-red-500/40 bg-red-500/10 hover:bg-red-500/25 text-red-400 transition-colors disabled:opacity-50"
              >
                {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="p-1.5 text-slate-400 hover:text-white transition-colors"
                title="Clear selection"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
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
        const done = t.percent_done >= 100;
        const dlInFlight = dlBusy.has(t.id);
        const dlDone = dlStarted.has(t.id);
        return (
          <div
            key={t.hash}
            className={`rounded-xl border bg-slate-800/30 p-3 sm:p-4 transition-colors ${
              selected.has(t.id) ? 'border-purple-500/60 bg-purple-500/5' : 'border-slate-700/50'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => toggleSelect(t.id)}
                className="shrink-0"
                title={selected.has(t.id) ? 'Deselect' : 'Select'}
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  selected.has(t.id) ? 'bg-purple-500 border-purple-500' : 'border-slate-500 hover:border-slate-300'
                }`}>
                  {selected.has(t.id) && <Check className="w-3 h-3 text-white" />}
                </span>
              </button>
              <span className="text-sm sm:text-base text-white font-medium truncate min-w-0 flex-1" title={t.name}>{t.name}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs border rounded-full px-2 py-0.5 ${style.cls}`}>{style.label}</span>
                {done && (
                  <Tooltip content={dlDone ? 'Sent to DownLee' : 'Download to DownLee'} position="top">
                    <button
                      onClick={() => downloadToDownlee(t)}
                      disabled={dlInFlight}
                      className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-lg font-medium text-white bg-gradient-to-r from-purple-500/30 to-cyan-500/30 border border-purple-400/40 hover:from-purple-500/45 hover:to-cyan-500/45 transition-colors disabled:opacity-50"
                    >
                      {dlInFlight
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : dlDone
                          ? <Check className="w-4 h-4 text-green-400" />
                          : <img src="/logo.png" alt="" className="w-4 h-4" />}
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>
                )}
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
              <span className="flex items-center gap-1" title="Seeds: connected / available in the swarm">
                <Sprout className="w-3 h-3 text-green-400" />
                {t.seeds_connected}{t.seeds_total != null ? `/${t.seeds_total}` : ''}
              </span>
              <span className="flex items-center gap-1" title="Leeches: connected / in the swarm">
                <Users className="w-3 h-3 text-amber-400" />
                {t.leeches_connected}{t.leeches_total != null ? `/${t.leeches_total}` : ''}
              </span>
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

      <ConfirmDialog
        isOpen={bulkRemove}
        title={`Remove ${selectedCount} torrent${selectedCount !== 1 ? 's' : ''}?`}
        message={`Remove ${selectedCount} selected torrent${selectedCount !== 1 ? 's' : ''} from the torrent client. "Remove" keeps the downloaded files on the VPS; "Remove with data" also deletes them from the VPS (cannot be undone).`}
        confirmText="Remove"
        extraActionText="Remove with data"
        variant="danger"
        onConfirm={() => { setBulkRemove(false); runBulkAction('remove', false); }}
        onExtraAction={() => { setBulkRemove(false); runBulkAction('remove', true); }}
        onCancel={() => setBulkRemove(false)}
      />
    </div>
  );
}

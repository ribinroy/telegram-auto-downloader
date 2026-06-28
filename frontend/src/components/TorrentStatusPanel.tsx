import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Magnet, ArrowDown, ArrowUp, Play, Pause, Trash2, Loader2, Search, X, Check, Sprout, Users, RotateCw,
} from 'lucide-react';
import { fetchTorrentList, torrentAction, downloadVpsFile, type TorrentStatus, type TorrentClient } from '../api';
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

export function TorrentStatusPanel({ client, onCountChange }: { client: TorrentClient; onCountChange?: (n: number) => void }) {
  const navigate = useNavigate();
  const [torrents, setTorrents] = useState<TorrentStatus[]>([]);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Hashes with an action in flight (buttons disabled), and the torrent pending removal.
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [removeTarget, setRemoveTarget] = useState<TorrentStatus | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortBy, setSortBy] = useState<'created' | 'name' | 'status'>('created');
  // DownLee transfer state: torrents with a transfer being started / already started.
  const [dlBusy, setDlBusy] = useState<Set<string>>(new Set());
  const [dlStarted, setDlStarted] = useState<Set<string>>(new Set());
  // Multi-select: chosen torrent hashes + whether the bulk remove dialog is open.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRemove, setBulkRemove] = useState(false);
  // Guard against overlapping polls when a request runs longer than the interval.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetchTorrentList(client);
      setConfigured(res.configured);
      setError(res.error ?? null);
      setTorrents(res.torrents ?? []);
    } catch {
      setError('Failed to reach the torrent client');
    } finally {
      inFlight.current = false;
      setLoaded(true);
    }
  }, [client]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [load]);

  // Report the torrent count up so the parent can show it in the tab label.
  // Route through a ref and depend only on the count, so an unstable callback
  // from the parent can never turn this into a render loop.
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;
  useEffect(() => { onCountChangeRef.current?.(torrents.length); }, [torrents.length]);

  const runAction = async (action: 'start' | 'stop' | 'remove' | 'verify', t: TorrentStatus, deleteData = false) => {
    setBusy(prev => new Set(prev).add(t.hash));
    try {
      const res = await torrentAction(client, action, [t.hash], deleteData);
      if (res.error) setError(res.error);
      await load();
    } finally {
      setBusy(prev => { const next = new Set(prev); next.delete(t.hash); return next; });
    }
  };

  // Run an action across all currently-selected torrents in one RPC call.
  const runBulkAction = async (action: 'start' | 'stop' | 'remove', deleteData = false) => {
    const hashes = torrents.filter(t => selected.has(t.hash)).map(t => t.hash);
    if (hashes.length === 0) return;
    setBusy(prev => { const next = new Set(prev); hashes.forEach(h => next.add(h)); return next; });
    try {
      const res = await torrentAction(client, action, hashes, deleteData);
      if (res.error) setError(res.error);
      await load();
    } finally {
      setBusy(prev => { const next = new Set(prev); hashes.forEach(h => next.delete(h)); return next; });
      if (action === 'remove') setSelected(new Set());
    }
  };

  const toggleSelect = (hash: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(hash) ? next.delete(hash) : next.add(hash);
    return next;
  });

  // Pull a finished torrent's files from the VPS down to DownLee (home server).
  const downloadToDownlee = async (t: TorrentStatus) => {
    setError(null);
    setDlBusy(prev => new Set(prev).add(t.hash));
    try {
      const remotePath = `${(t.download_dir || '').replace(/\/+$/, '')}/${t.name}`;
      const res = await downloadVpsFile(remotePath);
      if (res.error) setError(res.error);
      else setDlStarted(prev => new Set(prev).add(t.hash));
    } catch {
      setError('Failed to start the download to DownLee');
    } finally {
      setDlBusy(prev => { const next = new Set(prev); next.delete(t.hash); return next; });
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
  // Distinct statuses present, for the status filter dropdown.
  const statusesPresent = [...new Set(torrents.map(t => t.status))].sort();
  const comparators: Record<typeof sortBy, (a: TorrentStatus, b: TorrentStatus) => number> = {
    created: (a, b) => b.added_date - a.added_date,
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
    status: (a, b) => a.status.localeCompare(b.status) || b.added_date - a.added_date,
  };
  const filtered = torrents
    .filter(t => (query ? t.name.toLowerCase().includes(query) : true))
    .filter(t => (statusFilter ? t.status === statusFilter : true))
    .sort(comparators[sortBy]);

  const selectedCount = torrents.filter(t => selected.has(t.hash)).length;
  const allFilteredSelected = filtered.length > 0 && filtered.every(t => selected.has(t.hash));
  const toggleSelectAll = () => setSelected(prev => {
    if (allFilteredSelected) {
      const next = new Set(prev);
      filtered.forEach(t => next.delete(t.hash));
      return next;
    }
    return new Set([...prev, ...filtered.map(t => t.hash)]);
  });
  const bulkBusy = torrents.some(t => selected.has(t.hash) && busy.has(t.hash));

  return (
    <div className="space-y-2">
      {/* Toolbar: select-all · search · bulk actions (single row) */}
      <div className="flex items-center gap-2">
        {filtered.length > 0 && (
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-1.5 shrink-0 text-sm text-slate-300 hover:text-white transition-colors"
            title={allFilteredSelected ? 'Deselect all' : 'Select all'}
          >
            <span className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
              allFilteredSelected ? 'bg-purple-500 border-purple-500' : 'border-slate-500'
            }`}>
              {allFilteredSelected && <Check className="w-3.5 h-3.5 text-white" />}
            </span>
            {selectedCount > 0 && <span className="hidden sm:inline">{selectedCount}</span>}
          </button>
        )}

        <div className="relative flex-1 min-w-0">
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

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          title="Filter by status"
          className="shrink-0 bg-slate-800/50 border border-slate-700 rounded-lg py-2 px-2 text-sm text-white focus:outline-none focus:border-purple-500 transition-colors cursor-pointer max-w-[130px]"
        >
          <option value="">All statuses</option>
          {statusesPresent.map(s => (
            <option key={s} value={s}>{(STATUS_STYLES[s] ?? STATUS_STYLES.unknown).label}</option>
          ))}
        </select>

        {/* Sort field */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          title="Sort by"
          className="shrink-0 bg-slate-800/50 border border-slate-700 rounded-lg py-2 px-2 text-sm text-white focus:outline-none focus:border-purple-500 transition-colors cursor-pointer"
        >
          <option value="created">Created</option>
          <option value="name">Name</option>
          <option value="status">Status</option>
        </select>

        {selectedCount > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => runBulkAction('start')}
              disabled={bulkBusy}
              title="Resume selected"
              className="flex items-center gap-1.5 py-2 px-2.5 rounded-lg text-sm bg-slate-700/50 hover:bg-slate-600/50 text-slate-200 transition-colors disabled:opacity-50"
            >
              <Play className="w-4 h-4" /> <span className="hidden sm:inline">Resume</span>
            </button>
            <button
              onClick={() => runBulkAction('stop')}
              disabled={bulkBusy}
              title="Pause selected"
              className="flex items-center gap-1.5 py-2 px-2.5 rounded-lg text-sm bg-slate-700/50 hover:bg-slate-600/50 text-slate-200 transition-colors disabled:opacity-50"
            >
              <Pause className="w-4 h-4" /> <span className="hidden sm:inline">Pause</span>
            </button>
            <button
              onClick={() => setBulkRemove(true)}
              disabled={bulkBusy}
              title="Remove selected"
              className="flex items-center gap-1.5 py-2 px-2.5 rounded-lg text-sm border border-red-500/40 bg-red-500/10 hover:bg-red-500/25 text-red-400 transition-colors disabled:opacity-50"
            >
              {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} <span className="hidden sm:inline">Remove</span>
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
            <p>No torrents match the current filters</p>
            <button
              onClick={() => { setSearch(''); setStatusFilter(''); }}
              className="text-sm text-cyan-400 hover:text-cyan-300 mt-1"
            >
              Clear filters
            </button>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
      <div className="space-y-2 mt-4">
      {filtered.map(t => {
        const style = STATUS_STYLES[t.status] ?? STATUS_STYLES.unknown;
        const active = t.status === 'downloading';
        const paused = t.status === 'stopped';
        const isBusy = busy.has(t.hash);
        const done = t.percent_done >= 100;
        const dlInFlight = dlBusy.has(t.hash);
        const dlDone = dlStarted.has(t.hash);
        return (
          <div
            key={t.hash}
            className={`rounded-xl border bg-slate-800/30 p-3 sm:p-4 transition-colors ${
              selected.has(t.hash) ? 'border-purple-500/60 bg-purple-500/5' : 'border-slate-700/50'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => toggleSelect(t.hash)}
                className="shrink-0"
                title={selected.has(t.hash) ? 'Deselect' : 'Select'}
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  selected.has(t.hash) ? 'bg-purple-500 border-purple-500' : 'border-slate-500 hover:border-slate-300'
                }`}>
                  {selected.has(t.hash) && <Check className="w-3 h-3 text-white" />}
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

            {t.error && (
              <div className="mt-2 flex items-start justify-between gap-3 rounded-lg bg-red-500/10 border border-red-500/30 p-2">
                <p className="text-xs text-red-400 min-w-0">{t.error}</p>
                <button
                  onClick={() => runAction('verify', t)}
                  disabled={isBusy}
                  title="Recheck local data on the VPS, then start"
                  className="flex items-center gap-1.5 shrink-0 py-1 px-2 rounded-lg text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition-colors disabled:opacity-50"
                >
                  {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
                  Verify &amp; start
                </button>
              </div>
            )}
          </div>
        );
      })}
      </div>
      )}

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

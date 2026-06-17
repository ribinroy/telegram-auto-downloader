import { useCallback, useEffect, useRef, useState } from 'react';
import { Magnet, RefreshCw, ChevronDown, ChevronRight, ArrowDown, ArrowUp } from 'lucide-react';
import { fetchTorrentList, type TorrentStatus } from '../api';
import { formatBytes, formatTime } from '../utils/format';

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
  const [torrents, setTorrents] = useState<TorrentStatus[]>([]);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
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

  // Hide entirely until we know there is something to show.
  if (!loaded || !configured) return null;
  if (!error && torrents.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 mb-4 overflow-hidden">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-slate-700/20 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {collapsed ? <ChevronRight className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          <Magnet className="w-4 h-4 text-purple-400 shrink-0" />
          <span className="text-sm font-semibold text-white">Torrents</span>
          <span className="text-xs text-slate-400">({torrents.length})</span>
        </div>
        <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-2">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2.5 text-red-400 text-sm">{error}</div>
          )}
          {torrents.map(t => {
            const style = STATUS_STYLES[t.status] ?? STATUS_STYLES.unknown;
            const active = t.status === 'downloading';
            return (
              <div key={t.hash} className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-white truncate min-w-0" title={t.name}>{t.name}</span>
                  <span className={`text-xs border rounded-full px-2 py-0.5 shrink-0 ${style.cls}`}>{style.label}</span>
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
        </div>
      )}
    </div>
  );
}

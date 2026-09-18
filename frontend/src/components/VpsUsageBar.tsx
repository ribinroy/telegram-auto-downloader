import { useState } from 'react';
import { HardDrive, ArrowDown, ArrowUp, RefreshCw, AlertCircle, ChevronDown } from 'lucide-react';
import { useVpsUsage } from '../hooks/useVps';
import { fetchVpsUsage } from '../api';
import { formatBytes } from '../utils/format';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../api/queryKeys';

/** Capacity bar colour: quiet until it actually matters. */
function barColor(percent: number) {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 75) return 'bg-amber-500';
  return 'bg-cyan-500';
}

/**
 * Seedbox account usage: the per-user disk quota and what the torrent clients
 * have moved. Traffic is the clients' own counters, not the provider's metered
 * figure — seedhost exposes no per-account traffic on the box — so it is
 * labelled as such rather than implied to be the billed number.
 */
export function VpsUsageBar() {
  const { data, isLoading, isError } = useVpsUsage();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(qk.vpsUsage(), await fetchVpsUsage(true));
    } finally {
      setRefreshing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="mb-4 h-[58px] rounded-xl border border-slate-700/50 bg-slate-800/30 animate-pulse" />
    );
  }
  if (isError || !data) return null;

  const disk = data.disk;
  const percent = disk?.percent ?? null;
  const clients = data.clients.filter(c => !c.error);
  const failed = data.clients.filter(c => c.error);

  return (
    <div className="mb-4 rounded-xl border border-slate-700/50 bg-slate-800/30">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5 p-3">
        {/* Disk quota */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <HardDrive className="w-4 h-4 text-purple-400 shrink-0" />
            <span className="text-xs text-slate-400 truncate">
              {data.host ?? 'VPS'}
              {disk?.source === 'df' && (
                <span className="text-slate-500"> · shared volume (no quota set)</span>
              )}
            </span>
            {disk && (
              <span className="ml-auto text-xs text-white tabular-nums shrink-0">
                {formatBytes(disk.used)}
                {disk.limit ? <span className="text-slate-500"> / {formatBytes(disk.limit)}</span> : null}
              </span>
            )}
          </div>
          {disk && disk.limit > 0 ? (
            <div className="h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${barColor(percent ?? 0)}`}
                style={{ width: `${Math.min(100, percent ?? 0)}%` }}
              />
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              {data.disk_error ?? 'Disk usage unavailable'}
            </p>
          )}
          {percent !== null && (
            <p className="text-[11px] text-slate-500 mt-1">
              {percent}% of quota used · {formatBytes(Math.max(0, (disk?.limit ?? 0) - (disk?.used ?? 0)))} free
            </p>
          )}
        </div>

        {/* Traffic totals */}
        <div className="flex items-center gap-4 sm:gap-5 sm:border-l sm:border-slate-700/60 sm:pl-5 shrink-0">
          <div>
            <span className="flex items-center gap-1 text-[11px] text-slate-500">
              <ArrowDown className="w-3 h-3 text-cyan-400" /> Downloaded
            </span>
            <span className="text-sm text-white tabular-nums">{formatBytes(data.traffic.downloaded)}</span>
          </div>
          <div>
            <span className="flex items-center gap-1 text-[11px] text-slate-500">
              <ArrowUp className="w-3 h-3 text-green-400" /> Uploaded
            </span>
            <span className="text-sm text-white tabular-nums">{formatBytes(data.traffic.uploaded)}</span>
          </div>
          <div className="flex items-center gap-1">
            {clients.length > 0 && (
              <button
                onClick={() => setOpen(o => !o)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-700/50 hover:text-slate-200 transition-colors"
                title={open ? 'Hide per-client breakdown' : 'Per-client breakdown'}
              >
                <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
            )}
            <button
              onClick={refresh}
              disabled={refreshing}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-700/50 hover:text-slate-200 transition-colors"
              title="Refresh usage"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Per-client breakdown */}
      {open && (
        <div className="border-t border-slate-700/60 px-3 py-2.5 space-y-2">
          {clients.map(c => (
            <div key={c.client} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="capitalize text-slate-300 w-24 shrink-0">{c.client}</span>
              <span className="text-slate-400">
                <ArrowDown className="w-3 h-3 inline text-cyan-400" /> {formatBytes(c.downloaded ?? 0)}
              </span>
              <span className="text-slate-400">
                <ArrowUp className="w-3 h-3 inline text-green-400" /> {formatBytes(c.uploaded ?? 0)}
              </span>
              {c.ratio != null && <span className="text-slate-500">ratio {c.ratio}</span>}
              {!!c.session_uploaded && (
                <span className="text-slate-600">
                  this session {formatBytes(c.session_downloaded ?? 0)} ↓ / {formatBytes(c.session_uploaded)} ↑
                </span>
              )}
            </div>
          ))}
          {failed.map(c => (
            <div key={c.client} className="flex items-center gap-2 text-xs text-amber-400/90">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="capitalize">{c.client}</span>
              <span className="text-slate-500 truncate">{c.error}</span>
            </div>
          ))}
          <p className="text-[11px] text-slate-600 pt-1">
            Traffic is what the torrent clients report moving, not seedhost's metered figure —
            the box exposes no per-account counter. Check the seedhost panel for the billed number.
          </p>
        </div>
      )}
    </div>
  );
}

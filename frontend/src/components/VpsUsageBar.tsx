import { useState } from 'react';
import {
  HardDrive, ArrowDown, ArrowUp, RefreshCw, AlertCircle, ChevronDown, Server, Cpu, Activity,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useVpsUsage } from '../hooks/useVps';
import { fetchVpsUsage } from '../api';
import { formatBytes, formatSpeed } from '../utils/format';
import { qk } from '../api/queryKeys';

/** Capacity bar colour: quiet until it actually matters. */
function barColor(percent: number) {
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 75) return 'bg-amber-500';
  return 'bg-cyan-500';
}

/**
 * Seedbox usage. The top row is *yours* - the account's disk quota and what
 * your torrent clients have moved. The expanded section adds the per-client
 * split and then the shared machine's storage/load/uplink, deliberately muted
 * and captioned, because 382 TB of box traffic read as personal usage would be
 * badly misleading.
 *
 * Traffic is the clients' own counters, not seedhost's metered figure - the box
 * exposes no per-account accounting - so the panel says so rather than implying
 * it is the billed number.
 */
export function VpsUsageBar() {
  const { data, isLoading, isError } = useVpsUsage();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(false);
    try {
      qc.setQueryData(qk.vpsUsage(), await fetchVpsUsage(true));
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  };

  if (isLoading) {
    return <div className="mb-4 h-[62px] rounded-xl border border-slate-700/50 bg-slate-800/30 animate-pulse" />;
  }
  if (isError || !data) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-slate-700/50 bg-slate-800/30 px-3 py-2.5 text-xs text-slate-500">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        Could not read VPS usage.
      </div>
    );
  }

  const { disk, server } = data;
  const percent = disk?.percent ?? null;
  const clients = data.clients.filter(c => !c.error);
  const failed = data.clients.filter(c => c.error);
  // Nothing configured at all - don't render an empty shell.
  if (!disk && !server && clients.length === 0 && failed.length === 0) return null;

  const hasDetail = clients.length > 0 || failed.length > 0 || !!server;

  return (
    <div className="mb-4 rounded-xl border border-slate-700/50 bg-slate-800/30">
      {/* --- Your account ------------------------------------------------- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5 p-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <HardDrive className="w-4 h-4 text-purple-400 shrink-0" />
            <span className="text-xs text-slate-400 truncate">
              {data.host ?? 'VPS'}
              {disk?.source === 'df' && <span className="text-slate-500"> · no quota set</span>}
            </span>
            {disk && (
              <span className="ml-auto text-xs text-white tabular-nums shrink-0">
                {formatBytes(disk.used)}
                {disk.limit ? <span className="text-slate-500"> / {formatBytes(disk.limit)}</span> : null}
              </span>
            )}
          </div>
          {disk && disk.limit > 0 ? (
            <>
              <div className="h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${barColor(percent ?? 0)}`}
                  style={{ width: `${Math.min(100, percent ?? 0)}%` }}
                />
              </div>
              {percent !== null && (
                <p className="text-[11px] text-slate-500 mt-1">
                  {percent}% of quota · {formatBytes(Math.max(0, disk.limit - disk.used))} free
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-slate-500">{data.disk_error ?? 'Disk usage unavailable'}</p>
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
          <div className="flex items-center gap-1 ml-auto sm:ml-0">
            {hasDetail && (
              <button
                onClick={() => setOpen(o => !o)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-700/50 hover:text-slate-200 transition-colors"
                title={open ? 'Hide details' : 'Per-client split and server health'}
              >
                <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
            )}
            <button
              onClick={refresh}
              disabled={refreshing}
              className={`p-1.5 rounded-lg transition-colors ${
                refreshError ? 'text-amber-400' : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
              }`}
              title={refreshError ? 'Refresh failed - click to retry' : 'Refresh usage'}
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-700/60 px-3 py-2.5 space-y-2">
          {/* --- Per client ------------------------------------------------ */}
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
            </div>
          ))}
          {failed.map(c => (
            <div key={c.client} className="flex items-center gap-2 text-xs text-amber-400/90">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="capitalize">{c.client}</span>
              <span className="text-slate-500 truncate">{c.error}</span>
            </div>
          ))}
          <p className="text-[11px] text-slate-600">
            Traffic is what the torrent clients report moving, not seedhost's metered figure —
            the box exposes no per-account counter.
          </p>

          {/* --- The shared machine ---------------------------------------- */}
          {server && (
            <div className="pt-2.5 mt-1 border-t border-slate-700/40">
              <div className="flex items-center gap-1.5 mb-2">
                <Server className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span className="text-[11px] text-slate-500">
                  Shared server — all tenants, not your usage
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-500">
                {server.volume && (
                  <span className="flex items-center gap-1.5">
                    <HardDrive className="w-3 h-3 shrink-0" />
                    <span className="text-slate-400">{server.volume.mount}</span>
                    {formatBytes(server.volume.used)} / {formatBytes(server.volume.total)}
                    {server.volume.percent !== null && <span>({server.volume.percent}%)</span>}
                  </span>
                )}
                {server.load && (
                  <span className="flex items-center gap-1.5">
                    <Cpu className="w-3 h-3 shrink-0" />
                    load {server.load.load1} / {server.load.load5} / {server.load.load15}
                    {!!server.load.cores && (
                      <span className="text-slate-600">
                        on {server.load.cores} cores
                        {server.load.percent !== null && ` (${server.load.percent}%)`}
                      </span>
                    )}
                  </span>
                )}
                {server.net && (
                  <span className="flex items-center gap-1.5">
                    <Activity className="w-3 h-3 shrink-0" />
                    <span className="text-slate-400">{server.net.iface}</span>
                    {server.net.rx_rate !== undefined ? (
                      <>
                        {formatSpeed(server.net.rx_rate / 1024)} ↓ / {formatSpeed(server.net.tx_rate! / 1024)} ↑
                      </>
                    ) : (
                      <span className="text-slate-600">rate on next refresh</span>
                    )}
                    <span className="text-slate-600">
                      · {formatBytes(server.net.rx_bytes)} ↓ / {formatBytes(server.net.tx_bytes)} ↑ since boot
                    </span>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

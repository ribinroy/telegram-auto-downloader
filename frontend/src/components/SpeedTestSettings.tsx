import { useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowDown, ArrowUp, Cloud, Gauge, Loader2, Monitor, Play, Square, Trash2,
} from 'lucide-react';
import { measurePing, measureDownload, measureUpload } from '../api/speedtest';
import { describeClient, isInternetRunning, type InternetPhase, type SpeedTestRow } from '../api/internetSpeed';
import {
  useInternetSpeed, useStartInternetSpeed, useCancelInternetSpeed,
  useSpeedResults, useRecordBrowserResult, useDeleteSpeedResult,
} from '../hooks/useMisc';
import {
  pingStats, throughputMbps, recentMbps, formatMbps, formatMBps, type Sample, type PingStats,
} from '../utils/speedtest';
import { formatBytes } from '../utils/format';
import { notify, useErrorToast } from '../lib/notify';
import { ConfirmDialog } from './ConfirmDialog';

type Phase = 'idle' | 'ping' | 'download' | 'upload' | 'done';
const PHASE_SECONDS = 8;

const PHASE_LABEL: Record<Phase | InternetPhase, string> = {
  idle: 'Ready', servers: 'Finding the nearest server…', ping: 'Measuring latency…',
  download: 'Downloading…', upload: 'Uploading…', done: 'Done', error: 'Failed',
};

/**
 * Two speed tests and one shared history. The first measures the link
 * between *this* device and the DownLee box, timed by the browser; the
 * second the box's own uplink, run by the backend against Cloudflare. Both
 * record to the `speed_tests` table, so every device sees the same list.
 */
export function SpeedTestSettings() {
  return (
    <>
      <p className="text-sm text-slate-400 mb-4">
        Two links, measured separately: this device ↔ the DownLee server
        (<span className="text-slate-300">{window.location.host}</span>) is the ceiling for
        streaming and the file explorer; the server → internet is what downloads can reach.
      </p>
      <BrowserTest />
      <InternetTest />
      <History />
    </>
  );
}

// --- this device <-> the server ----------------------------------------------

function BrowserTest() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState(0);
  const [progress, setProgress] = useState(0);
  const [ping, setPing] = useState<PingStats | null>(null);
  const [down, setDown] = useState<{ mbps: number; bytes: number } | null>(null);
  const [up, setUp] = useState<{ mbps: number; bytes: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const record = useRecordBrowserResult();

  useEffect(() => () => abortRef.current?.abort(), []);

  const running = phase !== 'idle' && phase !== 'done';

  const onSamples = (samples: Sample[]) => {
    setLive(recentMbps(samples));
    setProgress(Math.min(1, samples[samples.length - 1].t / PHASE_SECONDS));
  };

  const run = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPing(null); setDown(null); setUp(null); setLive(0); setProgress(0);
    try {
      setPhase('ping');
      const p = pingStats(await measurePing(8, ctrl.signal));
      setPing(p);

      setPhase('download');
      setProgress(0);
      const d = await measureDownload(PHASE_SECONDS, onSamples, ctrl.signal);
      const dRes = { mbps: throughputMbps(d), bytes: d[d.length - 1].bytes };
      setDown(dRes);

      setPhase('upload');
      setLive(0); setProgress(0);
      const u = await measureUpload(PHASE_SECONDS, onSamples, ctrl.signal);
      const uRes = { mbps: throughputMbps(u), bytes: u[u.length - 1].bytes };
      setUp(uRes);

      setPhase('done');
      record.mutate({
        ping: p, download_mbps: dRes.mbps, upload_mbps: uRes.mbps,
        download_bytes: dRes.bytes, upload_bytes: uRes.bytes,
      }, {
        onError: (err) => notify({ type: 'error', title: 'Result not saved', message: err.message }),
      });
    } catch (err) {
      setPhase('idle');
      if ((err as Error).name === 'AbortError') return;
      notify({ type: 'error', title: 'Speed test failed', message: (err as Error).message });
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <Card
      icon={<Monitor className="w-4 h-4 text-cyan-400" />}
      title="This device ↔ server"
      status={PHASE_LABEL[phase]}
      running={running}
      onRun={run}
      onStop={() => abortRef.current?.abort()}
      runLabel={phase === 'done' ? 'Run again' : 'Run test'}
      live={phase === 'download' || phase === 'upload' ? { mbps: live, progress } : null}
      note={`Each transfer runs for up to ${PHASE_SECONDS}s and reads the steady rate after the first 0.3s. The server is a Python process, so a few Gbit/s is its own ceiling.`}
    >
      <Stats
        ping={ping} down={down} up={up}
        pinging={phase === 'ping'} downloading={phase === 'download'} uploading={phase === 'upload'}
        downHint="server → this device" upHint="this device → server"
      />
    </Card>
  );
}

// --- the server -> the internet ----------------------------------------------

function InternetTest() {
  const status = useInternetSpeed(true);
  const start = useStartInternetSpeed();
  const cancel = useCancelInternetSpeed();
  useErrorToast(start.error, 'Could not start');
  const s = status.data;
  const phase = s?.phase ?? 'idle';
  const running = isInternetRunning(phase);
  const r = s?.result;
  const meta = r?.meta ?? s?.meta;
  const where = [meta?.isp, meta?.location].filter(Boolean).join(' · ');
  const via = meta?.server ? `Test server: ${meta.server}.` : '';

  return (
    <Card
      icon={<Cloud className="w-4 h-4 text-cyan-400" />}
      title="Server → internet"
      status={phase === 'error' && s?.error ? `Failed: ${s.error}` : PHASE_LABEL[phase]}
      running={running}
      onRun={() => start.mutate()}
      onStop={() => cancel.mutate()}
      runLabel={phase === 'done' ? 'Run again' : 'Run test'}
      busy={start.isPending || cancel.isPending}
      live={phase === 'download' || phase === 'upload' ? { mbps: s?.live_mbps ?? 0, progress: s?.progress ?? 0 } : null}
      note={`Runs on the server against the nearest public LibreSpeed server, so it says what the box's own uplink does - whoever is looking.${where ? ` Connection: ${where}.` : ''}${via ? ` ${via}` : ''}`}
    >
      <Stats
        ping={r?.ping ?? null}
        down={r ? { mbps: r.download_mbps, bytes: r.download_bytes } : null}
        up={r ? { mbps: r.upload_mbps, bytes: r.upload_bytes } : null}
        pinging={phase === 'ping' || phase === 'servers'} downloading={phase === 'download'} uploading={phase === 'upload'}
        downHint={meta?.isp ? `from the internet (${meta.isp})` : 'internet → server'} upHint="server → internet"
      />
    </Card>
  );
}

// --- shared chrome ----------------------------------------------------------

function Card({ icon, title, status, running, busy, onRun, onStop, runLabel, live, note, children }: {
  icon: React.ReactNode; title: string; status: string; running: boolean; busy?: boolean;
  onRun: () => void; onStop: () => void; runLabel: string;
  live: { mbps: number; progress: number } | null; note: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-slate-700/30 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="text-white font-medium text-sm flex items-center gap-2">{icon} {title}</h3>
          <p className="text-xs text-slate-400 mt-0.5 truncate" title={status}>{status}</p>
        </div>
        {running ? (
          <button
            onClick={onStop}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm transition-colors disabled:opacity-50 shrink-0"
          >
            <Square className="w-4 h-4" /> Stop
          </button>
        ) : (
          <button
            onClick={onRun}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm transition-colors disabled:opacity-50 shrink-0"
          >
            <Play className="w-4 h-4" /> {runLabel}
          </button>
        )}
      </div>

      {live && (
        <div className="mb-4">
          <div className="flex items-end justify-between gap-3">
            <div className="text-3xl font-semibold text-white tabular-nums">
              {formatMbps(live.mbps)}
              <span className="text-sm text-slate-400 font-normal ml-2">{formatMBps(live.mbps)}</span>
            </div>
            <Loader2 className="w-5 h-5 text-cyan-400 animate-spin mb-1" />
          </div>
          <div className="h-1.5 mt-2 rounded-full bg-slate-700 overflow-hidden">
            <div className="h-full bg-cyan-500 transition-[width] duration-150" style={{ width: `${live.progress * 100}%` }} />
          </div>
        </div>
      )}

      {children}
      <p className="text-xs text-slate-500 mt-3">{note}</p>
    </div>
  );
}

function Stats({ ping, down, up, pinging, downloading, uploading, downHint, upHint }: {
  ping: PingStats | null; down: { mbps: number; bytes: number } | null; up: { mbps: number; bytes: number } | null;
  pinging: boolean; downloading: boolean; uploading: boolean; downHint: string; upHint: string;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Stat
        icon={<Activity className="w-4 h-4" />} label="Latency" active={pinging}
        value={ping ? `${ping.avg.toFixed(1)} ms` : pinging ? '…' : '—'}
        detail={ping ? `min ${ping.min.toFixed(1)} · jitter ${ping.jitter.toFixed(1)} ms` : 'round trip'}
      />
      <Stat
        icon={<ArrowDown className="w-4 h-4" />} label="Download" active={downloading}
        value={down ? formatMbps(down.mbps) : downloading ? '…' : '—'}
        detail={down ? `${formatMBps(down.mbps)} · ${formatBytes(down.bytes)} moved` : downHint}
      />
      <Stat
        icon={<ArrowUp className="w-4 h-4" />} label="Upload" active={uploading}
        value={up ? formatMbps(up.mbps) : uploading ? '…' : '—'}
        detail={up ? `${formatMBps(up.mbps)} · ${formatBytes(up.bytes)} moved` : upHint}
      />
    </div>
  );
}

function Stat({ icon, label, value, detail, active }: {
  icon: React.ReactNode; label: string; value: string; detail: string; active: boolean;
}) {
  return (
    <div className={`rounded-lg p-3 border ${active ? 'border-cyan-500/50 bg-cyan-500/5' : 'border-slate-700/60 bg-slate-800/40'}`}>
      <div className="flex items-center gap-1.5 text-xs text-slate-400">{icon}{label}</div>
      <div className="text-xl font-semibold text-white mt-1 tabular-nums">{value}</div>
      <div className="text-xs text-slate-500 mt-0.5 truncate" title={detail}>{detail}</div>
    </div>
  );
}

// --- history (the speed_tests table) ----------------------------------------

function History() {
  const [kind, setKind] = useState<'all' | 'browser' | 'internet'>('all');
  const results = useSpeedResults(kind);
  const del = useDeleteSpeedResult();
  const [confirm, setConfirm] = useState<SpeedTestRow | null>(null);
  useErrorToast(results.error, 'Could not load the history');
  const rows = results.data ?? [];

  return (
    <div className="bg-slate-700/30 rounded-lg p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-white font-medium text-sm flex items-center gap-2"><Gauge className="w-4 h-4 text-slate-400" /> Previous runs</h3>
          <p className="text-xs text-slate-400 mt-0.5">Every device's runs, kept on the server.</p>
        </div>
        <select
          value={kind}
          onChange={e => setKind(e.target.value as typeof kind)}
          className="bg-slate-800 text-slate-200 text-xs rounded-lg px-2 py-1.5 outline-none border border-slate-700"
          aria-label="Which runs"
        >
          <option value="all">All</option>
          <option value="browser">Device ↔ server</option>
          <option value="internet">Server → internet</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 py-4 text-center">{results.isLoading ? 'Loading…' : 'No runs yet.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-400 text-left">
                <th className="font-medium pb-2 pr-3">When</th>
                <th className="font-medium pb-2 pr-3">Link</th>
                <th className="font-medium pb-2 pr-3">Latency</th>
                <th className="font-medium pb-2 pr-3">Download</th>
                <th className="font-medium pb-2 pr-3">Upload</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {rows.map(h => (
                <tr key={h.id ?? h.at} className="border-t border-slate-700/60">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-slate-400">{new Date(h.at).toLocaleString()}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {h.kind === 'internet' ? (
                      <span className="inline-flex items-center gap-1.5" title={h.ip ?? undefined}>
                        <Cloud className="w-3.5 h-3.5 text-slate-400" /> {h.client || 'Internet'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5" title={`${h.client ?? ''}${h.ip ? ` (${h.ip})` : ''}`}>
                        <Monitor className="w-3.5 h-3.5 text-slate-400" /> {describeClient(h.client)}
                        {h.ip && <span className="text-slate-500 text-xs">{h.ip}</span>}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{h.ping.avg != null ? `${h.ping.avg.toFixed(1)} ms` : '—'}</td>
                  <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{formatMbps(h.download_mbps)}</td>
                  <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{formatMbps(h.upload_mbps)}</td>
                  <td className="py-1.5 text-right">
                    {h.id != null && (
                      <button
                        onClick={() => setConfirm(h)}
                        className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                        title="Delete this run"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!confirm}
        title="Delete this run?"
        message={confirm ? `${new Date(confirm.at).toLocaleString()} · ${formatMbps(confirm.download_mbps)} down, ${formatMbps(confirm.upload_mbps)} up` : ''}
        confirmText="Delete"
        variant="danger"
        onConfirm={() => {
          if (confirm?.id != null) del.mutate(confirm.id, {
            onError: (err) => notify({ type: 'error', title: 'Delete failed', message: err.message }),
          });
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Gauge, Loader2, Play, Square } from 'lucide-react';
import { measurePing, measureDownload, measureUpload } from '../api/speedtest';
import {
  pingStats, throughputMbps, recentMbps, formatMbps, formatMBps, loadHistory, pushHistory,
  type Sample, type SpeedTestResult, type PingStats,
} from '../utils/speedtest';
import { formatBytes } from '../utils/format';
import { notify } from '../lib/notify';

type Phase = 'idle' | 'ping' | 'download' | 'upload' | 'done';
const PHASE_SECONDS = 8;

/**
 * Browser <-> server throughput: how fast *this* device can pull from (and
 * push to) the DownLee box over whatever link is between them. Says whether
 * a stuttering stream is the Wi-Fi or the server.
 */
export function SpeedTestSettings() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState(0);
  const [progress, setProgress] = useState(0);
  const [ping, setPing] = useState<PingStats | null>(null);
  const [down, setDown] = useState<{ mbps: number; bytes: number } | null>(null);
  const [up, setUp] = useState<{ mbps: number; bytes: number } | null>(null);
  const [history, setHistory] = useState<SpeedTestResult[]>(() => loadHistory());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const running = phase !== 'idle' && phase !== 'done';

  const onSamples = (samples: Sample[]) => {
    setLive(recentMbps(samples));
    const last = samples[samples.length - 1];
    setProgress(Math.min(1, last.t / PHASE_SECONDS));
  };

  const run = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPing(null); setDown(null); setUp(null); setLive(0); setProgress(0);
    try {
      setPhase('ping');
      const rtts = await measurePing(8, ctrl.signal);
      const p = pingStats(rtts);
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
      setHistory(pushHistory({
        at: new Date().toISOString(), ping: p,
        downloadMbps: dRes.mbps, uploadMbps: uRes.mbps,
        downloadBytes: dRes.bytes, uploadBytes: uRes.bytes,
      }));
    } catch (err) {
      setPhase('idle');
      if ((err as Error).name === 'AbortError') return;
      notify({ type: 'error', title: 'Speed test failed', message: (err as Error).message });
    } finally {
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const phaseLabel: Record<Phase, string> = {
    idle: 'Ready', ping: 'Measuring latency…', download: 'Downloading…', upload: 'Uploading…', done: 'Done',
  };

  return (
    <>
      <p className="text-sm text-slate-400 mb-4">
        Measures the link between this browser and the DownLee server
        (<span className="text-slate-300">{window.location.host}</span>) - the ceiling for streaming
        and for the file explorer, not the server's own internet speed.
      </p>

      <div className="bg-slate-700/30 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h3 className="text-white font-medium text-sm flex items-center gap-2">
              <Gauge className="w-4 h-4 text-cyan-400" /> Speed test
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">{phaseLabel[phase]}</p>
          </div>
          {running ? (
            <button
              onClick={stop}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm transition-colors"
            >
              <Square className="w-4 h-4" /> Stop
            </button>
          ) : (
            <button
              onClick={run}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm transition-colors"
            >
              <Play className="w-4 h-4" /> {phase === 'done' ? 'Run again' : 'Run test'}
            </button>
          )}
        </div>

        {/* Live figure while a transfer runs */}
        {(phase === 'download' || phase === 'upload') && (
          <div className="mb-4">
            <div className="flex items-end justify-between gap-3">
              <div className="text-3xl font-semibold text-white tabular-nums">
                {formatMbps(live)}
                <span className="text-sm text-slate-400 font-normal ml-2">{formatMBps(live)}</span>
              </div>
              <Loader2 className="w-5 h-5 text-cyan-400 animate-spin mb-1" />
            </div>
            <div className="h-1.5 mt-2 rounded-full bg-slate-700 overflow-hidden">
              <div className="h-full bg-cyan-500 transition-[width] duration-150" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Stat
            icon={<Activity className="w-4 h-4" />}
            label="Latency"
            value={ping ? `${ping.avg.toFixed(1)} ms` : phase === 'ping' ? '…' : '—'}
            detail={ping ? `min ${ping.min.toFixed(1)} · jitter ${ping.jitter.toFixed(1)} ms` : 'API round trip'}
            active={phase === 'ping'}
          />
          <Stat
            icon={<ArrowDown className="w-4 h-4" />}
            label="Download"
            value={down ? formatMbps(down.mbps) : phase === 'download' ? '…' : '—'}
            detail={down ? `${formatMBps(down.mbps)} · ${formatBytes(down.bytes)} moved` : 'server → this device'}
            active={phase === 'download'}
          />
          <Stat
            icon={<ArrowUp className="w-4 h-4" />}
            label="Upload"
            value={up ? formatMbps(up.mbps) : phase === 'upload' ? '…' : '—'}
            detail={up ? `${formatMBps(up.mbps)} · ${formatBytes(up.bytes)} moved` : 'this device → server'}
            active={phase === 'upload'}
          />
        </div>

        <p className="text-xs text-slate-500 mt-3">
          Each transfer runs for up to {PHASE_SECONDS}s and reads the steady rate after the first 0.3s.
          The server is a Python process, so a few Gbit/s is its own ceiling.
        </p>
      </div>

      {history.length > 0 && (
        <div className="bg-slate-700/30 rounded-lg p-4">
          <h3 className="text-white font-medium text-sm mb-2">Previous runs</h3>
          <p className="text-xs text-slate-400 mb-3">Kept in this browser only - a phone on Wi-Fi and a wired desktop each have their own list.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 text-left">
                  <th className="font-medium pb-2 pr-3">When</th>
                  <th className="font-medium pb-2 pr-3">Latency</th>
                  <th className="font-medium pb-2 pr-3">Download</th>
                  <th className="font-medium pb-2">Upload</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {history.map(h => (
                  <tr key={h.at} className="border-t border-slate-700/60">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-slate-400">{new Date(h.at).toLocaleString()}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{h.ping.avg.toFixed(1)} ms</td>
                    <td className="py-1.5 pr-3 tabular-nums">{formatMbps(h.downloadMbps)}</td>
                    <td className="py-1.5 tabular-nums">{formatMbps(h.uploadMbps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
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

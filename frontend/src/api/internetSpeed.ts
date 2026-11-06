import { authFetch } from './index';
import type { PingStats } from '../utils/speedtest';

// Speed-test transport: the box's own uplink test (run by the backend
// against a public LibreSpeed server, started and polled from here - see
// backend/speedtest.py) and the shared `speed_tests` table both kinds of
// run are recorded in.

export interface InternetMeta {
  ip: string | null;
  isp: string | null;
  location: string | null;
  /** The LibreSpeed server the run went against. */
  server: string | null;
  server_url: string | null;
}

export type InternetPhase = 'idle' | 'servers' | 'ping' | 'download' | 'upload' | 'done' | 'error';

export interface InternetStatus {
  phase: InternetPhase;
  live_mbps: number;
  progress: number;
  result: SpeedTestRow | null;
  error: string | null;
  meta: InternetMeta | null;
}

export type SpeedTestKind = 'browser' | 'internet';

/** One row of `speed_tests`. `client` is the device (browser) or the ISP (internet). */
export interface SpeedTestRow {
  id: number | null;
  kind: SpeedTestKind;
  at: string;
  ping: PingStats;
  download_mbps: number;
  upload_mbps: number;
  download_bytes: number;
  upload_bytes: number;
  client: string | null;
  ip: string | null;
  meta: Partial<InternetMeta> | null;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, { cache: 'no-store', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export const fetchInternetSpeed = () => call<InternetStatus>('/api/speedtest/internet');
export const startInternetSpeed = () => call<InternetStatus>('/api/speedtest/internet', { method: 'POST' });
export const cancelInternetSpeed = () => call<{ cancelled: boolean }>('/api/speedtest/internet', { method: 'DELETE' });

export const isInternetRunning = (phase: InternetPhase | undefined) =>
  phase === 'servers' || phase === 'ping' || phase === 'download' || phase === 'upload';

export const fetchSpeedResults = (kind?: SpeedTestKind, limit = 20) =>
  call<{ results: SpeedTestRow[] }>(`/api/speedtest/results?limit=${limit}${kind ? `&kind=${kind}` : ''}`)
    .then(r => r.results);

export interface BrowserResultInput {
  ping: PingStats;
  download_mbps: number;
  upload_mbps: number;
  download_bytes: number;
  upload_bytes: number;
}

export const recordBrowserResult = (input: BrowserResultInput) =>
  call<SpeedTestRow>('/api/speedtest/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

export const deleteSpeedResult = (id: number) =>
  call<{ deleted: boolean }>(`/api/speedtest/results/${id}`, { method: 'DELETE' });

/** A short, human name for a user agent: "Chrome · macOS", "Safari · iPhone". */
export function describeClient(ua: string | null): string {
  if (!ua) return '—';
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /OculusBrowser/.test(ua) ? 'Quest Browser' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os =
    /iPhone/.test(ua) ? 'iPhone' :
    /iPad/.test(ua) ? 'iPad' :
    /Android/.test(ua) ? 'Android' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Windows/.test(ua) ? 'Windows' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

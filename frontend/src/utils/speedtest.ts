// Pure arithmetic for the network speed test, kept out of the component so
// it can be tested without a browser doing any transfers.

export interface Sample {
  /** Seconds since the transfer started. */
  t: number;
  /** Bytes transferred so far. */
  bytes: number;
}

export const toMbps = (bytes: number, seconds: number) =>
  seconds > 0 ? (bytes * 8) / seconds / 1_000_000 : 0;

/**
 * Throughput over a run of samples, ignoring the first `warmup` seconds:
 * TCP's slow start and the request itself make the opening fraction of a
 * second read low, and on a LAN the whole test is only a few seconds long.
 * With too little data past the warm-up, the whole run is used instead.
 */
export function throughputMbps(samples: Sample[], warmup = 0.3): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const start = samples.find(s => s.t >= warmup);
  if (start && start !== last && last.t - start.t >= 0.5) {
    return toMbps(last.bytes - start.bytes, last.t - start.t);
  }
  return toMbps(last.bytes, last.t);
}

/** Speed over the most recent `window` seconds - the live number on screen. */
export function recentMbps(samples: Sample[], window = 0.5): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let i = samples.length - 2;
  while (i > 0 && last.t - samples[i].t < window) i--;
  const from = samples[i];
  return toMbps(last.bytes - from.bytes, last.t - from.t);
}

export interface PingStats {
  min: number;
  avg: number;
  max: number;
  /** Mean absolute difference between consecutive round trips. */
  jitter: number;
}

export function pingStats(rtts: number[]): PingStats {
  if (!rtts.length) return { min: 0, avg: 0, max: 0, jitter: 0 };
  const min = Math.min(...rtts);
  const max = Math.max(...rtts);
  const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
  let diff = 0;
  for (let i = 1; i < rtts.length; i++) diff += Math.abs(rtts[i] - rtts[i - 1]);
  const jitter = rtts.length > 1 ? diff / (rtts.length - 1) : 0;
  return { min, avg, max, jitter };
}

export function formatMbps(mbps: number): string {
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbit/s`;
  if (mbps >= 100) return `${Math.round(mbps)} Mbit/s`;
  if (mbps >= 10) return `${mbps.toFixed(1)} Mbit/s`;
  return `${mbps.toFixed(2)} Mbit/s`;
}

/** The same figure the download list shows, for "what would a file do". */
export function formatMBps(mbps: number): string {
  const mb = mbps / 8;
  return mb >= 100 ? `${Math.round(mb)} MB/s` : `${mb.toFixed(1)} MB/s`;
}

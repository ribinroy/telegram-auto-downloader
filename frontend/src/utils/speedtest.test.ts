import { describe, it, expect, beforeEach } from 'vitest';
import {
  toMbps, throughputMbps, recentMbps, pingStats, formatMbps, formatMBps,
  loadHistory, pushHistory, HISTORY_SIZE, type Sample,
} from './speedtest';

const ramp = (seconds: number, bytesPerSec: number, step = 0.1): Sample[] => {
  const out: Sample[] = [];
  for (let t = 0; t <= seconds + 1e-9; t += step) out.push({ t: +t.toFixed(3), bytes: Math.round(t * bytesPerSec) });
  return out;
};

describe('toMbps', () => {
  it('converts bytes over seconds to megabits per second', () => {
    expect(toMbps(125_000_000, 1)).toBe(1000);
    expect(toMbps(0, 1)).toBe(0);
    expect(toMbps(1, 0)).toBe(0);
  });
});

describe('throughputMbps', () => {
  it('reads the steady rate past the warm-up', () => {
    // 10 MB/s = 80 Mbit/s, constant: warm-up or not, the answer is the same.
    expect(throughputMbps(ramp(4, 10_000_000))).toBeCloseTo(80, 5);
  });

  it('ignores a slow opening fraction of a second', () => {
    // Nothing for 0.3s, then 100 MB/s. Whole-run average would read 92.5.
    const s: Sample[] = [{ t: 0, bytes: 0 }, { t: 0.3, bytes: 0 }];
    for (let t = 0.4; t <= 4.001; t += 0.1) s.push({ t: +t.toFixed(3), bytes: Math.round((t - 0.3) * 100_000_000) });
    expect(throughputMbps(s)).toBeCloseTo(800, 0);
  });

  it('falls back to the whole run when there is too little past the warm-up', () => {
    const s: Sample[] = [{ t: 0, bytes: 0 }, { t: 0.5, bytes: 5_000_000 }];
    expect(throughputMbps(s)).toBeCloseTo(80, 5);
    expect(throughputMbps([])).toBe(0);
    expect(throughputMbps([{ t: 0, bytes: 0 }])).toBe(0);
  });
});

describe('recentMbps', () => {
  it('uses only the last half second', () => {
    const s = ramp(2, 1_000_000);               // 8 Mbit/s for 2s ...
    s.push({ t: 2.5, bytes: s[s.length - 1].bytes + 50_000_000 }); // ... then 800 Mbit/s
    expect(recentMbps(s)).toBeCloseTo(800, 0);
    expect(recentMbps([{ t: 0, bytes: 0 }])).toBe(0);
  });
});

describe('pingStats', () => {
  it('summarises round trips', () => {
    expect(pingStats([2, 4, 3])).toEqual({ min: 2, avg: 3, max: 4, jitter: 1.5 });
    expect(pingStats([5])).toEqual({ min: 5, avg: 5, max: 5, jitter: 0 });
    expect(pingStats([])).toEqual({ min: 0, avg: 0, max: 0, jitter: 0 });
  });
});

describe('formatting', () => {
  it('scales the unit with the speed', () => {
    expect(formatMbps(2345)).toBe('2.35 Gbit/s');
    expect(formatMbps(456.4)).toBe('456 Mbit/s');
    expect(formatMbps(45.67)).toBe('45.7 Mbit/s');
    expect(formatMbps(4.567)).toBe('4.57 Mbit/s');
    expect(formatMBps(800)).toBe('100 MB/s');
    expect(formatMBps(80)).toBe('10.0 MB/s');
  });
});

describe('history', () => {
  beforeEach(() => localStorage.clear());
  const result = (n: number) => ({
    at: `2026-01-0${n}T00:00:00Z`, ping: pingStats([n]),
    downloadMbps: n, uploadMbps: n, downloadBytes: n, uploadBytes: n,
  });

  it('keeps the newest runs first, capped', () => {
    expect(loadHistory()).toEqual([]);
    for (let i = 1; i <= HISTORY_SIZE + 2; i++) pushHistory(result(i % 10));
    const h = loadHistory();
    expect(h).toHaveLength(HISTORY_SIZE);
    expect(h[0].downloadMbps).toBe((HISTORY_SIZE + 2) % 10);
  });

  it('survives garbage in storage', () => {
    localStorage.setItem('downlee:speedtest:history', '{not json');
    expect(loadHistory()).toEqual([]);
    localStorage.setItem('downlee:speedtest:history', '{"a":1}');
    expect(loadHistory()).toEqual([]);
  });
});

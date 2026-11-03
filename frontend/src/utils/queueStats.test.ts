import { describe, it, expect } from 'vitest';
import { toDownloadBytes, toDownloadDetail, etaDetail } from './queueStats';
import type { Stats } from '../types';

const base: Stats = {
  total_downloaded: 0, total_size: 0, pending_bytes: 5, total_speed: 0,
  downloaded_count: 0, total_count: 0, all_count: 0, active_count: 0,
};

describe('toDownloadBytes', () => {
  it('uses running + waiting when the server reports it', () => {
    expect(toDownloadBytes({ ...base, remaining_bytes: 3 * 1024 })).toBe(3 * 1024);
  });
  it('falls back to pending_bytes from an older server', () => {
    expect(toDownloadBytes(base)).toBe(5);
  });
});

describe('toDownloadDetail', () => {
  it('splits running from waiting and names what is not counted', () => {
    const lines = toDownloadDetail({
      ...base, running_count: 1, running_bytes: 1024, waiting_count: 2, waiting_bytes: 2048, unsized_count: 1,
    });
    expect(lines).toEqual([
      'To download (running + waiting)',
      '1 running: 1.00 KB left',
      '2 waiting: 2.00 KB',
      '1 download of unknown size not counted',
    ]);
  });
});

describe('etaDetail', () => {
  it('says the waiting downloads are included', () => {
    expect(etaDetail({ ...base, remaining_bytes: 1024, eta_seconds: 10 }))
      .toContain('1.00 KB to go, waiting downloads included');
  });
  it('explains a missing ETA when nothing moves', () => {
    expect(etaDetail({ ...base, remaining_bytes: 1024, eta_seconds: null }))
      .toContain('Nothing is moving right now');
  });
});

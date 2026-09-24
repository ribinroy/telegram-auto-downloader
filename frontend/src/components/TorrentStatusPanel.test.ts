import { describe, it, expect } from 'vitest';
import { downleeState, isPendingPull, isAlreadyDownloaded } from './TorrentStatusPanel';
import type { TorrentStatus } from '../api';
import type { Download } from '../types';

const torrent = (over: Partial<TorrentStatus> = {}): TorrentStatus => ({
  id: 0, name: 't', hash: 'abc', status: 'completed', percent_done: 100,
  rate_download: 0, rate_upload: 0, total_size: 10, eta: null,
  download_dir: '/d', error: null, peers_connected: 0, seeds_connected: 0,
  leeches_connected: 0, seeds_total: null, leeches_total: null, added_date: 0,
  force_start: false, downlee: null, ...over,
});

const NONE = new Set<string>();

describe('downleeState', () => {
  it('reports nothing for a torrent never pulled', () => {
    const s = downleeState(torrent(), [], NONE);
    expect(s.status).toBeNull();
    expect(s.done).toBe(false);
    expect(s.running).toBe(false);
  });

  it('reads the status the server recorded, so it survives a reload', () => {
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'done', progress: 100 } });
    expect(downleeState(t, [], NONE).done).toBe(true);
  });

  it('lets the live downloads list override the server snapshot', () => {
    // The WebSocket knows the transfer finished before the next list refetch.
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'downloading', progress: 10 } });
    const live = [{ message_id: 'm', status: 'done', progress: 100 } as unknown as Download];
    const s = downleeState(t, live, NONE);
    expect(s.done).toBe(true);
    expect(s.progress).toBe(100);
  });

  it('treats a just-started transfer as running before the list reports it', () => {
    const s = downleeState(torrent(), [], new Set(['abc']));
    expect(s.running).toBe(true);
  });

  it('marks a failed or stopped transfer retryable', () => {
    for (const status of ['failed', 'stopped']) {
      const t = torrent({ downlee: { id: 1, message_id: 'm', status, progress: 40 } });
      expect(downleeState(t, [], NONE).retryable).toBe(true);
    }
  });
});

describe('isPendingPull - the "To be downloaded" filter', () => {
  const pending = (t: TorrentStatus, live: Download[] = [], started = NONE) =>
    isPendingPull(t, downleeState(t, live, started));

  it('includes a torrent finished on the VPS but never pulled', () => {
    expect(pending(torrent())).toBe(true);
  });

  it('excludes one still downloading on the VPS', () => {
    expect(pending(torrent({ percent_done: 40, status: 'downloading' }))).toBe(false);
  });

  it('excludes one already on the home server', () => {
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'done', progress: 100 } });
    expect(pending(t)).toBe(false);
  });

  it('excludes one being pulled right now', () => {
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'downloading', progress: 30 } });
    expect(pending(t)).toBe(false);
  });

  it('includes one whose pull failed - the file still is not here', () => {
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'failed', progress: 12 } });
    expect(pending(t)).toBe(true);
  });

  it('excludes one whose pull was only just accepted', () => {
    expect(pending(torrent(), [], new Set(['abc']))).toBe(false);
  });
});

describe('isAlreadyDownloaded - the "Already downloaded" filter', () => {
  const done = (t: TorrentStatus, live: Download[] = [], started = NONE) =>
    isAlreadyDownloaded(t, downleeState(t, live, started));

  it('includes a torrent finished on the VPS and pulled to DownLee', () => {
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'done', progress: 100 } });
    expect(done(t)).toBe(true);
  });

  it('excludes one never pulled', () => {
    expect(done(torrent())).toBe(false);
  });

  it('excludes one still being pulled', () => {
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'downloading', progress: 30 } });
    expect(done(t)).toBe(false);
  });

  it('excludes one whose pull failed', () => {
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'failed', progress: 12 } });
    expect(done(t)).toBe(false);
  });

  it('follows the live downloads list when the transfer just finished', () => {
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'downloading', progress: 90 } });
    const live = [{ message_id: 'm', status: 'done', progress: 100 } as unknown as Download];
    expect(done(t, live)).toBe(true);
  });

  it('is the exact complement of isPendingPull on a completed torrent', () => {
    // Every finished torrent is either still to pull or already here - unless a
    // pull is in flight, where both are false.
    const t = torrent({ downlee: { id: 1, message_id: 'm', status: 'done', progress: 100 } });
    expect(done(t)).toBe(true);
    expect(isPendingPull(t, downleeState(t, [], NONE))).toBe(false);
  });
});

import type { InfiniteData } from '@tanstack/react-query';
import type { Download, DownloadsResponse, QueueState, Stats } from '../types';

// Shared factories: a full record with every field present, overridable per
// test, so a test only spells out what it is about.

export const makeDownload = (over: Partial<Download> = {}): Download => ({
  id: 1,
  message_id: 'm1',
  file: 'clip.mkv',
  status: 'downloading',
  progress: 10,
  speed: 1_000,
  error: null,
  updated_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  downloaded_bytes: 10,
  total_bytes: 100,
  pending_time: null,
  downloaded_from: 'telegram',
  url: null,
  file_deleted: false,
  author: null,
  file_meta: null,
  thumb_count: 0,
  ...over,
});

export const makeQueueState = (over: Partial<QueueState> = {}): QueueState => ({
  limits: { global: 3, telegram: null, ytdlp: null, vps: null },
  max_limit: 10,
  active: { total: 0, telegram: 0, ytdlp: 0, vps: 0 },
  running: [],
  waiting: [],
  resumable: 0,
  ...over,
});

export const makeStats = (over: Partial<Stats> = {}): Stats => ({
  total_downloaded: 0,
  total_size: 0,
  pending_bytes: 0,
  total_speed: 0,
  downloaded_count: 0,
  total_count: 0,
  all_count: 0,
  active_count: 0,
  ...over,
});

/** The downloads list as the infinite query caches it: one page per call. */
export const makeDownloadPages = (...pages: Download[][]): InfiniteData<DownloadsResponse> => ({
  pages: pages.map((downloads, i) => ({ downloads, has_more: i < pages.length - 1, total: downloads.length })),
  pageParams: pages.map((_, i) => i * 30),
});

/** Resolves/rejects when the test says so - for asserting an optimistic
 *  update before the server has answered. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

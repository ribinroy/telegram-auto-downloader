import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import type { InfiniteData } from '@tanstack/react-query';
import * as socket from '../api/socket';
import { qk } from '../api/queryKeys';
import { renderHookWithClient } from '../test/queryWrapper';
import { makeDownload, makeDownloadPages, makeQueueState, makeStats } from '../test/fixtures';
import { useRealtime } from './useRealtime';
import type { DownloadsResponse, QueueState } from '../types';

vi.mock('../api/socket', () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn() }));

type Cache = InfiniteData<DownloadsResponse> | undefined;

const ALL = qk.downloads({});
const ON_DISK = qk.downloads({ filter: 'on_disk' });

const a = makeDownload({ id: 1, message_id: 'a', progress: 10 });
const b = makeDownload({ id: 2, message_id: 'b', status: 'done', progress: 100 });

/** Mount the hook with both lists, the queue and stats seeded; hand back the
 *  handlers the socket layer was given. */
function mount(cb: Parameters<typeof useRealtime>[0] = {}) {
  let handlers!: socket.SocketHandlers;
  vi.mocked(socket.connectSocket).mockImplementation(h => { handlers = h; return {} as ReturnType<typeof socket.connectSocket>; });
  const { client, unmount } = renderHookWithClient(() => useRealtime(cb));
  client.setQueryData(ALL, makeDownloadPages([a], [b]));
  client.setQueryData(ON_DISK, makeDownloadPages([b]));
  client.setQueryData(qk.queue(), makeQueueState({ running: [a] }));
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const rows = (key: readonly unknown[]) => client.getQueryData<Cache>(key)!.pages.flatMap(p => p.downloads);
  return { client, handlers, invalidate, rows, unmount };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('useRealtime', () => {
  it('connects once on mount and disconnects on unmount', () => {
    const { unmount } = mount();
    expect(socket.connectSocket).toHaveBeenCalledTimes(1);
    unmount();
    expect(socket.disconnectSocket).toHaveBeenCalledTimes(1);
  });

  it('progress patches the row in every list and the queue\'s running bar - no refetch', () => {
    const { handlers, invalidate, rows, client } = mount();
    act(() => handlers.onProgress({ message_id: 'a', progress: 55, downloaded_bytes: 55, total_bytes: 100, speed: 9, pending_time: 3 }));
    const row = rows(ALL).find(d => d.message_id === 'a')!;
    expect(row).toMatchObject({ progress: 55, downloaded_bytes: 55, speed: 9, pending_time: 3, file: 'clip.mkv' });
    expect(client.getQueryData<QueueState>(qk.queue())!.running[0]).toMatchObject({ progress: 55, speed: 9 });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a status change patches the row, zeroes its speed, refreshes the queue and reports the cached download', () => {
    const onStatusChange = vi.fn();
    const { handlers, invalidate, rows } = mount({ onStatusChange });
    act(() => handlers.onStatus({ message_id: 'a', status: 'failed', error: 'timeout' }));
    expect(rows(ALL).find(d => d.message_id === 'a')).toMatchObject({ status: 'failed', error: 'timeout', speed: 0 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.queue() });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['downloads'] });
    // The callback gets the row as it was cached before the patch
    expect(onStatusChange).toHaveBeenCalledWith({ message_id: 'a', status: 'failed', error: 'timeout' }, expect.objectContaining({ message_id: 'a', progress: 10 }));
  });

  it('a status change with no error clears a stale one', () => {
    const { handlers, rows, client } = mount();
    client.setQueryData(ALL, makeDownloadPages([{ ...a, error: 'old' }]));
    act(() => handlers.onStatus({ message_id: 'a', status: 'done' }));
    expect(rows(ALL)[0]).toMatchObject({ status: 'done', error: null });
  });

  it('a new download is prepended to the lists - except "On disk", where it is not yet', () => {
    const onNewDownload = vi.fn();
    const { handlers, rows, invalidate } = mount({ onNewDownload });
    const c = makeDownload({ id: 3, message_id: 'c' });
    act(() => handlers.onNew(c));
    expect(rows(ALL).map(d => d.message_id)).toEqual(['c', 'a', 'b']);
    expect(rows(ON_DISK).map(d => d.message_id)).toEqual(['b']);
    expect(onNewDownload).toHaveBeenCalledWith(c);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.queue() });
    // Delivered twice (a reconnect replays): still one row
    act(() => handlers.onNew(c));
    expect(rows(ALL).filter(d => d.message_id === 'c')).toHaveLength(1);
  });

  it('a delete removes the row from every list', () => {
    const { handlers, rows } = mount();
    act(() => handlers.onDeleted({ message_id: 'b' }));
    expect(rows(ALL).map(d => d.message_id)).toEqual(['a']);
    expect(rows(ON_DISK)).toEqual([]);
  });

  it('meta and file-count land on their row', () => {
    const { handlers, rows } = mount();
    const file_meta = { duration: 12, video: { codec: 'hevc', width: 1, height: 1 } };
    act(() => { handlers.onMeta({ message_id: 'b', file_meta }); handlers.onFileCount!({ message_id: 'a', file_count: 4 }); });
    expect(rows(ALL).find(d => d.message_id === 'b')!.file_meta).toEqual(file_meta);
    expect(rows(ALL).find(d => d.message_id === 'a')!.file_count).toBe(4);
  });

  it('stats replace the stats cache; queue:changed only refetches the queue', () => {
    const { handlers, invalidate, client } = mount();
    const stats = makeStats({ total_speed: 77 });
    act(() => { handlers.onStats(stats); handlers.onQueueChanged!(); });
    expect(client.getQueryData(qk.stats())).toEqual(stats);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.queue() });
  });

  it('a (re)connect resyncs everything once and reports the connection state', () => {
    const onConnectedChange = vi.fn();
    const { handlers, invalidate } = mount({ onConnectedChange });
    act(() => handlers.onConnect());
    expect(onConnectedChange).toHaveBeenCalledWith(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.stats() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.queue() });
    act(() => handlers.onDisconnect());
    expect(onConnectedChange).toHaveBeenLastCalledWith(false);
  });

  it('an event for a list that is not cached yet is a no-op, not a crash', () => {
    let handlers!: socket.SocketHandlers;
    vi.mocked(socket.connectSocket).mockImplementation(h => { handlers = h; return {} as ReturnType<typeof socket.connectSocket>; });
    const { client } = renderHookWithClient(() => useRealtime());
    act(() => handlers.onProgress({ message_id: 'a', progress: 1, downloaded_bytes: 1, total_bytes: 2, speed: 0, pending_time: null }));
    expect(client.getQueriesData({ queryKey: ['downloads'] })).toEqual([]);
    expect(client.getQueryData(qk.queue())).toBeUndefined();
  });
});

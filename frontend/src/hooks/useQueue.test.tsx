import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import * as api from '../api';
import { qk } from '../api/queryKeys';
import { renderHookWithClient } from '../test/queryWrapper';
import { makeDownload, makeQueueState, deferred } from '../test/fixtures';
import {
  useQueue, useQueuePlace, useSetQueueLimits, useReorderQueue, useStartQueuedNow,
  useStopAllDownloads, useResumeAllDownloads,
} from './useQueue';
import type { QueueState, StopAllResult } from '../types';

vi.mock('../api', () => ({
  fetchQueue: vi.fn(),
  setQueueLimits: vi.fn(),
  reorderQueue: vi.fn(),
  startQueuedNow: vi.fn(),
  stopAllDownloads: vi.fn(),
  resumeAllDownloads: vi.fn(),
}));

const running = makeDownload({ id: 1, message_id: 'r1', file: 'running.mkv' });
const w1 = makeDownload({ id: 2, message_id: 'w1', file: 'first.mkv', status: 'waiting' });
const w2 = makeDownload({ id: 3, message_id: 'w2', file: 'second.mkv', status: 'waiting' });
const state = (over: Partial<QueueState> = {}) => makeQueueState({
  active: { total: 1, telegram: 1, ytdlp: 0, vps: 0 }, running: [running], waiting: [w1, w2], ...over,
});

beforeEach(() => { vi.resetAllMocks(); });

describe('useQueue / useQueuePlace', () => {
  it('loads the queue and reports a waiting download\'s 1-based place', async () => {
    vi.mocked(api.fetchQueue).mockResolvedValue(state());
    const { result } = renderHookWithClient(() => ({ queue: useQueue(), w2: useQueuePlace('w2'), r1: useQueuePlace('r1'), none: useQueuePlace(null) }));
    await waitFor(() => expect(result.current.queue.data).toBeDefined());
    expect(result.current.w2).toBe(2);
    expect(result.current.r1).toBeNull();   // running, not waiting
    expect(result.current.none).toBeNull();
    expect(api.fetchQueue).toHaveBeenCalledTimes(1);
  });
});

describe('useSetQueueLimits', () => {
  it('applies the new limit optimistically, then takes the server\'s answer', async () => {
    const pending = deferred<QueueState>();
    vi.mocked(api.setQueueLimits).mockReturnValue(pending.promise);
    const { result, client } = renderHookWithClient(() => useSetQueueLimits());
    client.setQueryData(qk.queue(), state());

    act(() => { result.current.mutate({ global: 5 }); });
    await waitFor(() => expect(client.getQueryData<QueueState>(qk.queue())?.limits.global).toBe(5));
    expect(api.setQueueLimits).toHaveBeenCalledWith({ global: 5 });

    const fromServer = state({ limits: { global: 4, telegram: 1, ytdlp: null, vps: null } });
    pending.resolve(fromServer);
    await waitFor(() => expect(client.getQueryData(qk.queue())).toEqual(fromServer));
  });

  it('refetches the queue when the save fails, so the optimistic value does not stick', async () => {
    vi.mocked(api.setQueueLimits).mockRejectedValue(new Error('nope'));
    const { result, client } = renderHookWithClient(() => useSetQueueLimits());
    client.setQueryData(qk.queue(), state());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ global: 9 }); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.queue() });
  });
});

describe('useReorderQueue', () => {
  it('shows the dropped order at once: the top `running.length` run, the rest wait', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.reorderQueue>>>();
    vi.mocked(api.reorderQueue).mockReturnValue(pending.promise);
    const { result, client } = renderHookWithClient(() => useReorderQueue());
    client.setQueryData(qk.queue(), state());

    // w2 dragged above the running one: it takes the slot, r1 waits
    act(() => { result.current.mutate(['w2', 'r1', 'w1']); });
    await waitFor(() => {
      const q = client.getQueryData<QueueState>(qk.queue())!;
      expect(q.running.map(d => d.message_id)).toEqual(['w2']);
      expect(q.waiting.map(d => d.message_id)).toEqual(['r1', 'w1']);
    });
    expect(api.reorderQueue).toHaveBeenCalledWith(['w2', 'r1', 'w1']);

    const answer = { ...state(), requeued: 1, errors: [] };
    pending.resolve(answer);
    await waitFor(() => expect(client.getQueryData(qk.queue())).toEqual(answer));
  });

  it('ignores ids it does not know rather than inserting holes', async () => {
    vi.mocked(api.reorderQueue).mockReturnValue(deferred<Awaited<ReturnType<typeof api.reorderQueue>>>().promise);
    const { result, client } = renderHookWithClient(() => useReorderQueue());
    client.setQueryData(qk.queue(), state());
    act(() => { result.current.mutate(['ghost', 'w1', 'r1', 'w2']); });
    await waitFor(() => {
      const q = client.getQueryData<QueueState>(qk.queue())!;
      expect([...q.running, ...q.waiting].map(d => d.message_id)).toEqual(['w1', 'r1', 'w2']);
    });
  });

  it('refetches on a failed reorder', async () => {
    vi.mocked(api.reorderQueue).mockRejectedValue(new Error('down'));
    const { result, client } = renderHookWithClient(() => useReorderQueue());
    client.setQueryData(qk.queue(), state());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate(['w1', 'r1', 'w2']); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.queue() });
  });
});

describe('useStartQueuedNow', () => {
  it('stores the returned queue and refreshes the downloads list', async () => {
    const answer = state({ running: [running, w1], waiting: [w2] });
    vi.mocked(api.startQueuedNow).mockResolvedValue(answer);
    const { result, client } = renderHookWithClient(() => useStartQueuedNow());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate('w1'); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.startQueuedNow).toHaveBeenCalledWith('w1');
    expect(client.getQueryData(qk.queue())).toEqual(answer);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] });
  });
});

describe('bulk actions', () => {
  it('stop all: takes the queue from the answer and refetches downloads + stats', async () => {
    const answer: StopAllResult = { ...state({ running: [], waiting: [], resumable: 3 }), stopped: 3, errors: [] };
    vi.mocked(api.stopAllDownloads).mockResolvedValue(answer);
    const { result, client } = renderHookWithClient(() => useStopAllDownloads());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate(); });
    await waitFor(() => expect(result.current.data).toEqual(answer));
    expect(client.getQueryData(qk.queue())).toEqual(answer);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.stats() });
  });

  it('resume all: same, with the queued count from the server', async () => {
    const answer = { ...state({ resumable: 0 }), queued: 2 };
    vi.mocked(api.resumeAllDownloads).mockResolvedValue(answer);
    const { result, client } = renderHookWithClient(() => useResumeAllDownloads());
    act(() => { result.current.mutate(); });
    await waitFor(() => expect(result.current.data?.queued).toBe(2));
    expect(client.getQueryData(qk.queue())).toEqual(answer);
  });
});

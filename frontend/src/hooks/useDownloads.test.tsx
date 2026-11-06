import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import * as api from '../api';
import { qk } from '../api/queryKeys';
import { renderHookWithClient } from '../test/queryWrapper';
import { makeDownload, makeStats } from '../test/fixtures';
import {
  useDownloads, useStats, useAuthors, useTransferFiles, useSetTransferFilesStatus,
  useRetryDownload, useStopDownload, usePauseDownload, useResumeDownload, useDeleteDownload, useDownloadUrl,
} from './useDownloads';

vi.mock('../api', () => ({
  fetchDownloads: vi.fn(),
  fetchStats: vi.fn(),
  fetchAuthors: vi.fn(),
  fetchTransferFiles: vi.fn(),
  setTransferFilesStatus: vi.fn(),
  retryDownload: vi.fn(),
  stopDownload: vi.fn(),
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  deleteDownload: vi.fn(),
  downloadUrl: vi.fn(),
}));

beforeEach(() => { vi.resetAllMocks(); });

describe('useDownloads', () => {
  it('pages by offset: the next page starts after every download fetched so far', async () => {
    const a = makeDownload({ id: 1, message_id: 'a' });
    const b = makeDownload({ id: 2, message_id: 'b' });
    const c = makeDownload({ id: 3, message_id: 'c' });
    vi.mocked(api.fetchDownloads)
      .mockResolvedValueOnce({ downloads: [a, b], has_more: true, total: 3 })
      .mockResolvedValueOnce({ downloads: [c], has_more: false, total: 3 });

    const { result } = renderHookWithClient(() => useDownloads({ search: 'clip' } as Parameters<typeof useDownloads>[0]));
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(api.fetchDownloads).toHaveBeenCalledWith({ search: 'clip', offset: 0, limit: 30 });
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    // Offset is the count of rows already shown, not a page number - the
    // first page's length, however short it came back
    expect(api.fetchDownloads).toHaveBeenLastCalledWith({ search: 'clip', offset: 2, limit: 30 });
    expect(result.current.hasNextPage).toBe(false);
  });

  it('keys the query by its filters, so two filters are two lists', async () => {
    vi.mocked(api.fetchDownloads).mockResolvedValue({ downloads: [], has_more: false, total: 0 });
    const { result, client } = renderHookWithClient(() => useDownloads({ filter: 'active' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(qk.downloads({ filter: 'active' }))).toBeDefined();
    expect(client.getQueryData(qk.downloads({ filter: 'all' }))).toBeUndefined();
  });
});

describe('useStats / useAuthors', () => {
  it('land under their keys', async () => {
    vi.mocked(api.fetchStats).mockResolvedValue(makeStats({ total_speed: 42 }));
    vi.mocked(api.fetchAuthors).mockResolvedValue(['ann', 'bob']);
    const { result, client } = renderHookWithClient(() => ({ stats: useStats(), authors: useAuthors() }));
    await waitFor(() => expect(result.current.stats.data?.total_speed).toBe(42));
    await waitFor(() => expect(result.current.authors.data).toEqual(['ann', 'bob']));
    expect(client.getQueryData(qk.stats())).toEqual(makeStats({ total_speed: 42 }));
    expect(client.getQueryData(qk.authors())).toEqual(['ann', 'bob']);
  });
});

describe('useTransferFiles', () => {
  it('loads the files of a folder pull under its own key (outside the downloads tree)', async () => {
    const listing = { source: 'vps' as const, error: null, is_dir: true, files: [] };
    vi.mocked(api.fetchTransferFiles).mockResolvedValue(listing);
    const { result, client } = renderHookWithClient(() => useTransferFiles(7, false));
    await waitFor(() => expect(result.current.data).toEqual(listing));
    expect(api.fetchTransferFiles).toHaveBeenCalledWith(7);
    expect(client.getQueryData(qk.transferFiles(7))).toEqual(listing);
    expect(client.getQueriesData({ queryKey: ['downloads'] })).toHaveLength(0);
  });

  it('polls every 3s while the pull is live', async () => {
    vi.mocked(api.fetchTransferFiles).mockResolvedValue({ source: 'live', error: null, is_dir: true, files: [] });
    const { result } = renderHookWithClient(() => useTransferFiles(7, true));
    await waitFor(() => expect(result.current.data).toBeDefined());
    await waitFor(() => expect(vi.mocked(api.fetchTransferFiles).mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
  });
});

describe('useSetTransferFilesStatus', () => {
  it('refetches the file list after a decision - on failure too', async () => {
    vi.mocked(api.setTransferFilesStatus)
      .mockResolvedValueOnce({ file_status: { 'a.mkv': 'paused' }, status: 'downloading', restarted: null })
      .mockRejectedValueOnce(new Error('gone'));
    const { result, client } = renderHookWithClient(() => useSetTransferFilesStatus(7));
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    act(() => { result.current.mutate({ paths: ['a.mkv'], status: 'paused' }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.setTransferFilesStatus).toHaveBeenCalledWith(7, ['a.mkv'], 'paused');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.transferFiles(7) });

    invalidate.mockClear();
    act(() => { result.current.mutate({ paths: ['a.mkv'], status: null }); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.transferFiles(7) });
  });
});

describe('row actions', () => {
  const cases: [string, () => ReturnType<typeof useRetryDownload> | ReturnType<typeof useStopDownload> | ReturnType<typeof useDeleteDownload> | ReturnType<typeof useDownloadUrl>, keyof typeof api, unknown, unknown[]][] = [
    ['retry', useRetryDownload, 'retryDownload', 5, [5]],
    ['stop', useStopDownload, 'stopDownload', 'm1', ['m1']],
    ['pause', usePauseDownload, 'pauseDownload', 'm1', ['m1']],
    ['resume', useResumeDownload, 'resumeDownload', 'm1', ['m1']],
    ['delete', useDeleteDownload, 'deleteDownload', { messageId: 'm1', deleteFile: true }, ['m1', true]],
    ['url download', useDownloadUrl, 'downloadUrl', { url: 'https://x/y' }, [{ url: 'https://x/y' }]],
  ];

  it.each(cases)('%s calls its endpoint and refreshes the list + stats', async (_name, hook, fn, input, expected) => {
    vi.mocked(api[fn] as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const { result, client } = renderHookWithClient(hook as () => ReturnType<typeof useRetryDownload>);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { (result.current as { mutate: (v: unknown) => void }).mutate(input); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api[fn]).toHaveBeenCalledWith(...expected);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.stats() });
  });

  it('leaves the cache alone when the action fails', async () => {
    vi.mocked(api.stopDownload).mockRejectedValue(new Error('no'));
    const { result, client } = renderHookWithClient(() => useStopDownload());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate('m1'); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

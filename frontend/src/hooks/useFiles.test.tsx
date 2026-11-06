import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import * as files from '../api/files';
import { qk } from '../api/queryKeys';
import { renderHookWithClient } from '../test/queryWrapper';
import {
  useFileRoots, useFileList, useFileSearch, useDirSize, useFileText,
  useCreateFolder, useRenamePath, useDeletePaths, useTransferPaths, useUploadFiles,
  useFileTransfers, useCancelTransfer, useDismissTransfer, useAckTransfers, useTransferFiles, usePauseTransferFiles,
} from './useFiles';

vi.mock('../api/files', async (orig) => ({
  ...(await orig<typeof files>()),
  fetchFileRoots: vi.fn(), listFiles: vi.fn(), createFolder: vi.fn(), renamePath: vi.fn(), deletePaths: vi.fn(),
  transferPaths: vi.fn(), searchFiles: vi.fn(), dirSize: vi.fn(), readTextFile: vi.fn(), uploadFiles: vi.fn(),
  fetchTransfers: vi.fn(), fetchTransferFiles: vi.fn(), pauseTransferFiles: vi.fn(), cancelTransfer: vi.fn(),
  dismissTransfer: vi.fn(), ackTransfers: vi.fn(),
}));

beforeEach(() => { vi.resetAllMocks(); });

const listing = (path: string): files.FileListing =>
  ({ path, parent: '/', name: path.slice(1), entries: [], writable: true, usage: null, mount: '/', trash: null });

const job = (over: Partial<files.FileTransfer> = {}): files.FileTransfer => ({
  id: 'j1', move: false, paths: ['/a'], dest: '/b', status: 'running',
  total_bytes: 10, done_bytes: 1, total_files: 1, done_files: 0, items_total: 1, items_done: 0,
  current_item: null, current_file: null, current_file_size: 0, current_file_done: 0,
  speed: 0, eta: null, started_at: 0, finished_at: null, results: [], errors: [], error: null, acknowledged: false, ...over,
});

const fileListing = (id: string): files.TransferFileListing => ({
  id, status: 'running', files: [], truncated: false,
  counts: { pending: 0, copying: 0, paused: 0, done: 0, failed: 0, skipped: 0, cancelled: 0 },
});

describe('listings', () => {
  it('roots are keyed by the secured flag', async () => {
    vi.mocked(files.fetchFileRoots).mockResolvedValue({ roots: [], readonly: false, home: '/h', default: '/d' });
    const { result, client } = renderHookWithClient(() => useFileRoots(true));
    await waitFor(() => expect(result.current.data?.home).toBe('/h'));
    expect(files.fetchFileRoots).toHaveBeenCalledWith(true);
    expect(client.getQueryData(qk.fileRoots(true))).toBeDefined();
  });

  it('a folder listing keeps the previous folder on screen while the next loads', async () => {
    vi.mocked(files.listFiles).mockImplementation(async (path) => listing(path ?? '/'));
    const { result, rerender } = renderHookWithClient(({ path }: { path: string }) => useFileList(path, false), { initialProps: { path: '/one' } });
    await waitFor(() => expect(result.current.data?.path).toBe('/one'));
    expect(files.listFiles).toHaveBeenCalledWith('/one', false);

    rerender({ path: '/two' });
    // placeholderData: the old listing, flagged as such, instead of a blank
    expect(result.current.data?.path).toBe('/one');
    expect(result.current.isPlaceholderData).toBe(true);
    await waitFor(() => expect(result.current.data?.path).toBe('/two'));
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it('search waits for two characters and the enable flag', async () => {
    vi.mocked(files.searchFiles).mockResolvedValue({} as files.FileSearchResult);
    const short = renderHookWithClient(() => useFileSearch('/', 'a', false, true));
    const off = renderHookWithClient(() => useFileSearch('/', 'abc', false, false));
    await new Promise(r => setTimeout(r, 20));
    expect(files.searchFiles).not.toHaveBeenCalled();
    short.unmount(); off.unmount();
    const { result } = renderHookWithClient(() => useFileSearch('/', ' ab ', true, true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(files.searchFiles).toHaveBeenCalledWith('/', ' ab ', true);
  });

  it('size and text preview are off without a path', async () => {
    vi.mocked(files.dirSize).mockResolvedValue({ bytes: 5 } as unknown as files.DirSize);
    vi.mocked(files.readTextFile).mockResolvedValue({ text: 'hi' } as unknown as Awaited<ReturnType<typeof files.readTextFile>>);
    const off = renderHookWithClient(() => ({ s: useDirSize(null), t: useFileText(null) }));
    await new Promise(r => setTimeout(r, 20));
    expect(files.dirSize).not.toHaveBeenCalled();
    expect(files.readTextFile).not.toHaveBeenCalled();
    off.unmount();
    const { result } = renderHookWithClient(() => ({ s: useDirSize('/x'), t: useFileText('/x/a.txt') }));
    await waitFor(() => expect(result.current.s.isSuccess && result.current.t.isSuccess).toBe(true));
    expect(files.dirSize).toHaveBeenCalledWith('/x');
    expect(files.readTextFile).toHaveBeenCalledWith('/x/a.txt');
  });
});

describe('mutations drop the whole files tree', () => {
  it.each([
    ['mkdir', useCreateFolder, 'createFolder', { path: '/a', name: 'n' }, ['/a', 'n']],
    ['rename', useRenamePath, 'renamePath', { path: '/a/x', name: 'y' }, ['/a/x', 'y']],
    ['delete', useDeletePaths, 'deletePaths', { paths: ['/a/x'], permanent: true }, [['/a/x'], true]],
    ['transfer', useTransferPaths, 'transferPaths', { paths: ['/a/x'], dest: '/b', move: true }, [['/a/x'], '/b', true]],
  ] as const)('%s', async (_n, hook, fn, vars, expected) => {
    vi.mocked(files[fn] as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [], errors: [] });
    const { result, client } = renderHookWithClient(hook as () => ReturnType<typeof useCreateFolder>);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { (result.current as { mutate: (v: unknown) => void }).mutate(vars); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(files[fn]).toHaveBeenCalledWith(...expected);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['files'] });
  });

  it('upload too', async () => {
    vi.mocked(files.uploadFiles).mockResolvedValue({ results: [], errors: [], entries: [] });
    const f = new File(['x'], 'x.txt');
    const { result, client } = renderHookWithClient(() => useUploadFiles());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ dest: '/b', files: [f] }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(files.uploadFiles).toHaveBeenCalledWith('/b', [f]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['files'] });
  });

  it('but not when the call fails', async () => {
    vi.mocked(files.renamePath).mockRejectedValue(new Error('exists'));
    const { result, client } = renderHookWithClient(() => useRenamePath());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ path: '/a/x', name: 'y' }); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('copy/move jobs', () => {
  it('polls every second while a job is active, and stops once none is', async () => {
    vi.mocked(files.fetchTransfers).mockResolvedValue({ transfers: [job()] });
    const { result } = renderHookWithClient(() => useFileTransfers());
    await waitFor(() => expect(result.current.data?.transfers).toHaveLength(1));
    const fetcher = vi.mocked(files.fetchTransfers);
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });

    fetcher.mockResolvedValue({ transfers: [job({ status: 'done' })] });
    await waitFor(() => expect(result.current.data?.transfers[0].status).toBe('done'), { timeout: 3000 });
    const calls = fetcher.mock.calls.length;
    await new Promise(r => setTimeout(r, 1300));
    expect(fetcher.mock.calls.length).toBe(calls);
  });

  it('cancel / dismiss / ack refresh the job list', async () => {
    vi.mocked(files.cancelTransfer).mockResolvedValue({ job: job({ status: 'cancelled' }) });
    vi.mocked(files.dismissTransfer).mockResolvedValue(undefined);
    vi.mocked(files.ackTransfers).mockResolvedValue({ acknowledged: 2 });
    const { result, client } = renderHookWithClient(() => ({ c: useCancelTransfer(), d: useDismissTransfer(), a: useAckTransfers() }));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.c.mutate('j1'); result.current.d.mutate('j2'); result.current.a.mutate(['j1', 'j2']); });
    await waitFor(() => expect(result.current.c.isSuccess && result.current.d.isSuccess && result.current.a.isSuccess).toBe(true));
    // These hooks hand the fetcher straight to useMutation, so it also gets
    // TanStack's mutation context as a second argument
    expect(files.cancelTransfer).toHaveBeenCalledWith('j1', expect.anything());
    expect(files.dismissTransfer).toHaveBeenCalledWith('j2', expect.anything());
    expect(files.ackTransfers).toHaveBeenCalledWith(['j1', 'j2'], expect.anything());
    expect(invalidate.mock.calls.filter(([a]) => JSON.stringify(a) === JSON.stringify({ queryKey: qk.fileTransfers() }))).toHaveLength(3);
  });

  it('a job\'s file list is off without an id and never shows another job\'s files as a placeholder', async () => {
    vi.mocked(files.fetchTransferFiles).mockImplementation(async (id) => fileListing(id));
    const off = renderHookWithClient(() => useTransferFiles(null, false));
    await new Promise(r => setTimeout(r, 20));
    expect(files.fetchTransferFiles).not.toHaveBeenCalled();
    off.unmount();

    const { result, rerender } = renderHookWithClient(({ id }: { id: string }) => useTransferFiles(id, false), { initialProps: { id: 'j1' } });
    await waitFor(() => expect(result.current.data?.id).toBe('j1'));
    rerender({ id: 'j2' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.id).toBe('j2'));
  });

  it('pausing files writes the fresh listing straight into the cache and refreshes the job row', async () => {
    const answer = { ...fileListing('j1'), changed: 2 };
    vi.mocked(files.pauseTransferFiles).mockResolvedValue(answer);
    const { result, client } = renderHookWithClient(() => usePauseTransferFiles('j1'));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ paths: ['/a/1', '/a/2'], paused: true }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(files.pauseTransferFiles).toHaveBeenCalledWith('j1', ['/a/1', '/a/2'], true);
    expect(client.getQueryData(qk.fileTransferFiles('j1'))).toEqual(answer);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.fileTransfers(), exact: true });
    expect(files.fetchTransferFiles).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import * as api from '../api';
import { qk } from '../api/queryKeys';
import { renderHookWithClient } from '../test/queryWrapper';
import { deferred } from '../test/fixtures';
import {
  useTorrentConfig, useTorrentList, useTorrentDetails, useSetTorrentFilePriority, useRenameTorrent,
  useDownloadTorrentFiles, useSaveTorrentConfig, useDeleteTorrentConfig, useTestTorrentConnection,
  useSetTelegramDefault, useSetStopOnComplete, useSetTorrentHidden, useTorrentAction, useAddTorrent, useAddTorrentFile,
} from './useTorrents';

vi.mock('../api', () => ({
  fetchTorrentConfig: vi.fn(), fetchTorrentList: vi.fn(), fetchTorrentDetails: vi.fn(),
  setTorrentFilePriority: vi.fn(), renameTorrent: vi.fn(), downloadTorrentFiles: vi.fn(),
  saveTorrentConfig: vi.fn(), deleteTorrentConfig: vi.fn(), testTorrentConnection: vi.fn(),
  setTelegramDefault: vi.fn(), torrentAction: vi.fn(), addTorrent: vi.fn(), addTorrentFile: vi.fn(),
  setStopOnComplete: vi.fn(), setTorrentHidden: vi.fn(),
}));

beforeEach(() => { vi.resetAllMocks(); });

const file = (index: number, priority: api.TorrentFilePriority = 'normal'): api.TorrentFile =>
  ({ index, path: `f${index}.mkv`, size: 10, downloaded: 0, percent_done: 0, wanted: priority !== 'skip', priority } as api.TorrentFile);

const details = (over: Partial<api.TorrentDetails> = {}): api.TorrentDetails => ({
  torrent: { hash: 'h1', name: 't', percent_done: 50 } as api.TorrentStatus,
  files: [file(0), file(1), file(2)],
  info: {} as api.TorrentDetails['info'],
  ...over,
} as api.TorrentDetails);

describe('queries', () => {
  it('loads the config and a client\'s list under per-client keys', async () => {
    vi.mocked(api.fetchTorrentConfig).mockResolvedValue({ telegram_default: null } as api.TorrentConfig);
    vi.mocked(api.fetchTorrentList).mockResolvedValue({ configured: true, torrents: [] });
    const { result, client } = renderHookWithClient(() => ({ cfg: useTorrentConfig(), list: useTorrentList('qbittorrent') }));
    await waitFor(() => expect(result.current.cfg.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.list.data?.configured).toBe(true));
    expect(api.fetchTorrentList).toHaveBeenCalledWith('qbittorrent');
    expect(client.getQueryData(qk.torrentList('qbittorrent'))).toBeDefined();
    expect(client.getQueryData(qk.torrentList('transmission'))).toBeUndefined();
  });

  it('does not fetch a disabled list, nor details without a hash', async () => {
    renderHookWithClient(() => ({ list: useTorrentList('transmission', false), d: useTorrentDetails('transmission', null) }));
    await new Promise(r => setTimeout(r, 20));
    expect(api.fetchTorrentList).not.toHaveBeenCalled();
    expect(api.fetchTorrentDetails).not.toHaveBeenCalled();
  });

  it('loads details for a hash', async () => {
    vi.mocked(api.fetchTorrentDetails).mockResolvedValue(details());
    const { result } = renderHookWithClient(() => useTorrentDetails('transmission', 'h1'));
    await waitFor(() => expect(result.current.data?.files).toHaveLength(3));
    expect(api.fetchTorrentDetails).toHaveBeenCalledWith('transmission', 'h1');
  });
});

describe('useSetTorrentFilePriority', () => {
  const key = qk.torrentDetails('qbittorrent', 'h1');

  it('patches the open modal at once, then refetches so the client\'s view wins', async () => {
    const pending = deferred<void>();
    vi.mocked(api.setTorrentFilePriority).mockReturnValue(pending.promise);
    const { result, client } = renderHookWithClient(() => useSetTorrentFilePriority('qbittorrent', 'h1'));
    client.setQueryData(key, details());
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    act(() => { result.current.mutate({ indices: [0, 2], priority: 'skip' }); });
    await waitFor(() => {
      const d = client.getQueryData<api.TorrentDetails>(key)!;
      expect(d.files.map(f => f.priority)).toEqual(['skip', 'normal', 'skip']);
      expect(d.files.map(f => f.wanted)).toEqual([false, true, false]);
    });
    expect(api.setTorrentFilePriority).toHaveBeenCalledWith('qbittorrent', 'h1', [0, 2], 'skip');

    pending.resolve();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: key }));
  });

  it('rolls the files back when the client refuses', async () => {
    vi.mocked(api.setTorrentFilePriority).mockRejectedValue(new Error('no such level'));
    const { result, client } = renderHookWithClient(() => useSetTorrentFilePriority('qbittorrent', 'h1'));
    const before = details();
    client.setQueryData(key, before);
    act(() => { result.current.mutate({ indices: [1], priority: 'max' }); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(key)).toEqual(before);
  });
});

describe('per-torrent mutations', () => {
  it('a rename refreshes the modal and the list', async () => {
    vi.mocked(api.renameTorrent).mockResolvedValue(undefined);
    const { result, client } = renderHookWithClient(() => useRenameTorrent('transmission', 'h1'));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ name: 'new.mkv', path: 'old.mkv' }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.renameTorrent).toHaveBeenCalledWith('transmission', 'h1', 'new.mkv', 'old.mkv');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentDetails('transmission', 'h1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentList('transmission') });
  });

  it('pulling files refreshes both even when some fail', async () => {
    vi.mocked(api.downloadTorrentFiles).mockRejectedValue(new Error('offline'));
    const { result, client } = renderHookWithClient(() => useDownloadTorrentFiles('qbittorrent', 'h1'));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate([1, 2]); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.downloadTorrentFiles).toHaveBeenCalledWith('qbittorrent', 'h1', [1, 2]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentDetails('qbittorrent', 'h1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentList('qbittorrent') });
  });

  it('an action refreshes only that client\'s list', async () => {
    vi.mocked(api.torrentAction).mockResolvedValue({} as Awaited<ReturnType<typeof api.torrentAction>>);
    const { result, client } = renderHookWithClient(() => useTorrentAction());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ client: 'transmission', action: 'force-start', hashes: ['h1'] }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.torrentAction).toHaveBeenCalledWith('transmission', 'force-start', ['h1'], undefined);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.torrentList('transmission') });
  });

  it('adding a magnet or a .torrent file refreshes the target client\'s list', async () => {
    vi.mocked(api.addTorrent).mockResolvedValue({} as Awaited<ReturnType<typeof api.addTorrent>>);
    vi.mocked(api.addTorrentFile).mockResolvedValue({} as Awaited<ReturnType<typeof api.addTorrentFile>>);
    const magnet = renderHookWithClient(() => useAddTorrent());
    const inv1 = vi.spyOn(magnet.client, 'invalidateQueries');
    act(() => { magnet.result.current.mutate({ magnet: 'magnet:?xt=1', client: 'qbittorrent', downloadDir: '/dl' }); });
    await waitFor(() => expect(magnet.result.current.isSuccess).toBe(true));
    expect(api.addTorrent).toHaveBeenCalledWith('magnet:?xt=1', 'qbittorrent', '/dl');
    expect(inv1).toHaveBeenCalledWith({ queryKey: qk.torrentList('qbittorrent') });

    const f = new File(['x'], 'a.torrent');
    const upload = renderHookWithClient(() => useAddTorrentFile());
    const inv2 = vi.spyOn(upload.client, 'invalidateQueries');
    act(() => { upload.result.current.mutate({ file: f, client: 'transmission' }); });
    await waitFor(() => expect(upload.result.current.isSuccess).toBe(true));
    expect(api.addTorrentFile).toHaveBeenCalledWith(f, 'transmission', undefined);
    expect(inv2).toHaveBeenCalledWith({ queryKey: qk.torrentList('transmission') });
  });
});

describe('client config mutations', () => {
  it.each([
    ['save', useSaveTorrentConfig, 'saveTorrentConfig', { client: 'qbittorrent', config: { url: 'http://q' } }, ['qbittorrent', { url: 'http://q' }]],
    ['delete', useDeleteTorrentConfig, 'deleteTorrentConfig', 'transmission', ['transmission']],
    ['telegram default', useSetTelegramDefault, 'setTelegramDefault', null, [null]],
    ['stop on complete', useSetStopOnComplete, 'setStopOnComplete', { client: 'qbittorrent', enabled: false }, ['qbittorrent', false]],
    ['hidden', useSetTorrentHidden, 'setTorrentHidden', { client: 'transmission', hidden: true }, ['transmission', true]],
  ] as const)('%s refreshes the torrent tree and the Telegram settings (per-channel picker)', async (_n, hook, fn, vars, expected) => {
    vi.mocked(api[fn] as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const { result, client } = renderHookWithClient(hook as () => ReturnType<typeof useDeleteTorrentConfig>);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { (result.current as { mutate: (v: unknown) => void }).mutate(vars); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api[fn]).toHaveBeenCalledWith(...expected);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['torrent'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['telegram'] });
  });

  it('a connection test changes nothing in the cache', async () => {
    vi.mocked(api.testTorrentConnection).mockResolvedValue({ success: true } as Awaited<ReturnType<typeof api.testTorrentConnection>>);
    const { result, client } = renderHookWithClient(() => useTestTorrentConnection());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ client: 'qbittorrent', config: { url: 'http://q' } as Parameters<typeof api.testTorrentConnection>[1] }); });
    await waitFor(() => expect(result.current.data).toEqual({ success: true }));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

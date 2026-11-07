import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import * as api from '../api';
import { qk } from '../api/queryKeys';
import { renderHookWithClient } from '../test/queryWrapper';
import {
  useVpsConfig, useVpsFolders, useVpsFiles, useVpsUsage, useSaveVpsConfig, useTestVpsConnection, useDeleteVpsConfig,
  useAddVpsFolders, useDeleteVpsFolder, useUpdateVpsFolder, useDownloadVpsFile, useDeleteVpsRemote,
} from './useVps';

vi.mock('../api', () => ({
  fetchVpsConfig: vi.fn(), saveVpsConfig: vi.fn(), testVpsConnection: vi.fn(), deleteVpsConfig: vi.fn(),
  fetchVpsFolders: vi.fn(), addVpsFolders: vi.fn(), deleteVpsFolder: vi.fn(), updateVpsFolder: vi.fn(),
  fetchVpsFiles: vi.fn(), downloadVpsFile: vi.fn(), deleteVpsRemote: vi.fn(), fetchVpsUsage: vi.fn(),
}));

beforeEach(() => { vi.resetAllMocks(); });

const folder = (id: number, path: string): api.VpsWatchFolder =>
  ({ id, path, host: 'h', port: 22, username: 'u', auto_sync: false, folder: null, is_secured: false, created_at: null });
const config = { host: 'h', port: 22, username: 'u', remote_path: '/', password: 'p' };

describe('queries', () => {
  it('load the config, folders, files (by secured flag) and usage', async () => {
    vi.mocked(api.fetchVpsConfig).mockResolvedValue({ configured: true } as api.VpsConfig);
    vi.mocked(api.fetchVpsFolders).mockResolvedValue([folder(1, '/a')]);
    vi.mocked(api.fetchVpsFiles).mockResolvedValue([]);
    vi.mocked(api.fetchVpsUsage).mockResolvedValue({} as api.VpsUsage);
    const { result, client } = renderHookWithClient(() => ({
      cfg: useVpsConfig(), folders: useVpsFolders(), files: useVpsFiles(true), usage: useVpsUsage(),
    }));
    await waitFor(() => expect(result.current.cfg.data?.configured).toBe(true));
    await waitFor(() => expect(result.current.folders.data).toHaveLength(1));
    await waitFor(() => expect(result.current.files.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.usage.isSuccess).toBe(true));
    expect(api.fetchVpsFiles).toHaveBeenCalledWith(true);
    expect(api.fetchVpsUsage).toHaveBeenCalledWith();
    expect(client.getQueryData(qk.vpsFiles(true))).toEqual([]);
    expect(client.getQueryData(qk.vpsFiles(false))).toBeUndefined();
  });

  it('skip disabled fetches', async () => {
    renderHookWithClient(() => ({ files: useVpsFiles(false, false), usage: useVpsUsage(false) }));
    await new Promise(r => setTimeout(r, 20));
    expect(api.fetchVpsFiles).not.toHaveBeenCalled();
    expect(api.fetchVpsUsage).not.toHaveBeenCalled();
  });
});

describe('connection', () => {
  it('saving or deleting the connection refreshes the whole vps tree', async () => {
    vi.mocked(api.saveVpsConfig).mockResolvedValue({ status: 'ok' });
    vi.mocked(api.deleteVpsConfig).mockResolvedValue({ status: 'ok' });
    const save = renderHookWithClient(() => useSaveVpsConfig());
    const inv1 = vi.spyOn(save.client, 'invalidateQueries');
    act(() => { save.result.current.mutate(config); });
    await waitFor(() => expect(save.result.current.isSuccess).toBe(true));
    expect(api.saveVpsConfig).toHaveBeenCalledWith(config);
    expect(inv1).toHaveBeenCalledWith({ queryKey: ['vps'] });

    const del = renderHookWithClient(() => useDeleteVpsConfig());
    const inv2 = vi.spyOn(del.client, 'invalidateQueries');
    act(() => { del.result.current.mutate(); });
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));
    expect(inv2).toHaveBeenCalledWith({ queryKey: ['vps'] });
  });

  it('a test only reports, it refreshes nothing', async () => {
    vi.mocked(api.testVpsConnection).mockResolvedValue({ success: false, error: 'auth' });
    const { result, client } = renderHookWithClient(() => useTestVpsConnection());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate(config); });
    await waitFor(() => expect(result.current.data?.error).toBe('auth'));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('watched folders', () => {
  it('adding writes the returned list straight into the cache and refreshes the files', async () => {
    const folders = [folder(1, '/a'), folder(2, '/b')];
    vi.mocked(api.addVpsFolders).mockResolvedValue(folders);
    const { result, client } = renderHookWithClient(() => useAddVpsFolders());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate(['/b']); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(qk.vpsFolders())).toEqual(folders);
    expect(api.fetchVpsFolders).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vps', 'files'] });
  });

  it('updating does the same', async () => {
    const folders = [folder(1, '/a')];
    vi.mocked(api.updateVpsFolder).mockResolvedValue(folders);
    const { result, client } = renderHookWithClient(() => useUpdateVpsFolder());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ id: 1, data: { auto_sync: true } }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.updateVpsFolder).toHaveBeenCalledWith(1, { auto_sync: true });
    expect(client.getQueryData(qk.vpsFolders())).toEqual(folders);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vps', 'files'] });
  });

  it('removing one also refreshes the downloads list - a secured folder hid rows there', async () => {
    vi.mocked(api.deleteVpsFolder).mockResolvedValue([]);
    const { result, client } = renderHookWithClient(() => useDeleteVpsFolder());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ id: 1, confirmUnhide: true }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.deleteVpsFolder).toHaveBeenCalledWith(1, true);
    expect(client.getQueryData(qk.vpsFolders())).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vps', 'files'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] });
  });
});

describe('files', () => {
  it('a pull returns the new record and leaves the cache to the socket', async () => {
    vi.mocked(api.downloadVpsFile).mockResolvedValue({ id: 9, message_id: 'm9' });
    const { result, client } = renderHookWithClient(() => useDownloadVpsFile());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate({ path: '/a/x.mkv', size: 5, client: 'qbittorrent' }); });
    await waitFor(() => expect(result.current.data?.id).toBe(9));
    expect(api.downloadVpsFile).toHaveBeenCalledWith('/a/x.mkv', 5, 'qbittorrent');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a remote delete refreshes the listings', async () => {
    vi.mocked(api.deleteVpsRemote).mockResolvedValue({ status: 'ok' });
    const { result, client } = renderHookWithClient(() => useDeleteVpsRemote());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate('/a/x.mkv'); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vps', 'files'] });
  });
});

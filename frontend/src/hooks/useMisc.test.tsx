import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import * as api from '../api';
import * as subtitles from '../api/subtitles';
import * as speed from '../api/internetSpeed';
import * as vr from '../api/vr';
import * as mediaInfo from '../api/mediaInfo';
import { qk } from '../api/queryKeys';
import { renderHookWithClient } from '../test/queryWrapper';
import { deferred } from '../test/fixtures';
import {
  useLogin, useUpdatePassword, useCheckUrl, useAnalytics, useSubtitleTracks,
  useInternetSpeed, useStartInternetSpeed, useCancelInternetSpeed, useSpeedResults, useRecordBrowserResult, useDeleteSpeedResult,
  useVrSettings, useRegenerateVrKey, useDisableVrKey, useSetVrIncludeSecured, useDownloadProjection, useSaveDownloadProjection,
  useMediaInfo,
} from './useMisc';

vi.mock('../api', () => ({ login: vi.fn(), updatePassword: vi.fn(), checkUrl: vi.fn(), fetchAnalytics: vi.fn() }));
vi.mock('../api/subtitles', async (orig) => ({
  ...(await orig<typeof subtitles>()),
  listSubtitleTracks: vi.fn(),
}));
vi.mock('../api/mediaInfo', () => ({ fetchMediaInfo: vi.fn() }));
vi.mock('../api/internetSpeed', async (orig) => ({
  ...(await orig<typeof speed>()),
  fetchInternetSpeed: vi.fn(), startInternetSpeed: vi.fn(), cancelInternetSpeed: vi.fn(),
  fetchSpeedResults: vi.fn(), recordBrowserResult: vi.fn(), deleteSpeedResult: vi.fn(),
}));
vi.mock('../api/vr', () => ({
  fetchVrSettings: vi.fn(), regenerateVrKey: vi.fn(), disableVrKey: vi.fn(), setVrIncludeSecured: vi.fn(),
  fetchDownloadProjection: vi.fn(), saveDownloadProjection: vi.fn(),
}));

beforeEach(() => { vi.resetAllMocks(); });

const status = (phase: speed.InternetPhase): speed.InternetStatus =>
  ({ phase, live_mbps: 0, progress: 0, result: null, error: null, meta: null });

const vrSettings = (over: Partial<vr.VrFeedSettings> = {}): vr.VrFeedSettings =>
  ({ enabled: true, key: 'k', include_secured: false, created_at: null, urls: { heresphere: 'h', deovr: 'd' }, ...over });

describe('auth and URL check', () => {
  it('login / password / check-url are plain calls', async () => {
    vi.mocked(api.login).mockResolvedValue({ token: 't' } as api.LoginResponse);
    vi.mocked(api.updatePassword).mockResolvedValue(undefined);
    vi.mocked(api.checkUrl).mockResolvedValue({ supported: true });
    const { result } = renderHookWithClient(() => ({ login: useLogin(), pw: useUpdatePassword(), url: useCheckUrl() }));
    act(() => {
      result.current.login.mutate({ username: 'a', password: 'b' });
      result.current.pw.mutate({ currentPassword: 'b', newPassword: 'c' });
      result.current.url.mutate('https://x');
    });
    await waitFor(() => expect(result.current.login.data?.token).toBe('t'));
    await waitFor(() => expect(result.current.pw.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.url.data?.supported).toBe(true));
    expect(api.login).toHaveBeenCalledWith('a', 'b');
    expect(api.updatePassword).toHaveBeenCalledWith('b', 'c');
    expect(api.checkUrl).toHaveBeenCalledWith('https://x');
  });
});

describe('useAnalytics', () => {
  it('keys by every parameter', async () => {
    vi.mocked(api.fetchAnalytics).mockResolvedValue({ period_days: 7 } as Awaited<ReturnType<typeof api.fetchAnalytics>>);
    const { result, client } = renderHookWithClient(() => useAnalytics(7, 'hour', true));
    await waitFor(() => expect(result.current.data?.period_days).toBe(7));
    expect(api.fetchAnalytics).toHaveBeenCalledWith(7, 'hour', true);
    expect(client.getQueryData(qk.analytics(7, 'hour', true))).toBeDefined();
  });
});

describe('useSubtitleTracks', () => {
  it('is off with no source, and keys a download apart from a path', async () => {
    vi.mocked(subtitles.listSubtitleTracks).mockResolvedValue([]);
    const off = renderHookWithClient(() => useSubtitleTracks(null));
    await new Promise(r => setTimeout(r, 20));
    expect(subtitles.listSubtitleTracks).not.toHaveBeenCalled();
    off.unmount();

    const { result, client } = renderHookWithClient(() => useSubtitleTracks({ downloadId: 3 }));
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(subtitles.listSubtitleTracks).toHaveBeenCalledWith({ downloadId: 3 });
    expect(client.getQueryData(qk.subtitles('d:3'))).toEqual([]);
  });
});

describe('useMediaInfo', () => {
  it('waits for a source (the panel being opened), and keys a download apart from a path', async () => {
    const info = { file: { name: 'a' } } as unknown as Awaited<ReturnType<typeof mediaInfo.fetchMediaInfo>>;
    vi.mocked(mediaInfo.fetchMediaInfo).mockResolvedValue(info);
    const off = renderHookWithClient(() => useMediaInfo(null));
    await new Promise(r => setTimeout(r, 20));
    expect(mediaInfo.fetchMediaInfo).not.toHaveBeenCalled();
    off.unmount();

    const { result, client } = renderHookWithClient(() => useMediaInfo({ path: '/a.mkv' }));
    await waitFor(() => expect(result.current.data).toBe(info));
    expect(mediaInfo.fetchMediaInfo).toHaveBeenCalledWith({ path: '/a.mkv' });
    expect(client.getQueryData(qk.mediaInfo('p:/a.mkv'))).toBe(info);
  });
});

describe('internet speed test', () => {
  it('polls while a run is on, and refreshes the results table once it finishes', async () => {
    const { client } = renderHookWithClient(() => null);
    // The last poll saw it running; the next sees it done
    client.setQueryData(qk.internetSpeed(), status('download'));
    vi.mocked(speed.fetchInternetSpeed).mockResolvedValue(status('done'));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHookWithClient(() => useInternetSpeed(true), { client });
    await waitFor(() => expect(result.current.data?.phase).toBe('done'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['speedtest', 'results'] });
  });

  it('does not refresh the results when nothing finished', async () => {
    vi.mocked(speed.fetchInternetSpeed).mockResolvedValue(status('idle'));
    const { result, client } = renderHookWithClient(() => useInternetSpeed(true));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await waitFor(() => expect(result.current.data?.phase).toBe('idle'));
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['speedtest', 'results'] });
  });

  it('keeps polling at 500ms while running', async () => {
    vi.mocked(speed.fetchInternetSpeed).mockResolvedValue(status('upload'));
    const { result } = renderHookWithClient(() => useInternetSpeed(true));
    await waitFor(() => expect(result.current.data?.phase).toBe('upload'));
    await waitFor(() => expect(vi.mocked(speed.fetchInternetSpeed).mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
  });

  it('is not fetched while disabled', async () => {
    renderHookWithClient(() => useInternetSpeed(false));
    await new Promise(r => setTimeout(r, 20));
    expect(speed.fetchInternetSpeed).not.toHaveBeenCalled();
  });

  it('start and cancel both refetch the status, success or not', async () => {
    vi.mocked(speed.startInternetSpeed).mockRejectedValue(new Error('busy'));
    vi.mocked(speed.cancelInternetSpeed).mockResolvedValue({ cancelled: true });
    const { result, client } = renderHookWithClient(() => ({ start: useStartInternetSpeed(), cancel: useCancelInternetSpeed() }));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.start.mutate(); });
    await waitFor(() => expect(result.current.start.isError).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.internetSpeed() });
    invalidate.mockClear();
    act(() => { result.current.cancel.mutate(); });
    await waitFor(() => expect(result.current.cancel.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.internetSpeed() });
  });
});

describe('speed results', () => {
  it('asks for one kind, or all, with the limit in the key', async () => {
    vi.mocked(speed.fetchSpeedResults).mockResolvedValue([]);
    const all = renderHookWithClient(() => useSpeedResults('all'));
    await waitFor(() => expect(all.result.current.data).toEqual([]));
    expect(speed.fetchSpeedResults).toHaveBeenCalledWith(undefined, 20);
    expect(all.client.getQueryData(qk.speedResults('all:20'))).toEqual([]);

    const one = renderHookWithClient(() => useSpeedResults('browser', true, 5));
    await waitFor(() => expect(one.result.current.data).toEqual([]));
    expect(speed.fetchSpeedResults).toHaveBeenLastCalledWith('browser', 5);
  });

  it('recording and deleting a row refresh every results list', async () => {
    vi.mocked(speed.recordBrowserResult).mockResolvedValue({} as speed.SpeedTestRow);
    vi.mocked(speed.deleteSpeedResult).mockResolvedValue({ deleted: true });
    const { result, client } = renderHookWithClient(() => ({ rec: useRecordBrowserResult(), del: useDeleteSpeedResult() }));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const input = { ping: { min: 1, avg: 1, max: 1, jitter: 0 }, download_mbps: 1, upload_mbps: 1, download_bytes: 1, upload_bytes: 1 };
    act(() => { result.current.rec.mutate(input); });
    await waitFor(() => expect(result.current.rec.isSuccess).toBe(true));
    // The fetcher is the mutationFn itself, so it also gets the mutation context
    expect(speed.recordBrowserResult).toHaveBeenCalledWith(input, expect.anything());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['speedtest', 'results'] });
    invalidate.mockClear();
    act(() => { result.current.del.mutate(4); });
    await waitFor(() => expect(result.current.del.isSuccess).toBe(true));
    expect(speed.deleteSpeedResult).toHaveBeenCalledWith(4, expect.anything());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['speedtest', 'results'] });
  });
});

describe('VR feed settings', () => {
  it('loads, and each key action writes the answer into the cache without a refetch', async () => {
    vi.mocked(vr.fetchVrSettings).mockResolvedValue(vrSettings({ enabled: false, urls: null }));
    vi.mocked(vr.regenerateVrKey).mockResolvedValue(vrSettings({ key: 'new' }));
    vi.mocked(vr.setVrIncludeSecured).mockResolvedValue(vrSettings({ key: 'new', include_secured: true }));
    vi.mocked(vr.disableVrKey).mockResolvedValue(vrSettings({ enabled: false, key: null, urls: null }));
    const { result, client } = renderHookWithClient(() => ({
      s: useVrSettings(), regen: useRegenerateVrKey(), secured: useSetVrIncludeSecured(), disable: useDisableVrKey(),
    }));
    await waitFor(() => expect(result.current.s.data?.enabled).toBe(false));

    act(() => { result.current.regen.mutate(true); });
    await waitFor(() => expect(result.current.s.data?.key).toBe('new'));
    expect(vr.regenerateVrKey).toHaveBeenCalledWith(true);

    act(() => { result.current.secured.mutate(true); });
    await waitFor(() => expect(result.current.s.data?.include_secured).toBe(true));
    expect(vr.setVrIncludeSecured).toHaveBeenCalledWith(true);

    act(() => { result.current.disable.mutate(); });
    await waitFor(() => expect(result.current.s.data?.enabled).toBe(false));
    expect(client.getQueryData(qk.vrSettings())).toEqual(vrSettings({ enabled: false, key: null, urls: null }));
    expect(vr.fetchVrSettings).toHaveBeenCalledTimes(1);
  });
});

describe('download projection', () => {
  it('is off for an explorer path (no download id)', async () => {
    const { result } = renderHookWithClient(() => useDownloadProjection(null));
    await new Promise(r => setTimeout(r, 20));
    expect(vr.fetchDownloadProjection).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('loads a download\'s pick', async () => {
    vi.mocked(vr.fetchDownloadProjection).mockResolvedValue({ projection: null, detected: '180-sbs', lens: null });
    const { result } = renderHookWithClient(() => useDownloadProjection(5));
    await waitFor(() => expect(result.current.data?.detected).toBe('180-sbs'));
    expect(vr.fetchDownloadProjection).toHaveBeenCalledWith(5);
  });

  it('saving flips the cached pick at once, then refetches', async () => {
    const pending = deferred<{ projection: '360-mono' }>();
    vi.mocked(vr.saveDownloadProjection).mockReturnValue(pending.promise);
    const { result, client } = renderHookWithClient(() => useSaveDownloadProjection(5));
    client.setQueryData(qk.downloadProjection(5), { projection: null, detected: '180-sbs', lens: null });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate('360-mono'); });
    await waitFor(() => expect(client.getQueryData<vr.DownloadProjection>(qk.downloadProjection(5))?.projection).toBe('360-mono'));
    expect(vr.saveDownloadProjection).toHaveBeenCalledWith(5, '360-mono');
    pending.resolve({ projection: '360-mono' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.downloadProjection(5) }));
  });

  it('with no download id the save touches no cache', async () => {
    vi.mocked(vr.saveDownloadProjection).mockRejectedValue(new Error('no id'));
    const { result, client } = renderHookWithClient(() => useSaveDownloadProjection(null));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate('flat'); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

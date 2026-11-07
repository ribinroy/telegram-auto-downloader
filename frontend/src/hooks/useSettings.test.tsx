import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import * as api from '../api';
import { qk } from '../api/queryKeys';
import { renderHookWithClient } from '../test/queryWrapper';
import {
  useMappings, useCreateMapping, useUpdateMapping, useDeleteMapping,
  useCookies, useSaveCookies, useYtdlpVersion, useUpgradeYtdlp, useSyncThumbnails, useCheckFiles,
  useUsers, useSyncUsers, useUpdateUserRole, useBotQueries, useSaveBotQuery, useDeleteBotQuery, useTestBotQuery,
  useRenameRules, useCreateRenameRule, useUpdateRenameRule, useDeleteRenameRule, useReorderRenameRules,
  useRenamePreview, useApplyRenameRules, useJobSchedules, useSaveJobSchedule,
} from './useSettings';

vi.mock('../api', () => ({
  fetchMappings: vi.fn(), createMapping: vi.fn(), updateMapping: vi.fn(), deleteMapping: vi.fn(),
  fetchCookies: vi.fn(), saveCookies: vi.fn(),
  getYtdlpVersion: vi.fn(), upgradeYtdlp: vi.fn(), syncThumbnails: vi.fn(), checkFiles: vi.fn(),
  fetchJobSchedules: vi.fn(), saveJobSchedule: vi.fn(),
  fetchUsers: vi.fn(), syncUsers: vi.fn(), updateUserRole: vi.fn(),
  fetchBotQueries: vi.fn(), saveBotQuery: vi.fn(), deleteBotQuery: vi.fn(), testBotQuery: vi.fn(),
  fetchRenameRules: vi.fn(), createRenameRule: vi.fn(), updateRenameRule: vi.fn(), deleteRenameRule: vi.fn(),
  reorderRenameRules: vi.fn(), testRenameRules: vi.fn(), applyRenameRules: vi.fn(),
}));

beforeEach(() => { vi.resetAllMocks(); });

const mapping = { id: 1, downloaded_from: 'youtube.com', is_secured: false, folder: '/v', quality: null, created_at: null, updated_at: null };
const rule = { name: 'dots', pattern: '\\.', replacement: ' ', enabled: true, source: null, stop_on_match: false };

/** Run a mutation and return the invalidateQueries spy for what it refreshed. */
async function runMutation<V>(hook: () => { mutate: (v: V) => void; isSuccess: boolean; isError: boolean }, vars: V) {
  const { result, client } = renderHookWithClient(hook);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  act(() => { result.current.mutate(vars); });
  await waitFor(() => expect(result.current.isSuccess || result.current.isError).toBe(true));
  return { invalidate, result, client };
}

describe('source mappings', () => {
  it('loads the list', async () => {
    vi.mocked(api.fetchMappings).mockResolvedValue([mapping]);
    const { result } = renderHookWithClient(() => useMappings());
    await waitFor(() => expect(result.current.data).toEqual([mapping]));
  });

  it('create / update / delete each refresh the mappings list', async () => {
    vi.mocked(api.createMapping).mockResolvedValue(mapping);
    vi.mocked(api.updateMapping).mockResolvedValue(mapping);
    vi.mocked(api.deleteMapping).mockResolvedValue(undefined);

    const c = await runMutation(useCreateMapping, { downloaded_from: 'youtube.com' } as Parameters<typeof api.createMapping>[0]);
    expect(api.createMapping).toHaveBeenCalledWith({ downloaded_from: 'youtube.com' });
    expect(c.invalidate).toHaveBeenCalledWith({ queryKey: qk.mappings() });

    const u = await runMutation(useUpdateMapping, { id: 1, data: { folder: '/x' } });
    expect(api.updateMapping).toHaveBeenCalledWith(1, { folder: '/x' });
    expect(u.invalidate).toHaveBeenCalledWith({ queryKey: qk.mappings() });

    const d = await runMutation(useDeleteMapping, 1);
    expect(api.deleteMapping).toHaveBeenCalledWith(1);
    expect(d.invalidate).toHaveBeenCalledWith({ queryKey: qk.mappings() });
  });
});

describe('cookies and yt-dlp', () => {
  it('does not fetch cookies or the version while disabled', async () => {
    renderHookWithClient(() => ({ c: useCookies(false), v: useYtdlpVersion(false) }));
    await new Promise(r => setTimeout(r, 20));
    expect(api.fetchCookies).not.toHaveBeenCalled();
    expect(api.getYtdlpVersion).not.toHaveBeenCalled();
  });

  it('fetches both when enabled', async () => {
    vi.mocked(api.fetchCookies).mockResolvedValue('# Netscape');
    vi.mocked(api.getYtdlpVersion).mockResolvedValue({ version: '2026.01.01' });
    const { result } = renderHookWithClient(() => ({ c: useCookies(), v: useYtdlpVersion() }));
    await waitFor(() => expect(result.current.c.data).toBe('# Netscape'));
    await waitFor(() => expect(result.current.v.data?.version).toBe('2026.01.01'));
  });

  it('saving cookies refreshes them; upgrading refreshes the version', async () => {
    vi.mocked(api.saveCookies).mockResolvedValue({ status: 'ok' });
    vi.mocked(api.upgradeYtdlp).mockResolvedValue({ upgraded: true });
    const s = await runMutation(useSaveCookies, 'cookie-text');
    expect(api.saveCookies).toHaveBeenCalledWith('cookie-text');
    expect(s.invalidate).toHaveBeenCalledWith({ queryKey: qk.cookies() });
    const u = await runMutation(useUpgradeYtdlp, undefined);
    expect(u.invalidate).toHaveBeenCalledWith({ queryKey: qk.ytdlpVersion() });
  });

  it('a thumbnail sync touches no cache', async () => {
    vi.mocked(api.syncThumbnails).mockResolvedValue({} as Awaited<ReturnType<typeof api.syncThumbnails>>);
    const { invalidate } = await runMutation(useSyncThumbnails, undefined);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('check-files refreshes every downloads list and the job line, even when it fails', async () => {
    vi.mocked(api.checkFiles).mockRejectedValue(new Error('boom'));
    const { invalidate, result } = await runMutation(useCheckFiles, undefined);
    expect(result.current.isError).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.jobSchedules() });
  });
});

describe('users and bot queries', () => {
  it('unwrap their envelopes', async () => {
    const user = { id: 1, username: 'admin' } as api.AppUser;
    const query = { id: 1, key: 'df', command: 'df -h' } as api.BotQuery;
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [user] });
    vi.mocked(api.fetchBotQueries).mockResolvedValue({ queries: [query] });
    const { result } = renderHookWithClient(() => ({ u: useUsers(), q: useBotQueries() }));
    await waitFor(() => expect(result.current.u.data).toEqual([user]));
    await waitFor(() => expect(result.current.q.data).toEqual([query]));
  });

  it('user mutations refresh the users list', async () => {
    vi.mocked(api.syncUsers).mockResolvedValue({ synced: 1 });
    vi.mocked(api.updateUserRole).mockResolvedValue({});
    const s = await runMutation(useSyncUsers, undefined);
    expect(s.invalidate).toHaveBeenCalledWith({ queryKey: qk.users() });
    const r = await runMutation(useUpdateUserRole, { userId: 2, role: 'admin' as const });
    expect(api.updateUserRole).toHaveBeenCalledWith(2, 'admin');
    expect(r.invalidate).toHaveBeenCalledWith({ queryKey: qk.users() });
  });

  it('bot query save/delete refresh the list; a test run refreshes nothing', async () => {
    vi.mocked(api.saveBotQuery).mockResolvedValue({ queries: [] });
    vi.mocked(api.deleteBotQuery).mockResolvedValue({ queries: [] });
    vi.mocked(api.testBotQuery).mockResolvedValue({ output: 'ok' });
    const s = await runMutation(useSaveBotQuery, { key: 'k', command: 'c', originalKey: 'old' });
    expect(api.saveBotQuery).toHaveBeenCalledWith('k', 'c', 'old');
    expect(s.invalidate).toHaveBeenCalledWith({ queryKey: qk.botQueries() });
    const d = await runMutation(useDeleteBotQuery, 'k');
    expect(d.invalidate).toHaveBeenCalledWith({ queryKey: qk.botQueries() });
    const t = await runMutation(useTestBotQuery, 'uptime');
    expect(api.testBotQuery).toHaveBeenCalledWith('uptime');
    expect(t.invalidate).not.toHaveBeenCalled();
  });
});

describe('rename rules', () => {
  it('loads rules and the saved-chain preview', async () => {
    vi.mocked(api.fetchRenameRules).mockResolvedValue({ rules: [{ ...rule, id: 1, position: 0 }] });
    vi.mocked(api.testRenameRules).mockResolvedValue({ rows: [] } as unknown as Awaited<ReturnType<typeof api.testRenameRules>>);
    const { result } = renderHookWithClient(() => ({ rules: useRenameRules(), preview: useRenamePreview() }));
    await waitFor(() => expect(result.current.rules.data?.rules).toHaveLength(1));
    await waitFor(() => expect(result.current.preview.isSuccess).toBe(true));
    expect(api.testRenameRules).toHaveBeenCalledWith();
  });

  it('every rule edit refreshes the rules and the preview', async () => {
    const answer = { rules: [] };
    vi.mocked(api.createRenameRule).mockResolvedValue(answer);
    vi.mocked(api.updateRenameRule).mockResolvedValue(answer);
    vi.mocked(api.deleteRenameRule).mockResolvedValue(answer);
    vi.mocked(api.reorderRenameRules).mockResolvedValue(answer);

    for (const [hook, vars] of [
      [useCreateRenameRule, rule],
      [useUpdateRenameRule, { id: 1, rule }],
      [useDeleteRenameRule, 1],
      [useReorderRenameRules, [2, 1]],
    ] as const) {
      const { invalidate } = await runMutation(hook as () => ReturnType<typeof useDeleteRenameRule>, vars as never);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.renameRules() });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rename-preview'] });
    }
    expect(api.updateRenameRule).toHaveBeenCalledWith(1, rule);
    expect(api.reorderRenameRules).toHaveBeenCalledWith([2, 1]);
  });

  it('applying for real refreshes the downloads list; a dry run does not', async () => {
    vi.mocked(api.applyRenameRules).mockResolvedValue({} as api.RenameApplyResult);
    const dry = await runMutation(useApplyRenameRules, true);
    expect(api.applyRenameRules).toHaveBeenCalledWith(true);
    expect(dry.invalidate).not.toHaveBeenCalled();
    const real = await runMutation(useApplyRenameRules, false);
    expect(real.invalidate).toHaveBeenCalledWith({ queryKey: ['downloads'] });
    expect(real.invalidate).toHaveBeenCalledWith({ queryKey: ['rename-preview'] });
  });
});

describe('job schedules', () => {
  const schedules = { jobs: [{ id: 'check_files', label: 'Check files' }], schedules: {}, tz: 'Europe/Berlin', server_time: 'x' };

  it('loads, and is not fetched while disabled', async () => {
    vi.mocked(api.fetchJobSchedules).mockResolvedValue(schedules);
    const off = renderHookWithClient(() => useJobSchedules(false));
    await new Promise(r => setTimeout(r, 20));
    expect(api.fetchJobSchedules).not.toHaveBeenCalled();
    off.unmount();
    const { result } = renderHookWithClient(() => useJobSchedules());
    await waitFor(() => expect(result.current.data).toEqual(schedules));
  });

  it('a save refreshes the schedules', async () => {
    vi.mocked(api.saveJobSchedule).mockResolvedValue({} as Awaited<ReturnType<typeof api.saveJobSchedule>>);
    const { invalidate } = await runMutation(useSaveJobSchedule, { jobId: 'check_files', update: { time: '04:30' } });
    expect(api.saveJobSchedule).toHaveBeenCalledWith('check_files', { time: '04:30' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.jobSchedules() });
  });
});

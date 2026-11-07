import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import * as api from '../api';
import { renderHookWithClient } from '../test/queryWrapper';
import {
  useTelegramStatus, useTelegramApiConfig, useTelegramDialogs, useSaveTelegramApiConfig, useSendTelegramCode,
  useVerifyTelegramCode, useVerifyTelegramPassword, useTelegramBotLogin, useTelegramLogout,
  useAddTelegramChannel, useRemoveTelegramChannel, useSetChannelTorrentClient,
} from './useTelegram';

vi.mock('../api', () => ({
  fetchTelegramStatus: vi.fn(), fetchTelegramApiConfig: vi.fn(), fetchTelegramDialogs: vi.fn(),
  saveTelegramApiConfig: vi.fn(), sendTelegramCode: vi.fn(), verifyTelegramCode: vi.fn(), verifyTelegramPassword: vi.fn(),
  telegramBotLogin: vi.fn(), telegramLogout: vi.fn(), addTelegramChannel: vi.fn(), removeTelegramChannel: vi.fn(),
  setChannelTorrentClient: vi.fn(),
}));

beforeEach(() => { vi.resetAllMocks(); });

describe('queries', () => {
  it('load the status and the API config', async () => {
    vi.mocked(api.fetchTelegramStatus).mockResolvedValue({ connected: true } as api.TelegramStatus);
    vi.mocked(api.fetchTelegramApiConfig).mockResolvedValue({ api_id: '1' } as unknown as api.TelegramApiConfig);
    const { result } = renderHookWithClient(() => ({ s: useTelegramStatus(), c: useTelegramApiConfig() }));
    await waitFor(() => expect(result.current.s.data).toEqual({ connected: true }));
    await waitFor(() => expect(result.current.c.data).toEqual({ api_id: '1' }));
  });

  it('the dialogs list is off until asked for - it hits Telegram', async () => {
    vi.mocked(api.fetchTelegramDialogs).mockResolvedValue({ dialogs: [] });
    const { rerender, result } = renderHookWithClient(({ on }: { on: boolean }) => useTelegramDialogs(on), { initialProps: { on: false } });
    await new Promise(r => setTimeout(r, 20));
    expect(api.fetchTelegramDialogs).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.data).toEqual({ dialogs: [] }));
  });
});

describe('mutations', () => {
  it.each([
    ['save API config', useSaveTelegramApiConfig, 'saveTelegramApiConfig', { apiId: '1', apiHash: 'h' }, ['1', 'h']],
    ['verify code', useVerifyTelegramCode, 'verifyTelegramCode', '12345', ['12345']],
    ['verify password', useVerifyTelegramPassword, 'verifyTelegramPassword', 'pw', ['pw']],
    ['bot login', useTelegramBotLogin, 'telegramBotLogin', 'tok', ['tok']],
    ['logout', useTelegramLogout, 'telegramLogout', undefined, []],
    ['add channel', useAddTelegramChannel, 'addTelegramChannel', '@chan', ['@chan']],
    ['remove channel', useRemoveTelegramChannel, 'removeTelegramChannel', 42, [42]],
    ['channel torrent client', useSetChannelTorrentClient, 'setChannelTorrentClient', { chatId: 42, client: 'qbittorrent' }, [42, 'qbittorrent']],
  ] as const)('%s refreshes the telegram tree', async (_n, hook, fn, vars, expected) => {
    vi.mocked(api[fn] as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'ok' });
    const { result, client } = renderHookWithClient(hook as () => ReturnType<typeof useTelegramLogout>);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { (result.current as { mutate: (v: unknown) => void }).mutate(vars); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api[fn]).toHaveBeenCalledWith(...expected);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['telegram'] });
  });

  it('sending the code is a step in a flow, not a state change', async () => {
    vi.mocked(api.sendTelegramCode).mockResolvedValue({ status: 'sent' });
    const { result, client } = renderHookWithClient(() => useSendTelegramCode());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(() => { result.current.mutate('+491234'); });
    await waitFor(() => expect(result.current.data?.status).toBe('sent'));
    expect(api.sendTelegramCode).toHaveBeenCalledWith('+491234');
    expect(invalidate).not.toHaveBeenCalled();
  });
});

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchTelegramStatus, fetchTelegramApiConfig, fetchTelegramDialogs,
  saveTelegramApiConfig, sendTelegramCode, verifyTelegramCode, verifyTelegramPassword,
  telegramBotLogin, telegramLogout, addTelegramChannel, removeTelegramChannel, setChannelTorrentClient,
  type TorrentClient,
} from '../api';
import { qk } from '../api/queryKeys';

export function useTelegramStatus() {
  return useQuery({ queryKey: qk.telegramStatus(), queryFn: fetchTelegramStatus });
}

export function useTelegramApiConfig() {
  return useQuery({ queryKey: qk.telegramApiConfig(), queryFn: fetchTelegramApiConfig });
}

export function useTelegramDialogs(enabled = false) {
  return useQuery({ queryKey: qk.telegramDialogs(), queryFn: fetchTelegramDialogs, enabled });
}

function useInvalidateTelegram() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['telegram'] });
}

export function useSaveTelegramApiConfig() {
  const invalidate = useInvalidateTelegram();
  return useMutation({
    mutationFn: (vars: { apiId: string; apiHash: string }) => saveTelegramApiConfig(vars.apiId, vars.apiHash),
    onSuccess: invalidate,
  });
}

export function useSendTelegramCode() {
  return useMutation({ mutationFn: (phone: string) => sendTelegramCode(phone) });
}

export function useVerifyTelegramCode() {
  const invalidate = useInvalidateTelegram();
  return useMutation({ mutationFn: (code: string) => verifyTelegramCode(code), onSuccess: invalidate });
}

export function useVerifyTelegramPassword() {
  const invalidate = useInvalidateTelegram();
  return useMutation({ mutationFn: (password: string) => verifyTelegramPassword(password), onSuccess: invalidate });
}

export function useTelegramBotLogin() {
  const invalidate = useInvalidateTelegram();
  return useMutation({ mutationFn: (token: string) => telegramBotLogin(token), onSuccess: invalidate });
}

export function useTelegramLogout() {
  const invalidate = useInvalidateTelegram();
  return useMutation({ mutationFn: () => telegramLogout(), onSuccess: invalidate });
}

export function useAddTelegramChannel() {
  const invalidate = useInvalidateTelegram();
  return useMutation({ mutationFn: (chat: string) => addTelegramChannel(chat), onSuccess: invalidate });
}

export function useRemoveTelegramChannel() {
  const invalidate = useInvalidateTelegram();
  return useMutation({ mutationFn: (chatId: number) => removeTelegramChannel(chatId), onSuccess: invalidate });
}

export function useSetChannelTorrentClient() {
  const invalidate = useInvalidateTelegram();
  return useMutation({
    mutationFn: (vars: { chatId: number; client: TorrentClient | null }) =>
      setChannelTorrentClient(vars.chatId, vars.client),
    onSuccess: invalidate,
  });
}

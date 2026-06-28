import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchMappings, createMapping, updateMapping, deleteMapping,
  fetchCookies, saveCookies,
  getYtdlpVersion, upgradeYtdlp, syncThumbnails,
  fetchUsers, syncUsers, updateUserRole,
  fetchBotQueries, saveBotQuery, deleteBotQuery, testBotQuery,
} from '../api';
import { qk } from '../api/queryKeys';

// --- Source mappings ---
export function useMappings() {
  return useQuery({ queryKey: qk.mappings(), queryFn: fetchMappings });
}

export function useCreateMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof createMapping>[0]) => createMapping(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mappings() }),
  });
}

export function useUpdateMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: Parameters<typeof updateMapping>[1] }) => updateMapping(vars.id, vars.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mappings() }),
  });
}

export function useDeleteMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteMapping(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.mappings() }),
  });
}

// --- Cookies ---
export function useCookies(enabled = true) {
  return useQuery({ queryKey: qk.cookies(), queryFn: fetchCookies, enabled });
}

export function useSaveCookies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cookies: string) => saveCookies(cookies),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.cookies() }),
  });
}

// --- yt-dlp jobs ---
export function useYtdlpVersion(enabled = true) {
  return useQuery({ queryKey: qk.ytdlpVersion(), queryFn: getYtdlpVersion, enabled });
}

export function useUpgradeYtdlp() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => upgradeYtdlp(), onSuccess: () => qc.invalidateQueries({ queryKey: qk.ytdlpVersion() }) });
}

export function useSyncThumbnails() {
  return useMutation({ mutationFn: () => syncThumbnails() });
}

// --- Users ---
export function useUsers() {
  return useQuery({ queryKey: qk.users(), queryFn: () => fetchUsers().then(r => r.users) });
}

export function useSyncUsers() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => syncUsers(), onSuccess: () => qc.invalidateQueries({ queryKey: qk.users() }) });
}

export function useUpdateUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userId: number; role: 'admin' | 'user' }) => updateUserRole(vars.userId, vars.role),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users() }),
  });
}

// --- Bot queries ---
export function useBotQueries() {
  return useQuery({ queryKey: qk.botQueries(), queryFn: () => fetchBotQueries().then(r => r.queries) });
}

export function useSaveBotQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { key: string; command: string; originalKey?: string }) =>
      saveBotQuery(vars.key, vars.command, vars.originalKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.botQueries() }),
  });
}

export function useDeleteBotQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => deleteBotQuery(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.botQueries() }),
  });
}

export function useTestBotQuery() {
  return useMutation({ mutationFn: (command: string) => testBotQuery(command) });
}

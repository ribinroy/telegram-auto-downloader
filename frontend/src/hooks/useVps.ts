import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchVpsConfig, saveVpsConfig, testVpsConnection, deleteVpsConfig,
  fetchVpsFolders, addVpsFolders, deleteVpsFolder, updateVpsFolder,
  fetchVpsFiles, downloadVpsFile, deleteVpsRemote,
  type VpsConfigInput, type TorrentClient,
} from '../api';
import { qk } from '../api/queryKeys';

export function useVpsConfig() {
  return useQuery({ queryKey: qk.vpsConfig(), queryFn: fetchVpsConfig });
}

export function useVpsFolders() {
  return useQuery({ queryKey: qk.vpsFolders(), queryFn: fetchVpsFolders });
}

export function useVpsFiles(showSecured: boolean, enabled = true) {
  return useQuery({
    queryKey: qk.vpsFiles(showSecured),
    queryFn: () => fetchVpsFiles(showSecured),
    enabled,
  });
}

function useInvalidateVps() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['vps'] });
}

export function useSaveVpsConfig() {
  const invalidate = useInvalidateVps();
  return useMutation({ mutationFn: (config: VpsConfigInput) => saveVpsConfig(config), onSuccess: invalidate });
}

export function useTestVpsConnection() {
  return useMutation({ mutationFn: (config: VpsConfigInput) => testVpsConnection(config) });
}

export function useDeleteVpsConfig() {
  const invalidate = useInvalidateVps();
  return useMutation({ mutationFn: () => deleteVpsConfig(), onSuccess: invalidate });
}

export function useAddVpsFolders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => addVpsFolders(paths),
    onSuccess: (folders) => { qc.setQueryData(qk.vpsFolders(), folders); qc.invalidateQueries({ queryKey: ['vps', 'files'] }); },
  });
}

export function useDeleteVpsFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteVpsFolder(id),
    onSuccess: (folders) => { qc.setQueryData(qk.vpsFolders(), folders); qc.invalidateQueries({ queryKey: ['vps', 'files'] }); },
  });
}

export function useUpdateVpsFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: number; data: Parameters<typeof updateVpsFolder>[1] }) => updateVpsFolder(vars.id, vars.data),
    onSuccess: (folders) => { qc.setQueryData(qk.vpsFolders(), folders); qc.invalidateQueries({ queryKey: ['vps', 'files'] }); },
  });
}

export function useDownloadVpsFile() {
  return useMutation({
    mutationFn: (vars: { path: string; size?: number; client?: TorrentClient }) =>
      downloadVpsFile(vars.path, vars.size, vars.client),
    // The new download surfaces via the downloads socket/list; nothing to invalidate here.
  });
}

export function useDeleteVpsRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => deleteVpsRemote(path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vps', 'files'] }),
  });
}

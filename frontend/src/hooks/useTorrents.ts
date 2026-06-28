import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchTorrentConfig, fetchTorrentList, saveTorrentConfig, deleteTorrentConfig,
  testTorrentConnection, setTelegramDefault, torrentAction, addTorrent, addTorrentFile,
  type TorrentClient,
} from '../api';
import { qk } from '../api/queryKeys';

export function useTorrentConfig() {
  return useQuery({ queryKey: qk.torrentConfig(), queryFn: fetchTorrentConfig });
}

/** Live torrent status for a client (auto-refreshes every 20s). */
export function useTorrentList(client: TorrentClient, enabled = true) {
  return useQuery({
    queryKey: qk.torrentList(client),
    queryFn: () => fetchTorrentList(client),
    enabled,
    refetchInterval: 20_000,
  });
}

function useInvalidateTorrent() {
  const qc = useQueryClient();
  // Torrent config also drives the per-channel selector in Telegram settings.
  return () => {
    qc.invalidateQueries({ queryKey: ['torrent'] });
    qc.invalidateQueries({ queryKey: ['telegram'] });
  };
}

export function useSaveTorrentConfig() {
  const invalidate = useInvalidateTorrent();
  return useMutation({
    mutationFn: (vars: { client: TorrentClient; config: Parameters<typeof saveTorrentConfig>[1] }) =>
      saveTorrentConfig(vars.client, vars.config),
    onSuccess: invalidate,
  });
}

export function useDeleteTorrentConfig() {
  const invalidate = useInvalidateTorrent();
  return useMutation({ mutationFn: (client: TorrentClient) => deleteTorrentConfig(client), onSuccess: invalidate });
}

export function useTestTorrentConnection() {
  return useMutation({
    mutationFn: (vars: { client: TorrentClient; config: Parameters<typeof testTorrentConnection>[1] }) =>
      testTorrentConnection(vars.client, vars.config),
  });
}

export function useSetTelegramDefault() {
  const invalidate = useInvalidateTorrent();
  return useMutation({ mutationFn: (client: TorrentClient | null) => setTelegramDefault(client), onSuccess: invalidate });
}

export function useTorrentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { client: TorrentClient; action: 'start' | 'stop' | 'remove' | 'verify'; hashes: string[]; deleteData?: boolean }) =>
      torrentAction(vars.client, vars.action, vars.hashes, vars.deleteData),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: qk.torrentList(vars.client) }),
  });
}

export function useAddTorrent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { magnet: string; client: TorrentClient; downloadDir?: string | null }) =>
      addTorrent(vars.magnet, vars.client, vars.downloadDir),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: qk.torrentList(vars.client) }),
  });
}

export function useAddTorrentFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { file: File; client: TorrentClient; downloadDir?: string | null }) =>
      addTorrentFile(vars.file, vars.client, vars.downloadDir),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: qk.torrentList(vars.client) }),
  });
}

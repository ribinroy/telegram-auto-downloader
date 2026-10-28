import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchTorrentConfig, fetchTorrentList, fetchTorrentDetails, setTorrentFilePriority, saveTorrentConfig, deleteTorrentConfig,
  testTorrentConnection, setTelegramDefault, torrentAction, addTorrent, addTorrentFile,
  setStopOnComplete,
  type TorrentClient, type TorrentActionName, type TorrentDetails, type TorrentFilePriority,
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

/** One torrent's files and details, while its modal is open. Refreshes every
 *  5s until it is complete - after that nothing on it moves. */
export function useTorrentDetails(client: TorrentClient, hash: string | null) {
  return useQuery({
    queryKey: qk.torrentDetails(client, hash ?? ''),
    queryFn: () => fetchTorrentDetails(client, hash as string),
    enabled: !!hash,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data && query.state.data.torrent.percent_done >= 100 ? false : 5_000),
  });
}

/** Skip files / set their priority. Applied to the open modal at once (a
 *  select that snaps back until the client answers reads as broken), then
 *  refetched, so the client's own view wins. */
export function useSetTorrentFilePriority(client: TorrentClient, hash: string) {
  const qc = useQueryClient();
  const key = qk.torrentDetails(client, hash);
  return useMutation({
    mutationFn: ({ indices, priority }: { indices: number[]; priority: TorrentFilePriority }) =>
      setTorrentFilePriority(client, hash, indices, priority),
    onMutate: async ({ indices, priority }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<TorrentDetails>(key);
      const set = new Set(indices);
      qc.setQueryData<TorrentDetails>(key, old => old && {
        ...old,
        files: old.files.map(f => (set.has(f.index) ? { ...f, priority, wanted: priority !== 'skip' } : f)),
      });
      return { previous };
    },
    onError: (_e, _vars, ctx) => { if (ctx?.previous) qc.setQueryData(key, ctx.previous); },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
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

/** Toggle 'stop seeding when complete' for one client. */
export function useSetStopOnComplete() {
  const invalidate = useInvalidateTorrent();
  return useMutation({
    mutationFn: (vars: { client: TorrentClient; enabled: boolean }) =>
      setStopOnComplete(vars.client, vars.enabled),
    onSuccess: invalidate,
  });
}

export function useTorrentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { client: TorrentClient; action: TorrentActionName; hashes: string[]; deleteData?: boolean }) =>
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

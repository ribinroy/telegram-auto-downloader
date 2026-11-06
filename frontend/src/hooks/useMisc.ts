import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { login, updatePassword, checkUrl, fetchAnalytics } from '../api';
import { qk } from '../api/queryKeys';
import { listSubtitleTracks, subtitleSourceKey, type SubtitleSource } from '../api/subtitles';
import {
  fetchInternetSpeed, startInternetSpeed, cancelInternetSpeed, isInternetRunning,
  fetchSpeedResults, recordBrowserResult, deleteSpeedResult, type SpeedTestKind,
} from '../api/internetSpeed';
import {
  fetchVrSettings, regenerateVrKey, disableVrKey, setVrIncludeSecured,
  fetchDownloadProjection, saveDownloadProjection, type VrFeedSettings,
} from '../api/vr';
import type { Projection } from '../utils/vr';

// --- Auth (imperative) ---
export function useLogin() {
  return useMutation({ mutationFn: (vars: { username: string; password: string }) => login(vars.username, vars.password) });
}

export function useUpdatePassword() {
  return useMutation({
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      updatePassword(vars.currentPassword, vars.newPassword),
  });
}

// --- URL check (imperative) ---
export function useCheckUrl() {
  return useMutation({ mutationFn: (url: string) => checkUrl(url) });
}

// --- Analytics ---
export function useAnalytics(days: number, groupBy: 'day' | 'hour', includeDeleted: boolean) {
  return useQuery({
    queryKey: qk.analytics(days, groupBy, includeDeleted),
    queryFn: () => fetchAnalytics(days, groupBy, includeDeleted),
  });
}

// --- Subtitle tracks of a video (sidecars + embedded) ---
export function useSubtitleTracks(source: SubtitleSource | null) {
  return useQuery({
    queryKey: qk.subtitles(source ? subtitleSourceKey(source) : ''),
    queryFn: () => listSubtitleTracks(source!),
    enabled: !!source,
    // Probing an MKV is cheap but not free; a track list doesn't change mid-play.
    staleTime: 10 * 60 * 1000,
  });
}

// --- Speed tests: the box's uplink (runs on the backend, polled while it
// runs) and the shared results table both kinds of run are recorded in ---
export function useInternetSpeed(enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.internetSpeed(),
    queryFn: async () => {
      const status = await fetchInternetSpeed();
      const prev = qc.getQueryData<typeof status>(qk.internetSpeed());
      // The run finished since the last poll: its row is in the table now.
      if (prev && isInternetRunning(prev.phase) && !isInternetRunning(status.phase)) {
        void qc.invalidateQueries({ queryKey: ['speedtest', 'results'] });
      }
      return status;
    },
    enabled,
    staleTime: 0,
    refetchInterval: (q) => (isInternetRunning(q.state.data?.phase) ? 500 : false),
  });
}

export function useStartInternetSpeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: startInternetSpeed,
    onSettled: () => qc.invalidateQueries({ queryKey: qk.internetSpeed() }),
  });
}

export function useCancelInternetSpeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: cancelInternetSpeed,
    onSettled: () => qc.invalidateQueries({ queryKey: qk.internetSpeed() }),
  });
}

export function useSpeedResults(kind: SpeedTestKind | 'all', enabled = true, limit = 20) {
  return useQuery({
    queryKey: qk.speedResults(`${kind}:${limit}`),
    queryFn: () => fetchSpeedResults(kind === 'all' ? undefined : kind, limit),
    enabled,
    staleTime: 0,
  });
}

export function useRecordBrowserResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: recordBrowserResult,
    onSettled: () => qc.invalidateQueries({ queryKey: ['speedtest', 'results'] }),
  });
}

export function useDeleteSpeedResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteSpeedResult,
    onSettled: () => qc.invalidateQueries({ queryKey: ['speedtest', 'results'] }),
  });
}

// --- VR headset feed (HereSphere / DeoVR) ---
export function useVrSettings(enabled = true) {
  return useQuery({ queryKey: qk.vrSettings(), queryFn: fetchVrSettings, enabled });
}

function useVrMutation<V>(fn: (v: V) => Promise<VrFeedSettings>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => qc.setQueryData(qk.vrSettings(), data),
  });
}
export const useRegenerateVrKey = () => useVrMutation((includeSecured?: boolean) => regenerateVrKey(includeSecured));
export const useDisableVrKey = () => useVrMutation<void>(() => disableVrKey());
export const useSetVrIncludeSecured = () => useVrMutation((v: boolean) => setVrIncludeSecured(v));

// The projection pick a download carries server-side, so the headset feed
// and the web player agree. Only downloads have one; explorer paths don't.
export function useDownloadProjection(downloadId: number | null) {
  return useQuery({
    queryKey: qk.downloadProjection(downloadId ?? 0),
    queryFn: () => fetchDownloadProjection(downloadId!),
    enabled: downloadId != null,
    staleTime: 10 * 60 * 1000,
  });
}

export function useSaveDownloadProjection(downloadId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projection: Projection | null) => saveDownloadProjection(downloadId!, projection),
    // Optimistic: the picker must not flip back while the save is in flight.
    onMutate: (projection) => {
      if (downloadId == null) return;
      qc.setQueryData(qk.downloadProjection(downloadId), (old: { projection: Projection | null; detected: Projection; lens: string | null } | undefined) =>
        old ? { ...old, projection } : old);
    },
    onSettled: () => { if (downloadId != null) void qc.invalidateQueries({ queryKey: qk.downloadProjection(downloadId) }); },
  });
}

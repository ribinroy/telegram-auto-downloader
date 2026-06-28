import { useEffect } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { connectSocket, disconnectSocket, type StatusUpdate } from '../api/socket';
import { qk } from '../api/queryKeys';
import type { Download, DownloadsResponse } from '../types';

type DownloadsCache = InfiniteData<DownloadsResponse> | undefined;

export interface RealtimeCallbacks {
  onConnectedChange?: (connected: boolean) => void;
  onNewDownload?: (download: Download) => void;
  /** Fired on a status change; `download` is looked up from the cache if present. */
  onStatusChange?: (data: StatusUpdate, download: Download | undefined) => void;
}

/**
 * Bridges Socket.IO events into the React Query cache. Mount once (in Layout).
 * High-frequency events (progress/status/meta/new/deleted) patch the cache
 * directly with setQueriesData — no refetch. A (re)connect does a one-time
 * invalidate to resync after any missed events. Optional callbacks let the UI
 * surface toasts / connection state without re-subscribing to the socket.
 */
export function useRealtime(cb: RealtimeCallbacks = {}) {
  const qc = useQueryClient();
  const { onConnectedChange, onNewDownload, onStatusChange } = cb;

  useEffect(() => {
    const patchDownloads = (fn: (downloads: Download[]) => Download[]) => {
      qc.setQueriesData<DownloadsCache>({ queryKey: ['downloads'] }, (old) => {
        if (!old) return old;
        return { ...old, pages: old.pages.map(page => ({ ...page, downloads: fn(page.downloads) })) };
      });
    };

    const findDownload = (messageId: string): Download | undefined => {
      const caches = qc.getQueriesData<DownloadsCache>({ queryKey: ['downloads'] });
      for (const [, data] of caches) {
        const hit = data?.pages.flatMap(p => p.downloads).find(d => d.message_id === messageId);
        if (hit) return hit;
      }
      return undefined;
    };

    const mergeById = (messageId: string, patch: Partial<Download>) =>
      patchDownloads(list => list.map(d => (d.message_id === messageId ? { ...d, ...patch } : d)));

    connectSocket({
      onNew: (download) => {
        patchDownloads(list => (list.some(d => d.message_id === download.message_id) ? list : [download, ...list]));
        onNewDownload?.(download);
      },
      onDeleted: ({ message_id }) => patchDownloads(list => list.filter(d => d.message_id !== message_id)),
      onProgress: (p) => mergeById(p.message_id, {
        progress: p.progress,
        downloaded_bytes: p.downloaded_bytes,
        total_bytes: p.total_bytes,
        speed: p.speed,
        pending_time: p.pending_time,
      }),
      onStatus: (s) => {
        const dl = findDownload(s.message_id);
        mergeById(s.message_id, { status: s.status, error: s.error || null, speed: 0 });
        onStatusChange?.(s, dl);
      },
      onMeta: (m) => mergeById(m.message_id, { file_meta: m.file_meta }),
      onStats: (stats) => qc.setQueryData(qk.stats(), stats),
      onConnect: () => {
        onConnectedChange?.(true);
        qc.invalidateQueries({ queryKey: ['downloads'] });
        qc.invalidateQueries({ queryKey: qk.stats() });
      },
      onDisconnect: () => onConnectedChange?.(false),
    });

    return () => { disconnectSocket(); };
  }, [qc, onConnectedChange, onNewDownload, onStatusChange]);
}

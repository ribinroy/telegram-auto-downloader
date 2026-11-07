import { useEffect } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { connectSocket, disconnectSocket, type StatusUpdate } from '../api/socket';
import { qk } from '../api/queryKeys';
import type { Download, DownloadsResponse, QueueState } from '../types';

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
    const patchPages = (fn: (pages: DownloadsResponse[]) => DownloadsResponse[], arriving = false) => {
      qc.setQueriesData<DownloadsCache>({
        queryKey: ['downloads'],
        // A download that just arrived isn't on disk yet - keep it out of
        // the "On disk" list rather than prepending it there.
        predicate: q => !arriving || (q.queryKey[1] as { filter?: string } | undefined)?.filter !== 'on_disk',
      }, (old) => {
        if (!old) return old;
        return { ...old, pages: fn(old.pages) };
      });
    };

    const patchDownloads = (fn: (downloads: Download[]) => Download[]) =>
      patchPages(pages => pages.map(page => ({ ...page, downloads: fn(page.downloads) })));

    // A new download goes to the top of the list - the first page only. It
    // used to be prepended to every page (the duplicate check was per page),
    // so a list scrolled past one page showed each arrival twice.
    const prependDownload = (download: Download) => patchPages(pages => {
      if (pages.some(p => p.downloads.some(d => d.message_id === download.message_id))) return pages;
      return pages.map((page, i) => (i === 0 ? { ...page, downloads: [download, ...page.downloads] } : page));
    }, true);

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

    // Any download starting, finishing or arriving can move the queue
    const refreshQueue = () => qc.invalidateQueries({ queryKey: qk.queue() });

    connectSocket({
      onNew: (download) => {
        refreshQueue();
        prependDownload(download);
        onNewDownload?.(download);
      },
      onDeleted: ({ message_id }) => {
        patchDownloads(list => list.filter(d => d.message_id !== message_id));
        refreshQueue();
      },
      onProgress: (p) => {
        const patch = {
          progress: p.progress,
          downloaded_bytes: p.downloaded_bytes,
          total_bytes: p.total_bytes,
          speed: p.speed,
          pending_time: p.pending_time,
        };
        mergeById(p.message_id, patch);
        // The queue modal lists running downloads too; keep its bars live
        qc.setQueryData<QueueState>(qk.queue(), old => old && {
          ...old,
          running: old.running.map(d => (d.message_id === p.message_id ? { ...d, ...patch } : d)),
        });
      },
      onStatus: (s) => {
        const dl = findDownload(s.message_id);
        mergeById(s.message_id, { status: s.status, error: s.error || null, speed: 0 });
        refreshQueue();
        onStatusChange?.(s, dl);
      },
      onMeta: (m) => mergeById(m.message_id, { file_meta: m.file_meta }),
      onFileCount: (f) => mergeById(f.message_id, { file_count: f.file_count }),
      onStats: (stats) => qc.setQueryData(qk.stats(), stats),
      onQueueChanged: refreshQueue,
      onConnect: () => {
        onConnectedChange?.(true);
        qc.invalidateQueries({ queryKey: ['downloads'] });
        qc.invalidateQueries({ queryKey: qk.stats() });
        refreshQueue();
      },
      onDisconnect: () => onConnectedChange?.(false),
    });

    return () => { disconnectSocket(); };
  }, [qc, onConnectedChange, onNewDownload, onStatusChange]);
}

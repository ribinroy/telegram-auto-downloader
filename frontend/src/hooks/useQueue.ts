import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchQueue, setQueueLimits, reorderQueue, startQueuedNow, stopAllDownloads, resumeAllDownloads,
} from '../api';
import { qk } from '../api/queryKeys';
import type { Download, QueueSource, QueueState } from '../types';

/** Which slot a download counts against - mirrors backend/resume.source_of(). */
export function queueSourceOf(d: Pick<Download, 'downloaded_from' | 'url'>): QueueSource {
  if (d.downloaded_from === 'vps') return 'vps';
  if (d.downloaded_from === 'telegram') return 'telegram';
  return d.url ? 'ytdlp' : 'telegram';
}

/** The download queue. Kept fresh by the socket ('queue:changed' and every
 *  download status change invalidate it); the interval is only a backstop. */
export function useQueue() {
  return useQuery({
    queryKey: qk.queue(),
    queryFn: fetchQueue,
    staleTime: 0,
    refetchInterval: 15_000,
  });
}

/** Where a waiting download stands in line (1-based), or null. */
export function useQueuePlace(messageId: string | null | undefined) {
  const { data } = useQueue();
  if (!messageId || !data) return null;
  const index = data.waiting.findIndex(d => d.message_id === messageId);
  return index < 0 ? null : index + 1;
}

export function useSetQueueLimits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (limits: Partial<QueueState['limits']>) => setQueueLimits(limits),
    // Optimistic, so a stepper clicked three times in a row counts all three
    onMutate: (limits) => {
      qc.setQueryData<QueueState>(qk.queue(), old =>
        old ? { ...old, limits: { ...old.limits, ...limits } } : old);
    },
    onSuccess: (state) => qc.setQueryData(qk.queue(), state),
    onError: () => qc.invalidateQueries({ queryKey: qk.queue() }),
  });
}

export function useReorderQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageIds: string[]) => reorderQueue(messageIds),
    // Apply the new order at once - waiting for the round trip makes a
    // dropped row snap back to where it was for a moment.
    onMutate: (messageIds) => {
      qc.setQueryData<QueueState>(qk.queue(), old => {
        if (!old) return old;
        const byId = new Map(old.waiting.map(d => [d.message_id, d]));
        const ordered = messageIds.map(id => byId.get(id)).filter(d => d !== undefined);
        return { ...old, waiting: ordered };
      });
    },
    onSuccess: (state) => qc.setQueryData(qk.queue(), state),
    onError: () => qc.invalidateQueries({ queryKey: qk.queue() }),
  });
}

export function useStartQueuedNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => startQueuedNow(messageId),
    onSuccess: (state) => {
      qc.setQueryData(qk.queue(), state);
      qc.invalidateQueries({ queryKey: ['downloads'] });
    },
  });
}

/** Bulk actions change many rows at once: take the queue from the response
 *  and refetch the downloads list rather than patching it row by row. */
function useBulkQueueAction<T extends QueueState>(fn: () => Promise<T>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (state) => {
      qc.setQueryData(qk.queue(), state);
      qc.invalidateQueries({ queryKey: ['downloads'] });
      qc.invalidateQueries({ queryKey: qk.stats() });
    },
  });
}

export const useStopAllDownloads = () => useBulkQueueAction(stopAllDownloads);
export const useResumeAllDownloads = () => useBulkQueueAction(resumeAllDownloads);

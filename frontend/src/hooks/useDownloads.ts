import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchDownloads, fetchStats, fetchAuthors,
  retryDownload, stopDownload, pauseDownload, resumeDownload, deleteDownload, downloadUrl,
  type FetchDownloadsOptions, type DownloadOptions,
} from '../api';
import { qk } from '../api/queryKeys';

const PAGE_SIZE = 30;

export type DownloadFilters = Omit<FetchDownloadsOptions, 'offset' | 'limit'>;

/** Paginated, infinite-scroll downloads list. Pages are flattened by the caller. */
export function useDownloads(filters: DownloadFilters) {
  return useInfiniteQuery({
    queryKey: qk.downloads(filters),
    queryFn: ({ pageParam }) => fetchDownloads({ ...filters, offset: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.has_more ? allPages.reduce((n, p) => n + p.downloads.length, 0) : undefined,
  });
}

export function useStats() {
  return useQuery({ queryKey: qk.stats(), queryFn: fetchStats });
}

export function useAuthors() {
  return useQuery({ queryKey: qk.authors(), queryFn: fetchAuthors });
}

/** Invalidate the downloads list + stats after a mutation. */
function useRefreshDownloads() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['downloads'] });
    qc.invalidateQueries({ queryKey: qk.stats() });
  };
}

export function useRetryDownload() {
  const refresh = useRefreshDownloads();
  return useMutation({ mutationFn: (id: number) => retryDownload(id), onSuccess: refresh });
}

export function useStopDownload() {
  const refresh = useRefreshDownloads();
  return useMutation({ mutationFn: (messageId: string) => stopDownload(messageId), onSuccess: refresh });
}

export function usePauseDownload() {
  const refresh = useRefreshDownloads();
  return useMutation({ mutationFn: (messageId: string) => pauseDownload(messageId), onSuccess: refresh });
}

export function useResumeDownload() {
  const refresh = useRefreshDownloads();
  return useMutation({ mutationFn: (messageId: string) => resumeDownload(messageId), onSuccess: refresh });
}

export function useDeleteDownload() {
  const refresh = useRefreshDownloads();
  return useMutation({
    mutationFn: ({ messageId, deleteFile }: { messageId: string; deleteFile?: boolean }) =>
      deleteDownload(messageId, deleteFile),
    onSuccess: refresh,
  });
}

export function useDownloadUrl() {
  const refresh = useRefreshDownloads();
  return useMutation({ mutationFn: (opts: DownloadOptions) => downloadUrl(opts), onSuccess: refresh });
}

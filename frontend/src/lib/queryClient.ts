import { QueryClient } from '@tanstack/react-query';

// Singleton QueryClient. Exported so non-React code (the Socket.IO layer) can
// patch/invalidate the cache via queryClient.setQueryData / invalidateQueries.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,   // global 5-minute freshness
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

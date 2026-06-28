import type { FetchDownloadsOptions, TorrentClient } from './index';

// Central registry of React Query keys. Every key is a function returning a
// readonly array so params are part of the key. Invalidate by prefix, e.g.
// queryClient.invalidateQueries({ queryKey: ['torrent'] }).
export const qk = {
  downloads: (filters: Omit<FetchDownloadsOptions, 'offset' | 'limit'>) => ['downloads', filters] as const,
  authors: () => ['authors'] as const,
  stats: () => ['stats'] as const,
  analytics: (days: number, groupBy: 'day' | 'hour', includeDeleted: boolean) =>
    ['analytics', days, groupBy, includeDeleted] as const,
  mappings: () => ['mappings'] as const,
  cookies: () => ['cookies'] as const,
  ytdlpVersion: () => ['ytdlp', 'version'] as const,
  users: () => ['users'] as const,
  botQueries: () => ['bot', 'queries'] as const,

  vpsConfig: () => ['vps', 'config'] as const,
  vpsFolders: () => ['vps', 'folders'] as const,
  vpsFiles: (showSecured: boolean) => ['vps', 'files', showSecured] as const,

  torrentConfig: () => ['torrent', 'config'] as const,
  torrentList: (client: TorrentClient) => ['torrent', 'list', client] as const,

  telegramStatus: () => ['telegram', 'status'] as const,
  telegramApiConfig: () => ['telegram', 'api'] as const,
  telegramDialogs: () => ['telegram', 'dialogs'] as const,
} as const;

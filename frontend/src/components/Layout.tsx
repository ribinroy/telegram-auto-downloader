import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Outlet, useNavigate, useLocation, useOutletContext } from 'react-router-dom';
import { Wifi, WifiOff, HardDrive, Clock, Zap, LogOut, Settings, BarChart3 } from 'lucide-react';
import { formatBytes, formatSpeed } from '../utils/format';
import { type SortBy, type SortOrder } from '../api';
import { ToastContainer, useToast } from './Toast';
import { ROUTES } from '../routes';
import type { Download as DownloadType, Stats } from '../types';
import {
  useDownloads, useStats, useAuthors,
  useRetryDownload, useStopDownload, usePauseDownload, useResumeDownload, useDeleteDownload,
} from '../hooks/useDownloads';
import { useVpsConfig, useVpsFolders } from '../hooks/useVps';
import { useRealtime, type RealtimeCallbacks } from '../hooks/useRealtime';

const EMPTY_STATS: Stats = {
  total_downloaded: 0, total_size: 0, pending_bytes: 0, total_speed: 0,
  downloaded_count: 0, total_count: 0, all_count: 0, active_count: 0,
};

export interface LayoutContext {
  downloads: DownloadType[];
  totalResults: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  search: string;
  setSearch: (s: string) => void;
  debouncedSearch: string;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
  sortOrder: SortOrder;
  setSortOrder: (s: SortOrder) => void;
  authors: string[];
  selectedAuthor: string;
  setSelectedAuthor: (s: string) => void;
  loadMore: () => void;
  onRetry: (id: number) => Promise<void>;
  onStop: (messageId: string) => Promise<void>;
  onPause: (messageId: string) => Promise<void>;
  onResume: (messageId: string) => Promise<void>;
  onDelete: (messageId: string, deleteFile?: boolean) => Promise<void>;
  addUrlOpen: boolean;
  setAddUrlOpen: (open: boolean) => void;
  pastedUrl: string | null;
  setPastedUrl: (url: string | null) => void;
  showSecured: boolean;
  refreshDownloads: () => void;
  vpsReady: boolean;
}

export function useLayoutContext() {
  return useOutletContext<LayoutContext>();
}

export function Layout({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { toasts, addToast, dismissToast } = useToast();

  // Search/sort/filter
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('created_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedAuthor, setSelectedAuthor] = useState<string>('');

  // Secured/hidden state (driven by secured sources/folders)
  const [showSecured, setShowSecured] = useState(false);
  const [secretClickCount, setSecretClickCount] = useState(0);
  const secretClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add URL modal
  const [addUrlOpen, setAddUrlOpen] = useState(false);
  const [pastedUrl, setPastedUrl] = useState<string | null>(null);

  // Connection state (driven by the realtime socket)
  const [connected, setConnected] = useState(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Downloads (infinite), stats, authors via React Query
  const filters = useMemo(() => ({
    search: debouncedSearch || undefined,
    filter: 'all' as const,
    sortBy, sortOrder,
    includeHidden: showSecured,
    author: selectedAuthor || undefined,
  }), [debouncedSearch, sortBy, sortOrder, showSecured, selectedAuthor]);

  const downloadsQuery = useDownloads(filters);
  const downloads = useMemo(
    () => downloadsQuery.data?.pages.flatMap(p => p.downloads) ?? [],
    [downloadsQuery.data]);
  const totalResults = downloadsQuery.data?.pages[0]?.total ?? 0;

  const statsQuery = useStats();
  const stats: Stats = statsQuery.data ?? EMPTY_STATS;
  const authorsQuery = useAuthors();
  const authors = authorsQuery.data ?? [];

  // VPS readiness (configured + at least one active watched folder)
  const vpsConfig = useVpsConfig();
  const vpsFolders = useVpsFolders();
  const vpsReady = !!vpsConfig.data?.configured && (vpsFolders.data ?? []).some(f => f.active);

  // Realtime: socket patches the query cache; surface toasts + connection state.
  const realtimeCb: RealtimeCallbacks = useMemo(() => ({
    onConnectedChange: setConnected,
    onNewDownload: (d) => addToast({ type: 'info', title: 'Download Started', message: d.file, duration: 3000 }),
    onStatusChange: (s, d) => {
      if (!d) return;
      if (s.status === 'done') addToast({ type: 'success', title: 'Download Complete', message: d.file, duration: 5000 });
      else if (s.status === 'failed') addToast({ type: 'error', title: 'Download Failed', message: d.file, duration: 6000 });
    },
  }), [addToast]);
  useRealtime(realtimeCb);

  // Download actions (mutations)
  const retryMut = useRetryDownload();
  const stopMut = useStopDownload();
  const pauseMut = usePauseDownload();
  const resumeMut = useResumeDownload();
  const deleteMut = useDeleteDownload();
  const onRetry = async (id: number) => { await retryMut.mutateAsync(id); };
  const onStop = async (message_id: string) => { await stopMut.mutateAsync(message_id); };
  const onPause = async (message_id: string) => { await pauseMut.mutateAsync(message_id); };
  const onResume = async (message_id: string) => { await resumeMut.mutateAsync(message_id); };
  const onDelete = async (message_id: string, deleteFile?: boolean) => {
    await deleteMut.mutateAsync({ messageId: message_id, deleteFile });
  };

  const loadMore = useCallback(() => {
    if (!downloadsQuery.isFetchingNextPage && downloadsQuery.hasNextPage) downloadsQuery.fetchNextPage();
  }, [downloadsQuery]);

  // Secured toggle
  const toggleSecured = useCallback(() => {
    setShowSecured(prev => !prev);
    setSecretClickCount(0);
  }, []);

  const handleSecretClick = () => {
    if (secretClickTimer.current) clearTimeout(secretClickTimer.current);
    const newCount = secretClickCount + 1;
    setSecretClickCount(newCount);
    if (newCount >= 3) {
      toggleSecured();
    } else {
      secretClickTimer.current = setTimeout(() => setSecretClickCount(0), 1000);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'x') { e.preventDefault(); toggleSecured(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSecured]);

  const context: LayoutContext = {
    downloads, totalResults,
    loading: downloadsQuery.isLoading,
    loadingMore: downloadsQuery.isFetchingNextPage,
    hasMore: !!downloadsQuery.hasNextPage,
    error: downloadsQuery.isError ? 'Failed to fetch downloads' : null,
    search, setSearch, debouncedSearch,
    sortBy, setSortBy, sortOrder, setSortOrder,
    authors, selectedAuthor, setSelectedAuthor,
    loadMore, onRetry, onStop, onPause, onResume, onDelete,
    addUrlOpen, setAddUrlOpen, pastedUrl, setPastedUrl,
    showSecured, refreshDownloads: () => { downloadsQuery.refetch(); },
    vpsReady,
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Fixed Header */}
      <div className="fixed top-0 left-0 right-0 z-40 bg-slate-900/80 backdrop-blur-xl border-b border-slate-700/50">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="p-2 sm:p-3 rounded-xl cursor-pointer" onClick={() => navigate(ROUTES.DOWNLOADS)}>
                <img src="/logo.png" alt="DownLee logo" className="w-6 h-6 sm:w-8 sm:h-8" />
              </div>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-3">
              {/* Total Downloaded - hidden on mobile */}
              <div className="hidden sm:flex group relative items-center gap-2 px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default min-w-[100px]">
                <HardDrive className="w-4 h-4 text-green-400" />
                <span className="text-sm text-green-400 tabular-nums">{formatBytes(stats.total_downloaded)}</span>
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                  Downloaded
                </div>
              </div>
              {/* Pending */}
              <div className="group relative flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default sm:min-w-[100px]">
                <Clock className="hidden sm:block w-4 h-4 text-yellow-400" />
                <span className="text-xs sm:text-sm text-yellow-400 tabular-nums">{formatBytes(stats.pending_bytes)}</span>
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                  Pending
                </div>
              </div>
              {/* Speed */}
              <div className="group relative flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default sm:min-w-[110px]">
                <Zap className="hidden sm:block w-4 h-4 text-purple-400" />
                <span className="text-xs sm:text-sm text-purple-400 tabular-nums">{formatSpeed(stats.total_speed)}</span>
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                  Speed
                </div>
              </div>
              {/* Connection status - secret click target */}
              <div
                onClick={handleSecretClick}
                className={`flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-lg sm:min-w-[80px] cursor-default select-none ${connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}
              >
                {connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                <span className="hidden sm:inline text-sm">{connected ? 'Live' : 'Offline'}</span>
              </div>
              {/* Analytics - only when secured visible */}
              {showSecured && (
                <div className="group relative">
                  <button
                    onClick={() => navigate(ROUTES.ANALYTICS)}
                    className={`p-2 hover:bg-slate-600/50 text-slate-400 hover:text-white rounded-lg transition-colors ${location.pathname === ROUTES.ANALYTICS ? 'bg-slate-600/50 text-white' : 'bg-slate-700/50'}`}
                  >
                    <BarChart3 className="w-4 h-4" />
                  </button>
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                    Analytics
                  </div>
                </div>
              )}
              {/* VPS files - only when configured with watched folders */}
              {vpsReady && (
                <div className="group relative">
                  <button
                    onClick={() => navigate(ROUTES.VPS_FILES)}
                    className={`p-2 hover:bg-slate-600/50 text-slate-400 hover:text-white rounded-lg transition-colors ${location.pathname.startsWith(ROUTES.VPS) ? 'bg-slate-600/50 text-white' : 'bg-slate-700/50'}`}
                  >
                    <HardDrive className="w-4 h-4" />
                  </button>
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                    VPS files
                  </div>
                </div>
              )}
              {/* Settings */}
              <div className="group relative">
                <button
                  onClick={() => navigate(ROUTES.SETTINGS)}
                  className={`p-2 hover:bg-slate-600/50 text-slate-400 hover:text-white rounded-lg transition-colors ${location.pathname === ROUTES.SETTINGS ? 'bg-slate-600/50 text-white' : 'bg-slate-700/50'}`}
                >
                  <Settings className="w-4 h-4" />
                </button>
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                  Settings
                </div>
              </div>
              {/* Logout */}
              <div className="group relative">
                <button
                  onClick={onLogout}
                  className="p-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-400 hover:text-white rounded-lg transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                </button>
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                  Sign out
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Page Content */}
      <div className="pt-14 sm:pt-16">
        <Outlet context={context} />
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

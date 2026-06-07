import { useState, useEffect, useCallback, useRef } from 'react';
import { Outlet, useNavigate, useLocation, useOutletContext } from 'react-router-dom';
import { Wifi, WifiOff, HardDrive, Clock, Zap, LogOut, Settings, BarChart3 } from 'lucide-react';
import { formatBytes, formatSpeed } from '../utils/format';
import { fetchDownloads, fetchStats, fetchAuthors, retryDownload, stopDownload, pauseDownload, resumeDownload, deleteDownload, fetchSecuredMappingIds, fetchVpsConfig, fetchVpsFolders, type SortBy, type SortOrder } from '../api';
import { connectSocket, disconnectSocket, type ProgressUpdate, type StatusUpdate, type DeletedUpdate, type MetaUpdate } from '../api/socket';
import { ToastContainer, useToast } from './Toast';
import { ROUTES } from '../routes';
import type { Download as DownloadType, Stats } from '../types';

const PAGE_SIZE = 30;

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
  loadSecuredMappingIds: () => Promise<void>;
  vpsReady: boolean;
}

export function useLayoutContext() {
  return useOutletContext<LayoutContext>();
}

export function Layout({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();

  // Downloads state
  const [downloads, setDownloads] = useState<DownloadType[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const downloadsRef = useRef<Map<string, DownloadType>>(new Map());

  // Search/sort/filter
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('created_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [authors, setAuthors] = useState<string[]>([]);
  const [selectedAuthor, setSelectedAuthor] = useState<string>('');

  // Secured state
  const [securedMappingIds, setSecuredMappingIds] = useState<number[]>([]);
  const [securedMappingIdsLoaded, setSecuredMappingIdsLoaded] = useState(false);
  const [showSecured, setShowSecured] = useState(false);
  const [secretClickCount, setSecretClickCount] = useState(0);
  const secretClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add URL modal
  const [addUrlOpen, setAddUrlOpen] = useState(false);
  const [pastedUrl, setPastedUrl] = useState<string | null>(null);

  // VPS readiness (configured + at least one watched folder for this connection)
  const [vpsReady, setVpsReady] = useState(false);

  // Connection & stats
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<Stats>({
    total_downloaded: 0,
    total_size: 0,
    pending_bytes: 0,
    total_speed: 0,
    downloaded_count: 0,
    total_count: 0,
    all_count: 0,
    active_count: 0,
  });

  const { toasts, addToast, dismissToast } = useToast();

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // WebSocket handlers
  const handleProgress = useCallback((data: ProgressUpdate) => {
    setDownloads(prev => {
      const updated = prev.map(d =>
        d.message_id === data.message_id ? { ...d, ...data } : d
      );
      const totalSpeed = updated
        .filter(d => d.status === 'downloading')
        .reduce((sum, d) => sum + (d.speed || 0), 0);
      setStats(prev => ({ ...prev, total_speed: totalSpeed }));
      return updated;
    });
  }, []);

  const handleStatus = useCallback((data: StatusUpdate) => {
    const download = downloadsRef.current.get(data.message_id);
    if (download) {
      if (data.status === 'done') {
        addToast({ type: 'success', title: 'Download Complete', message: download.file, duration: 5000 });
      } else if (data.status === 'failed') {
        addToast({ type: 'error', title: 'Download Failed', message: download.file, duration: 6000 });
      }
    }
    setDownloads(prev => prev.map(d =>
      d.message_id === data.message_id
        ? { ...d, status: data.status, error: data.error || null, speed: 0 }
        : d
    ));
  }, [addToast]);

  const handleNewDownload = useCallback((data: DownloadType) => {
    if (data.message_id) downloadsRef.current.set(data.message_id, data);
    addToast({ type: 'info', title: 'Download Started', message: data.file, duration: 3000 });
    setDownloads(prev => [data, ...prev]);
  }, [addToast]);

  const handleDeleted = useCallback((data: DeletedUpdate) => {
    setDownloads(prev => prev.filter(d => d.message_id !== data.message_id));
  }, []);

  const handleMeta = useCallback((data: MetaUpdate) => {
    setDownloads(prev => prev.map(d =>
      d.message_id === data.message_id ? { ...d, file_meta: data.file_meta } : d
    ));
  }, []);

  const handleStats = useCallback((data: Stats) => {
    setStats(data);
  }, []);

  // WebSocket connection
  useEffect(() => {
    connectSocket({
      onProgress: handleProgress,
      onStatus: handleStatus,
      onNew: handleNewDownload,
      onDeleted: handleDeleted,
      onMeta: handleMeta,
      onStats: handleStats,
      onConnect: () => setConnected(true),
      onDisconnect: () => setConnected(false),
    });
    return () => { disconnectSocket(); };
  }, [handleProgress, handleStatus, handleNewDownload, handleDeleted, handleMeta, handleStats]);

  // Fetch downloads
  const loadDownloads = useCallback(async (reset = true) => {
    if (reset) setLoading(true); else setLoadingMore(true);
    try {
      const offset = reset ? 0 : downloads.length;
      const excludeIds = showSecured ? undefined : securedMappingIds;
      const data = await fetchDownloads({
        search: debouncedSearch, filter: 'all', sortBy, sortOrder,
        limit: PAGE_SIZE, offset, excludeMappingIds: excludeIds,
        author: selectedAuthor || undefined,
      });
      if (reset) {
        setDownloads(data.downloads);
        downloadsRef.current.clear();
        data.downloads.forEach((d: DownloadType) => {
          if (d.message_id) downloadsRef.current.set(d.message_id, d);
        });
      } else {
        setDownloads(prev => [...prev, ...data.downloads]);
        data.downloads.forEach((d: DownloadType) => {
          if (d.message_id) downloadsRef.current.set(d.message_id, d);
        });
      }
      setTotalResults(data.total);
      setHasMore(data.has_more);
      setError(null);
    } catch {
      setError('Failed to fetch downloads');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [debouncedSearch, sortBy, sortOrder, showSecured, securedMappingIds, selectedAuthor, downloads.length]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) loadDownloads(false);
  }, [loadDownloads, loadingMore, hasMore]);

  // Fetch secured mapping IDs
  const loadSecuredMappingIds = useCallback(async () => {
    try {
      const ids = await fetchSecuredMappingIds();
      setSecuredMappingIds(ids);
    } catch {
      console.error('Failed to fetch secured mapping IDs');
    } finally {
      setSecuredMappingIdsLoaded(true);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try { setStats(await fetchStats()); } catch { console.error('Failed to fetch stats'); }
  }, []);

  const loadAuthors = useCallback(async () => {
    try { setAuthors(await fetchAuthors()); } catch { console.error('Failed to fetch authors'); }
  }, []);

  // Check VPS readiness for the floating button / page gating
  const loadVpsReady = useCallback(async () => {
    try {
      const [cfg, folders] = await Promise.all([fetchVpsConfig(), fetchVpsFolders()]);
      setVpsReady(!!cfg.configured && folders.some(f => f.active));
    } catch {
      setVpsReady(false);
    }
  }, []);

  // Load initial data
  useEffect(() => {
    loadSecuredMappingIds();
    loadStats();
    loadAuthors();
    loadVpsReady();
  }, [loadSecuredMappingIds, loadStats, loadAuthors, loadVpsReady]);

  // Reload downloads when filters change
  useEffect(() => {
    if (securedMappingIdsLoaded) loadDownloads(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sortBy, sortOrder, showSecured, securedMappingIds, securedMappingIdsLoaded, selectedAuthor]);

  // Download actions
  const onRetry = async (id: number) => { await retryDownload(id); };
  const onStop = async (message_id: string) => { await stopDownload(message_id); };
  const onPause = async (message_id: string) => { await pauseDownload(message_id); };
  const onResume = async (message_id: string) => { await resumeDownload(message_id); };
  const onDelete = async (message_id: string, deleteFile?: boolean) => { await deleteDownload(message_id, deleteFile); };

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
    downloads, totalResults, loading, loadingMore, hasMore, error,
    search, setSearch, debouncedSearch,
    sortBy, setSortBy, sortOrder, setSortOrder,
    authors, selectedAuthor, setSelectedAuthor,
    loadMore, onRetry, onStop, onPause, onResume, onDelete,
    addUrlOpen, setAddUrlOpen, pastedUrl, setPastedUrl,
    showSecured, loadSecuredMappingIds,
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
                    onClick={() => navigate(ROUTES.VPS)}
                    className={`p-2 hover:bg-slate-600/50 text-slate-400 hover:text-white rounded-lg transition-colors ${location.pathname === ROUTES.VPS ? 'bg-slate-600/50 text-white' : 'bg-slate-700/50'}`}
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

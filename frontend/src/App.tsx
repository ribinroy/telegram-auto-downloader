import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Download, Wifi, WifiOff, Loader2, HardDrive, Clock, Zap, LogOut, Settings, Plus, BarChart3 } from 'lucide-react';
import { formatBytes, formatSpeed } from './utils/format';
import { fetchDownloads, fetchStats, retryDownload, stopDownload, deleteDownload, verifyToken, clearToken, getToken, fetchSecuredMappingIds, type SortBy, type SortOrder } from './api';
import { connectSocket, disconnectSocket, type ProgressUpdate, type StatusUpdate, type DeletedUpdate } from './api/socket';
import { DownloadItem } from './components/DownloadItem';
import { LoginPage } from './components/LoginPage';
import { SettingsDialog } from './components/SettingsDialog';
import { AddUrlModal } from './components/AddUrlModal';
import { AnalyticsPage } from './components/AnalyticsPage';
import type { Download as DownloadType, Stats } from './types';

type TabType = 'active' | 'all';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  // Check auth on mount
  useEffect(() => {
    const checkAuth = async () => {
      if (!getToken()) {
        setIsAuthenticated(false);
        return;
      }
      const valid = await verifyToken();
      setIsAuthenticated(valid);
      if (!valid) clearToken();
    };
    checkAuth();
  }, []);

  const handleLogin = () => {
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    clearToken();
    setIsAuthenticated(false);
  };

  // Show loading while checking auth
  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
      </div>
    );
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <MainApp onLogout={handleLogout} />;
}

const PAGE_SIZE = 30;

function MainApp({ onLogout }: { onLogout: () => void }) {
  const [currentPage, setCurrentPage] = useState<'downloads' | 'analytics'>('downloads');
  const [downloads, setDownloads] = useState<DownloadType[]>([]);
  const [securedMappingIds, setSecuredMappingIds] = useState<number[]>([]);
  const [showSecured, setShowSecured] = useState(false);
  const [secretClickCount, setSecretClickCount] = useState(0);
  const secretClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addUrlOpen, setAddUrlOpen] = useState(false);
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
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('active');
  const [sortBy, setSortBy] = useState<SortBy>('created_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Handle progress updates - only update the specific download
  const handleProgress = useCallback((data: ProgressUpdate) => {
    setDownloads(prev => {
      const updated = prev.map(d =>
        d.message_id === data.message_id
          ? { ...d, ...data }
          : d
      );
      // Only update total_speed locally for responsiveness
      // Other stats (total_downloaded, pending_bytes) come from backend via websocket
      const totalSpeed = updated
        .filter(d => d.status === 'downloading')
        .reduce((sum, d) => sum + (d.speed || 0), 0);

      setStats(prev => ({
        ...prev,
        total_speed: totalSpeed
      }));

      return updated;
    });
  }, []);

  // Handle status changes
  const handleStatus = useCallback((data: StatusUpdate) => {
    setDownloads(prev => {
      const updated = prev.map(d =>
        d.message_id === data.message_id
          ? { ...d, status: data.status, error: data.error || null, speed: 0 }
          : d
      );
      // If on active tab and status changed to done, remove it
      if (activeTab === 'active' && data.status === 'done') {
        return updated.filter(d => d.message_id !== data.message_id);
      }
      return updated;
    });
  }, [activeTab]);

  // Handle new downloads
  const handleNewDownload = useCallback((data: DownloadType) => {
    // Only add if matches current filter
    if (activeTab === 'all' || data.status !== 'done') {
      setDownloads(prev => [data, ...prev]);
    }
  }, [activeTab]);

  // Handle deleted downloads
  const handleDeleted = useCallback((data: DeletedUpdate) => {
    setDownloads(prev => prev.filter(d => d.message_id !== data.message_id));
  }, []);

  // Handle stats updates from websocket
  const handleStats = useCallback((data: Stats) => {
    setStats(data);
  }, []);

  // Fetch downloads via REST API
  const loadDownloads = useCallback(async (reset = true) => {
    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const offset = reset ? 0 : downloads.length;
      const excludeIds = showSecured ? undefined : securedMappingIds;
      const data = await fetchDownloads({
        search: debouncedSearch,
        filter: activeTab,
        sortBy,
        sortOrder,
        limit: PAGE_SIZE,
        offset,
        excludeMappingIds: excludeIds,
      });
      if (reset) {
        setDownloads(data.downloads);
      } else {
        setDownloads(prev => [...prev, ...data.downloads]);
      }
      setHasMore(data.has_more);
      setError(null);
    } catch (err) {
      setError('Failed to fetch downloads');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [debouncedSearch, activeTab, sortBy, sortOrder, showSecured, securedMappingIds, downloads.length]);

  // Load more downloads when scrolling to bottom
  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      loadDownloads(false);
    }
  }, [loadDownloads, loadingMore, hasMore]);

  // Fetch secured mapping IDs
  const loadSecuredMappingIds = useCallback(async () => {
    try {
      const ids = await fetchSecuredMappingIds();
      setSecuredMappingIds(ids);
    } catch (err) {
      console.error('Failed to fetch secured mapping IDs');
    }
  }, []);

  // Fetch stats on mount
  const loadStats = useCallback(async () => {
    try {
      const statsData = await fetchStats();
      setStats(statsData);
    } catch (err) {
      console.error('Failed to fetch stats');
    }
  }, []);

  // Load initial data on mount and when search/tab/sort changes
  useEffect(() => {
    loadDownloads(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, activeTab, sortBy, sortOrder, showSecured, securedMappingIds]);

  // Load secured mapping IDs and stats on mount
  useEffect(() => {
    loadSecuredMappingIds();
    loadStats();
  }, [loadSecuredMappingIds, loadStats]);

  // Handle scroll to load more
  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = listElement;
      // Load more when user is within 200px of the bottom
      if (scrollHeight - scrollTop - clientHeight < 200) {
        loadMore();
      }
    };

    listElement.addEventListener('scroll', handleScroll);
    return () => listElement.removeEventListener('scroll', handleScroll);
  }, [loadMore]);

  // Setup WebSocket for real-time updates
  useEffect(() => {
    connectSocket({
      onProgress: handleProgress,
      onStatus: handleStatus,
      onNew: handleNewDownload,
      onDeleted: handleDeleted,
      onStats: handleStats,
      onConnect: () => setConnected(true),
      onDisconnect: () => setConnected(false),
    });

    return () => {
      disconnectSocket();
    };
  }, [handleProgress, handleStatus, handleNewDownload, handleDeleted, handleStats]);

  const handleRetry = async (id: number) => {
    await retryDownload(id);
  };

  const handleStop = async (message_id: string) => {
    await stopDownload(message_id);
  };

  const handleDelete = async (message_id: string) => {
    await deleteDownload(message_id);
  };

  // Secret click handler for showing secured downloads
  const handleSecretClick = () => {
    // Clear existing timer
    if (secretClickTimer.current) {
      clearTimeout(secretClickTimer.current);
    }

    const newCount = secretClickCount + 1;
    setSecretClickCount(newCount);

    if (newCount >= 4) {
      setShowSecured(prev => !prev);
      setSecretClickCount(0);
    } else {
      // Reset count after 1 second of no clicks
      secretClickTimer.current = setTimeout(() => {
        setSecretClickCount(0);
      }, 1000);
    }
  };

  const searchRef = useRef<HTMLInputElement>(null);
  const [pastedUrl, setPastedUrl] = useState<string | null>(null);

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Listen for paste events to open URL modal
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Don't intercept if modal is already open
      if (addUrlOpen) return;

      // Don't intercept paste in input fields or textareas
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const text = e.clipboardData?.getData('text')?.trim();
      if (!text) return;

      // Open modal with pasted text (modal will validate it)
      e.preventDefault();
      setPastedUrl(text);
      setAddUrlOpen(true);

      // Blur any focused input
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [addUrlOpen]);

  // Show analytics page if selected
  if (currentPage === 'analytics') {
    return <AnalyticsPage onBack={() => setCurrentPage('downloads')} />;
  }

  return (
    <div className="h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 pt-1 pb-0 w-full flex flex-col flex-1 min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl">
              <img src="/logo.png" alt="DownLee logo" className="w-8 h-8" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Stats - icon only with tooltips */}
            <div className="group relative flex items-center gap-2 px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default min-w-[100px]">
              <HardDrive className="w-4 h-4 text-green-400" />
              <span className="text-sm text-green-400 tabular-nums">{formatBytes(stats.total_downloaded)}</span>
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                Downloaded
              </div>
            </div>
            <div className="group relative flex items-center gap-2 px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default min-w-[100px]">
              <Clock className="w-4 h-4 text-yellow-400" />
              <span className="text-sm text-yellow-400 tabular-nums">{formatBytes(stats.pending_bytes)}</span>
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                Pending
              </div>
            </div>
            <div className="group relative flex items-center gap-2 px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default min-w-[110px]">
              <Zap className="w-4 h-4 text-purple-400" />
              <span className="text-sm text-purple-400 tabular-nums">{formatSpeed(stats.total_speed)}</span>
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                Speed
              </div>
            </div>
            {/* Connection status - secret click target */}
            <div
              onClick={handleSecretClick}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg min-w-[80px] cursor-default select-none ${connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}
            >
              {connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              <span className="text-sm">{connected ? 'Live' : 'Offline'}</span>
            </div>
            {/* Analytics button - only visible when secured sources are shown */}
            {showSecured && (
              <div className="group relative">
                <button
                  onClick={() => setCurrentPage('analytics')}
                  className="p-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-400 hover:text-white rounded-lg transition-colors"
                >
                  <BarChart3 className="w-4 h-4" />
                </button>
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                  Analytics
                </div>
              </div>
            )}
            {/* Settings button */}
            <div className="group relative">
              <button
                onClick={() => setSettingsOpen(true)}
                className="p-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-400 hover:text-white rounded-lg transition-colors"
              >
                <Settings className="w-4 h-4" />
              </button>
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                Settings
              </div>
            </div>
            {/* Logout button */}
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

        {/* Tabs, Search and Sort - Single Row */}
        <div className="flex items-center gap-3 mb-6">
          {/* Tabs */}
          <div className="flex gap-2">
            <button
              onClick={() => setActiveTab('active')}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'active'
                  ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50'
                  : 'bg-slate-800/50 text-slate-400 border border-slate-700 hover:bg-slate-700/50'
              }`}
            >
              Active {stats.active_count > 0 && `(${stats.active_count})`}
            </button>
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'all'
                  ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50'
                  : 'bg-slate-800/50 text-slate-400 border border-slate-700 hover:bg-slate-700/50'
              }`}
            >
              All ({stats.all_count})
            </button>
          </div>

          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700 rounded-lg py-2 pl-9 pr-3 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
            />
          </div>

          {/* Sort */}
          <div className="flex items-center gap-2">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="bg-slate-800/50 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer"
            >
              <option value="created_at">Date</option>
              <option value="file">Name</option>
              <option value="status">Status</option>
              <option value="progress">Progress</option>
            </select>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
              className="bg-slate-800/50 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer"
            >
              <option value="desc">Desc</option>
              <option value="asc">Asc</option>
            </select>
          </div>
        </div>

        {/* Error State */}
        {error && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-xl p-4 mb-6 text-red-400">
            {error}
          </div>
        )}

        {/* Downloads List - Full Height */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <div className="text-center">
              <Loader2 className="w-12 h-12 mx-auto mb-4 animate-spin text-cyan-500" />
              <p>Loading downloads...</p>
            </div>
          </div>
        ) : downloads.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <div className="text-center">
              <Download className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>{activeTab === 'active' ? 'No active downloads' : 'No downloads yet'}</p>
              <p className="text-sm">
                {activeTab === 'active'
                  ? 'All downloads are complete'
                  : 'Files sent to your Telegram chat will appear here'}
              </p>
            </div>
          </div>
        ) : (
          <div ref={listRef} className="flex-1 min-h-0 overflow-auto space-y-3 pb-12">
            {downloads.map((download) => (
              <DownloadItem
                key={download.id}
                download={download}
                onRetry={handleRetry}
                onStop={handleStop}
                onDelete={handleDelete}
              />
            ))}
            {loadingMore && (
              <div className="flex justify-center py-4">
                <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
              </div>
            )}
          </div>
        )}

      </div>

      {/* Floating Add Button */}
      <div className="group fixed bottom-6 right-6 z-40">
        <button
          onClick={() => setAddUrlOpen(true)}
          className="p-4 bg-gradient-to-br from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white rounded-full shadow-lg shadow-cyan-500/25 transition-all hover:scale-105"
        >
          <Plus className="w-6 h-6" />
        </button>
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
          Add URL download
        </div>
      </div>

      {/* Settings Dialog */}
      <SettingsDialog
        isOpen={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          // Reload secured mapping IDs in case mappings were changed
          loadSecuredMappingIds();
        }}
        showMappings={showSecured}
      />

      {/* Add URL Modal */}
      <AddUrlModal
        isOpen={addUrlOpen}
        onClose={() => {
          setAddUrlOpen(false);
          setPastedUrl(null);
        }}
        initialUrl={pastedUrl}
      />
    </div>
  );
}

export default App;

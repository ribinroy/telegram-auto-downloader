import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Download, Wifi, WifiOff, Loader2, HardDrive, Clock, Zap } from 'lucide-react';
import { formatBytes, formatSpeed } from './utils/format';
import { fetchDownloads, fetchStats, retryDownload, stopDownload, deleteDownload, type SortBy, type SortOrder } from './api';
import { connectSocket, disconnectSocket } from './api/socket';
import { DownloadItem } from './components/DownloadItem';
import type { Download as DownloadType, Stats, DownloadsResponse } from './types';

type TabType = 'active' | 'all';

function App() {
  const [downloads, setDownloads] = useState<DownloadType[]>([]);
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

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('active');
  const [sortBy, setSortBy] = useState<SortBy>('created_at');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  // Handle real-time updates from WebSocket
  const handleUpdate = useCallback((data: DownloadsResponse) => {
    // Filter by search if needed
    const query = search.toLowerCase();
    let filtered = query
      ? data.downloads.filter(d => d.file.toLowerCase().includes(query))
      : data.downloads;

    // Filter by active tab
    if (activeTab === 'active') {
      filtered = filtered.filter(d => d.status !== 'done');
    }

    setDownloads(filtered);
    setStats(data.stats);
    setError(null);
  }, [search, activeTab]);

  // Fetch downloads via REST API
  const loadDownloads = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchDownloads(debouncedSearch, activeTab, sortBy, sortOrder);
      setDownloads(data.downloads);
      setError(null);
    } catch (err) {
      setError('Failed to fetch downloads');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, activeTab, sortBy, sortOrder]);

  // Fetch stats via REST API (separate endpoint, always overall stats)
  const loadStats = useCallback(async () => {
    try {
      const statsData = await fetchStats();
      setStats(statsData);
    } catch (err) {
      console.error('Failed to fetch stats');
    }
  }, []);

  // Load initial data on mount and when search/tab changes
  useEffect(() => {
    loadDownloads();
  }, [loadDownloads]);

  // Load stats on mount
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Setup WebSocket for real-time updates only
  useEffect(() => {
    const socket = connectSocket(handleUpdate);

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => {
      setConnected(false);
    });

    return () => {
      disconnectSocket();
    };
  }, [handleUpdate]);

  const handleRetry = async (id: number) => {
    await retryDownload(id);
  };

  const handleStop = async (message_id: number) => {
    await stopDownload(message_id);
  };

  const handleDelete = async (message_id: number) => {
    await deleteDownload(message_id);
  };

  // Downloads are already filtered by the backend based on activeTab
  const filteredDownloads = downloads;

  const searchRef = useRef<HTMLInputElement>(null);

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-xl">
              <Download className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Telegram Downloader</h1>
              <p className="text-slate-400 text-sm">Monitor your downloads in real-time</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Stats - icon only with tooltips */}
            <div className="group relative flex items-center gap-2 px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default">
              <HardDrive className="w-4 h-4 text-green-400" />
              <span className="text-sm text-green-400">{formatBytes(stats.total_downloaded)}</span>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                Downloaded
              </div>
            </div>
            <div className="group relative flex items-center gap-2 px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default">
              <Clock className="w-4 h-4 text-yellow-400" />
              <span className="text-sm text-yellow-400">{formatBytes(stats.pending_bytes)}</span>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                Pending
              </div>
            </div>
            <div className="group relative flex items-center gap-2 px-3 py-1.5 bg-slate-700/50 rounded-lg cursor-default">
              <Zap className="w-4 h-4 text-purple-400" />
              <span className="text-sm text-purple-400">{formatSpeed(stats.total_speed)}</span>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                Speed
              </div>
            </div>
            {/* Connection status */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
              {connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              <span className="text-sm">{connected ? 'Live' : 'Offline'}</span>
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

        {/* Downloads List - Virtualized */}
        {loading ? (
          <div className="text-center py-12 text-slate-400">
            <Loader2 className="w-12 h-12 mx-auto mb-4 animate-spin text-cyan-500" />
            <p>Loading downloads...</p>
          </div>
        ) : filteredDownloads.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <Download className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>{activeTab === 'active' ? 'No active downloads' : 'No downloads yet'}</p>
            <p className="text-sm">
              {activeTab === 'active'
                ? 'All downloads are complete'
                : 'Files sent to your Telegram chat will appear here'}
            </p>
          </div>
        ) : (
          <div className="max-h-[600px] overflow-auto space-y-3">
            {filteredDownloads.map((download, index) => (
              <DownloadItem
                key={download.id}
                download={download}
                index={index + 1}
                onRetry={handleRetry}
                onStop={handleStop}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

export default App;

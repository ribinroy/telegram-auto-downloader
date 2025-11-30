import { useState, useEffect, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, Download, RefreshCw, Wifi, WifiOff, Loader2, Settings } from 'lucide-react';
import { fetchDownloads, fetchStats, retryDownload, stopDownload, deleteDownload } from './api';
import { connectSocket, disconnectSocket } from './api/socket';
import { StatsHeader } from './components/StatsHeader';
import { DownloadItem } from './components/DownloadItem';
import { SettingsDialog } from './components/SettingsDialog';
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
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('active');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Handle real-time updates from WebSocket
  const handleUpdate = useCallback((data: DownloadsResponse) => {
    // Filter by search if needed
    const query = search.toLowerCase();
    const filtered = query
      ? data.downloads.filter(d => d.file.toLowerCase().includes(query))
      : data.downloads;

    setDownloads(filtered);
    setStats(data.stats);
    setError(null);
  }, [search]);

  // Fetch downloads via REST API
  const loadDownloads = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchDownloads(search, activeTab);
      setDownloads(data.downloads);
      setError(null);
    } catch (err) {
      setError('Failed to fetch downloads');
    } finally {
      setLoading(false);
    }
  }, [search, activeTab]);

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

  const handleStop = async (file: string) => {
    await stopDownload(file);
  };

  const handleDelete = async (file: string) => {
    if (confirm('Are you sure you want to delete this download?')) {
      await deleteDownload(file);
    }
  };

  const handleRefresh = () => {
    loadDownloads();
    loadStats();
  };

  // Downloads are already filtered by the backend based on activeTab
  const filteredDownloads = downloads;

  // Virtual scroll setup
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredDownloads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88, // Estimated row height in pixels
    overscan: 5,
  });

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
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
              {connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
              <span className="text-sm">{connected ? 'Live' : 'Offline'}</span>
            </div>
            <button
              onClick={handleRefresh}
              className="p-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Stats */}
        <StatsHeader stats={stats} />

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setActiveTab('active')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'active'
                ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50'
                : 'bg-slate-800/50 text-slate-400 border border-slate-700 hover:bg-slate-700/50'
            }`}
          >
            Active {stats.active_count > 0 && `(${stats.active_count})`}
          </button>
          <button
            onClick={() => setActiveTab('all')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'all'
                ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50'
                : 'bg-slate-800/50 text-slate-400 border border-slate-700 hover:bg-slate-700/50'
            }`}
          >
            All ({stats.all_count})
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search downloads..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-800/50 border border-slate-700 rounded-xl py-3 pl-12 pr-4 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
          />
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
          <div
            ref={parentRef}
            className="h-[600px] overflow-auto"
          >
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const download = filteredDownloads[virtualRow.index];
                return (
                  <div
                    key={download.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className="pb-3">
                      <DownloadItem
                        download={download}
                        index={virtualRow.index + 1}
                        onRetry={handleRetry}
                        onStop={handleStop}
                        onDelete={handleDelete}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </div>
    </div>
  );
}

export default App;

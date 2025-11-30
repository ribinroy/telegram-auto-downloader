import { useState, useEffect, useCallback } from 'react';
import { Search, Download, RefreshCw } from 'lucide-react';
import { fetchDownloads, retryDownload, stopDownload, deleteDownload } from './api';
import { StatsHeader } from './components/StatsHeader';
import { DownloadItem } from './components/DownloadItem';
import type { Download as DownloadType, Stats } from './types';

function App() {
  const [downloads, setDownloads] = useState<DownloadType[]>([]);
  const [stats, setStats] = useState<Stats>({
    total_downloaded: 0,
    total_size: 0,
    pending_bytes: 0,
    total_speed: 0,
    downloaded_count: 0,
    total_count: 0,
  });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const data = await fetchDownloads(search);
      setDownloads(data.downloads);
      setStats(data.stats);
      setError(null);
    } catch (err) {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 2000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleRetry = async (id: number) => {
    await retryDownload(id);
    loadData();
  };

  const handleStop = async (file: string) => {
    await stopDownload(file);
    loadData();
  };

  const handleDelete = async (file: string) => {
    if (confirm('Are you sure you want to delete this download?')) {
      await deleteDownload(file);
      loadData();
    }
  };

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
          <button
            onClick={loadData}
            className="p-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Stats */}
        <StatsHeader stats={stats} />

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

        {/* Downloads List */}
        <div className="space-y-3">
          {downloads.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Download className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No downloads yet</p>
              <p className="text-sm">Files sent to your Telegram chat will appear here</p>
            </div>
          ) : (
            downloads.map((download) => (
              <DownloadItem
                key={download.id}
                download={download}
                onRetry={handleRetry}
                onStop={handleStop}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default App;

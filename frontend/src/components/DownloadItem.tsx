import {
  Square,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
  StopCircle,
  Calendar,
  ArrowDown,
  Send,
  Youtube,
  Twitter,
  Instagram,
  Facebook
} from 'lucide-react';
import ReactTimeAgo from 'react-time-ago';
import type { Download } from '../types';
import { formatBytes, formatTime, formatSpeed } from '../utils/format';

interface DownloadItemProps {
  download: Download;
  onRetry: (id: number) => void;
  onStop: (message_id: number) => void;
  onDelete: (message_id: number) => void;
}

function getSourceIcon(source: string) {
  const domain = source?.toLowerCase() || 'telegram';

  if (domain === 'telegram') {
    return <Send className="w-5 h-5 text-sky-400" />;
  }
  if (domain.includes('youtube') || domain.includes('youtu.be')) {
    return <Youtube className="w-5 h-5 text-red-500" />;
  }
  if (domain.includes('twitter') || domain.includes('x.com')) {
    return <Twitter className="w-5 h-5 text-sky-400" />;
  }
  if (domain.includes('instagram')) {
    return <Instagram className="w-5 h-5 text-pink-500" />;
  }
  if (domain.includes('facebook') || domain.includes('fb.')) {
    return <Facebook className="w-5 h-5 text-blue-500" />;
  }
  if (domain.includes('tiktok')) {
    return (
      <span className="w-5 h-5 flex items-center justify-center text-xs font-bold text-white bg-gradient-to-r from-cyan-400 to-pink-500 rounded">
        T
      </span>
    );
  }
  if (domain.includes('vimeo')) {
    return (
      <span className="w-5 h-5 flex items-center justify-center text-xs font-bold text-cyan-400">
        V
      </span>
    );
  }

  // Default: show first letter of domain
  const firstLetter = domain.replace(/[^a-z]/g, '').charAt(0).toUpperCase() || 'U';
  return (
    <span className="w-5 h-5 flex items-center justify-center text-xs font-bold text-slate-400 bg-slate-600 rounded">
      {firstLetter}
    </span>
  );
}

function getStatusIcon(status: Download['status']) {
  switch (status) {
    case 'downloading':
      return <ArrowDown className="w-4 h-4 text-cyan-400 animate-bounce" />;
    case 'done':
      return <CheckCircle className="w-4 h-4 text-green-400" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-400" />;
    case 'stopped':
      return <StopCircle className="w-4 h-4 text-yellow-400" />;
  }
}

function getStatusColor(status: Download['status']) {
  switch (status) {
    case 'downloading':
      return 'text-cyan-400';
    case 'done':
      return 'text-green-400';
    case 'failed':
      return 'text-red-400';
    case 'stopped':
      return 'text-yellow-400';
  }
}

export function DownloadItem({ download, onRetry, onStop, onDelete }: DownloadItemProps) {
  const progressPercent = download.progress || 0;

  const handleStop = () => {
    if (confirm('Are you sure you want to stop this download?')) {
      if (download.message_id) onStop(download.message_id);
    }
  };

  return (
    <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/50 hover:border-slate-600 transition-all">
      <div className="flex items-start gap-4">
        {/* Source Icon */}
        <div className="p-2.5 bg-slate-700/50 rounded-lg" title={download.downloaded_from || 'telegram'}>
          {getSourceIcon(download.downloaded_from)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="mb-1">
            <h3 className="text-white font-medium truncate" title={download.file}>
              {download.file}
            </h3>
          </div>

          {download.status === 'downloading' && (
            <div className="mb-2">
              <div className="flex justify-between text-sm text-slate-400 mb-1">
                <span>{formatBytes(download.downloaded_bytes)} / {formatBytes(download.total_bytes)}</span>
                <span>{progressPercent.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-4 text-sm text-slate-400">
            {download.status === 'downloading' && (
              <>
                <span>Speed: {formatSpeed(download.speed)}</span>
                <span>ETA: {formatTime(download.pending_time)}</span>
              </>
            )}
            {download.status === 'done' && (
              <span>Size: {formatBytes(download.total_bytes)}</span>
            )}
            {download.error && (
              <span className="text-red-400 truncate" title={download.error}>
                {download.error}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            {/* Status indicator */}
            <div className={`flex items-center gap-1.5 px-2 py-1 bg-slate-700/30 rounded-lg ${download.status === 'downloading' ? 'aspect-square justify-center' : ''}`}>
              {getStatusIcon(download.status)}
              {download.status !== 'downloading' && (
                <span className={`text-sm capitalize ${getStatusColor(download.status)}`}>
                  {download.status}
                </span>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              {download.status === 'failed' && (
                <button
                  onClick={() => onRetry(download.id)}
                  className="p-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg transition-colors cursor-pointer"
                  title="Retry"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              )}
              {download.status === 'downloading' && (
                <button
                  onClick={handleStop}
                  className="p-2 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg transition-colors cursor-pointer"
                  title="Stop"
                >
                  <Square className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={() => {
                  if (confirm('Are you sure you want to delete this download?')) {
                    if (download.message_id) onDelete(download.message_id);
                  }
                }}
                className="p-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors cursor-pointer"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ID and Date */}
          <div className="flex gap-4 text-xs text-slate-500">
            <div
              className="flex items-center gap-1 cursor-default"
              title="Database ID"
            >
              <span className="text-slate-600">#</span>
              <span>{download.id}</span>
            </div>
            {download.created_at && (
              <div className="flex items-center gap-1 cursor-default">
                <Calendar className="w-3 h-3" />
                <ReactTimeAgo date={new Date(download.created_at)} locale="en-US" timeStyle="twitter" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

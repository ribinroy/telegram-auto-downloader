import {
  Square,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  StopCircle,
  FileText,
  Image,
  Video
} from 'lucide-react';
import type { Download } from '../types';
import { formatBytes, formatTime, formatSpeed } from '../utils/format';

interface DownloadItemProps {
  download: Download;
  onRetry: (id: number) => void;
  onStop: (file: string) => void;
  onDelete: (file: string) => void;
}

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext || '')) {
    return <Image className="w-5 h-5 text-pink-400" />;
  }
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext || '')) {
    return <Video className="w-5 h-5 text-purple-400" />;
  }
  return <FileText className="w-5 h-5 text-blue-400" />;
}

function getStatusIcon(status: Download['status']) {
  switch (status) {
    case 'downloading':
      return <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />;
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

  return (
    <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/50 hover:border-slate-600 transition-all">
      <div className="flex items-start gap-4">
        <div className="p-2 bg-slate-700/50 rounded-lg">
          {getFileIcon(download.file)}
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

        <div className="flex items-center gap-3">
          {/* Status indicator */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-700/30 rounded-lg">
            {getStatusIcon(download.status)}
            <span className={`text-sm capitalize ${getStatusColor(download.status)}`}>
              {download.status}
            </span>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            {(download.status === 'failed' || download.status === 'stopped') && (
              <button
                onClick={() => onRetry(download.id)}
                className="p-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg transition-colors"
                title="Retry"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            )}
            {download.status === 'downloading' && (
              <button
                onClick={() => onStop(download.file)}
                className="p-2 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg transition-colors"
                title="Stop"
              >
                <Square className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => onDelete(download.file)}
              className="p-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

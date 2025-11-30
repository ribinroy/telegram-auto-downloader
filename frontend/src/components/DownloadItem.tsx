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
  Video,
  Calendar,
  Clock
} from 'lucide-react';
import type { Download } from '../types';
import { formatBytes, formatTime, formatSpeed } from '../utils/format';

interface DownloadItemProps {
  download: Download;
  index: number;
  onRetry: (id: number) => void;
  onStop: (file: string) => void;
  onDelete: (file: string) => void;
}

function formatRelativeDate(dateString: string | null): { relative: string; full: string } {
  if (!dateString) return { relative: '-', full: '-' };

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  let relative: string;
  if (diffSecs < 60) {
    relative = 'just now';
  } else if (diffMins < 60) {
    relative = `${diffMins}m ago`;
  } else if (diffHours < 24) {
    relative = `${diffHours}h ago`;
  } else if (diffDays < 7) {
    relative = `${diffDays}d ago`;
  } else if (diffWeeks < 4) {
    relative = `${diffWeeks}w ago`;
  } else if (diffMonths < 12) {
    relative = `${diffMonths}mo ago`;
  } else {
    relative = `${diffYears}y ago`;
  }

  const full = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return { relative, full };
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

export function DownloadItem({ download, index, onRetry, onStop, onDelete }: DownloadItemProps) {
  const progressPercent = download.progress || 0;

  return (
    <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/50 hover:border-slate-600 transition-all">
      <div className="flex items-start gap-4">
        {/* Index + File Icon combined */}
        <div className="relative">
          <div className="p-2.5 bg-slate-700/50 rounded-lg">
            {getFileIcon(download.file)}
          </div>
          <div className="absolute -top-1.5 -left-1.5 flex items-center justify-center w-5 h-5 bg-slate-600 rounded-full text-slate-300 text-xs font-medium border border-slate-500">
            {index}
          </div>
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
            <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-700/30 rounded-lg">
              {getStatusIcon(download.status)}
              <span className={`text-sm capitalize ${getStatusColor(download.status)}`}>
                {download.status}
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              {download.status === 'failed' && (
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

          {/* Dates */}
          <div className="flex gap-4 text-xs text-slate-500">
            <div
              className="flex items-center gap-1 cursor-default"
              title={`Created: ${formatRelativeDate(download.created_at).full}`}
            >
              <Calendar className="w-3 h-3" />
              <span>{formatRelativeDate(download.created_at).relative}</span>
            </div>
            <div
              className="flex items-center gap-1 cursor-default"
              title={`Updated: ${formatRelativeDate(download.updated_at).full}`}
            >
              <Clock className="w-3 h-3" />
              <span>{formatRelativeDate(download.updated_at).relative}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

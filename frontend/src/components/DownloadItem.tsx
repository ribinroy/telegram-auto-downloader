import { useState } from 'react';
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
  Pause,
  Play
} from 'lucide-react';
import ReactTimeAgo from 'react-time-ago';
import type { Download } from '../types';
import { formatBytes, formatTime, formatSpeed } from '../utils/format';
import { ConfirmDialog } from './ConfirmDialog';

interface DownloadItemProps {
  download: Download;
  onRetry: (id: number) => void;
  onStop: (message_id: string) => void;
  onDelete: (message_id: string) => void;
}

// Known platform colors (using short names without TLD)
const platformColors: Record<string, string> = {
  'youtube': '#FF0000',
  'twitter': '#1DA1F2',
  'x': '#000000',
  'instagram': '#E4405F',
  'facebook': '#1877F2',
  'tiktok': '#000000',
  'vimeo': '#1AB7EA',
  'twitch': '#9146FF',
  'reddit': '#FF4500',
  'dailymotion': '#00AAFF',
  'soundcloud': '#FF5500',
  'spotify': '#1DB954',
  'telegram': '#26A5E4',
};

// SVG icons for known platforms
function getPlatformIcon(source: string) {
  const domain = source.toLowerCase();

  // YouTube
  if (domain.includes('youtube') || domain.includes('youtu.be')) {
    return (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#FF0000">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
      </svg>
    );
  }

  // Twitter/X
  if (domain.includes('twitter') || domain === 'x') {
    return (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
      </svg>
    );
  }

  // Instagram
  if (domain.includes('instagram')) {
    return (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#E4405F">
        <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
      </svg>
    );
  }

  // TikTok
  if (domain.includes('tiktok')) {
    return (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
      </svg>
    );
  }

  // Telegram
  if (domain === 'telegram') {
    return <Send className="w-5 h-5 text-[#26A5E4]" />;
  }

  // Reddit
  if (domain.includes('reddit')) {
    return (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#FF4500">
        <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/>
      </svg>
    );
  }

  // Twitch
  if (domain.includes('twitch')) {
    return (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#9146FF">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
      </svg>
    );
  }

  // Facebook
  if (domain.includes('facebook')) {
    return (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#1877F2">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
      </svg>
    );
  }

  // Vimeo
  if (domain.includes('vimeo')) {
    return (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#1AB7EA">
        <path d="M23.977 6.416c-.105 2.338-1.739 5.543-4.894 9.609-3.268 4.247-6.026 6.37-8.29 6.37-1.409 0-2.578-1.294-3.553-3.881L5.322 11.4C4.603 8.816 3.834 7.522 3.01 7.522c-.179 0-.806.378-1.881 1.132L0 7.197a315.065 315.065 0 003.501-3.128C5.08 2.701 6.266 1.984 7.055 1.91c1.867-.18 3.016 1.1 3.447 3.838.465 2.953.789 4.789.971 5.507.539 2.45 1.131 3.674 1.776 3.674.502 0 1.256-.796 2.265-2.385 1.004-1.589 1.54-2.797 1.612-3.628.144-1.371-.395-2.061-1.614-2.061-.574 0-1.167.121-1.777.391 1.186-3.868 3.434-5.757 6.762-5.637 2.473.06 3.628 1.664 3.493 4.797l-.013.01z"/>
      </svg>
    );
  }

  // Unknown - show first letter
  const firstLetter = source.charAt(0).toUpperCase();
  const color = platformColors[domain] || '#6B7280';

  return (
    <div
      className="w-5 h-5 rounded flex items-center justify-center text-white text-xs font-bold"
      style={{ backgroundColor: color }}
    >
      {firstLetter}
    </div>
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
  const [confirmAction, setConfirmAction] = useState<'stop' | 'delete' | null>(null);
  const progressPercent = download.progress || 0;

  const isTelegram = download.downloaded_from === 'telegram';

  const handleStopConfirm = () => {
    if (download.message_id) onStop(download.message_id);
    setConfirmAction(null);
  };

  const handleDeleteConfirm = () => {
    if (download.message_id) onDelete(download.message_id);
    setConfirmAction(null);
  };

  return (
    <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/50 hover:border-slate-600 transition-all">
      <div className="flex items-start gap-4">
        {/* Source Icon */}
        <div className="p-2.5 bg-slate-700/50 rounded-lg">
          {getPlatformIcon(download.downloaded_from || 'telegram')}
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
              {/* For non-telegram: show play button when stopped/failed to resume */}
              {!isTelegram && (download.status === 'failed' || download.status === 'stopped') && (
                <button
                  onClick={() => onRetry(download.id)}
                  className="p-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg transition-colors"
                  title="Resume"
                >
                  <Play className="w-4 h-4" />
                </button>
              )}
              {/* For telegram: show retry button when failed */}
              {isTelegram && download.status === 'failed' && (
                <button
                  onClick={() => onRetry(download.id)}
                  className="p-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg transition-colors"
                  title="Retry"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              )}
              {/* For non-telegram: show pause button when downloading */}
              {!isTelegram && download.status === 'downloading' && (
                <button
                  onClick={() => setConfirmAction('stop')}
                  className="p-2 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg transition-colors"
                  title="Pause"
                >
                  <Pause className="w-4 h-4" />
                </button>
              )}
              {/* For telegram: show stop button when downloading */}
              {isTelegram && download.status === 'downloading' && (
                <button
                  onClick={() => setConfirmAction('stop')}
                  className="p-2 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg transition-colors"
                  title="Stop"
                >
                  <Square className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={() => setConfirmAction('delete')}
                className="p-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
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

      {/* Stop/Pause Confirmation Dialog */}
      <ConfirmDialog
        isOpen={confirmAction === 'stop'}
        title={isTelegram ? 'Stop Download?' : 'Pause Download?'}
        message={isTelegram
          ? 'This will stop the download. You can retry later.'
          : 'This will pause the download. You can resume later.'
        }
        confirmText={isTelegram ? 'Stop' : 'Pause'}
        variant="warning"
        onConfirm={handleStopConfirm}
        onCancel={() => setConfirmAction(null)}
      />

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={confirmAction === 'delete'}
        title="Delete Download?"
        message="This will remove the download from the list. This action cannot be undone."
        confirmText="Delete"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}

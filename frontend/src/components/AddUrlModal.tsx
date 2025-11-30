import { useState } from 'react';
import { X, Link, Loader2, AlertCircle, CheckCircle, Download } from 'lucide-react';
import { checkUrl, downloadUrl } from '../api';
import type { UrlCheckResult } from '../types';
import { formatBytes } from '../utils/format';

interface AddUrlModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddUrlModal({ isOpen, onClose }: AddUrlModalProps) {
  const [url, setUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [checkResult, setCheckResult] = useState<UrlCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCheck = async () => {
    if (!url.trim()) return;

    setChecking(true);
    setError(null);
    setCheckResult(null);

    try {
      const result = await checkUrl(url.trim());
      setCheckResult(result);
      if (!result.supported) {
        setError(result.error || 'URL not supported');
      }
    } catch {
      setError('Failed to check URL');
    } finally {
      setChecking(false);
    }
  };

  const handleDownload = async () => {
    if (!url.trim() || !checkResult?.supported) return;

    setDownloading(true);
    setError(null);

    try {
      const result = await downloadUrl(url.trim());
      if ('error' in result) {
        setError(result.error);
      } else {
        // Success - close modal
        handleClose();
      }
    } catch {
      setError('Failed to start download');
    } finally {
      setDownloading(false);
    }
  };

  const handleClose = () => {
    setUrl('');
    setCheckResult(null);
    setError(null);
    setChecking(false);
    setDownloading(false);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !checking && !downloading) {
      if (checkResult?.supported) {
        handleDownload();
      } else {
        handleCheck();
      }
    }
    if (e.key === 'Escape') {
      handleClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl w-full max-w-lg border border-slate-700 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Link className="w-5 h-5 text-cyan-400" />
            <h2 className="text-lg font-semibold text-white">Add URL Download</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-slate-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* URL Input */}
          <div>
            <label className="block text-sm text-slate-400 mb-2">
              Video URL (YouTube, Twitter, etc.)
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setCheckResult(null);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="https://youtube.com/watch?v=..."
              className="w-full bg-slate-900 border border-slate-600 rounded-lg py-2.5 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
              autoFocus
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Video Info */}
          {checkResult?.supported && (
            <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-5 h-5 text-green-400" />
                <span className="text-sm text-green-400 font-medium">URL supported</span>
              </div>
              <div className="space-y-1 text-sm">
                <p className="text-white font-medium truncate" title={checkResult.title}>
                  {checkResult.title}
                </p>
                {checkResult.uploader && (
                  <p className="text-slate-400">By: {checkResult.uploader}</p>
                )}
                <div className="flex gap-4 text-slate-400">
                  {checkResult.filesize && (
                    <span>Size: {formatBytes(checkResult.filesize)}</span>
                  )}
                  {checkResult.duration && (
                    <span>Duration: {Math.floor(checkResult.duration / 60)}:{String(Math.floor(checkResult.duration % 60)).padStart(2, '0')}</span>
                  )}
                  {checkResult.ext && (
                    <span>Format: {checkResult.ext.toUpperCase()}</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-slate-700">
          <button
            onClick={handleClose}
            className="flex-1 py-2.5 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
          >
            Cancel
          </button>
          {checkResult?.supported ? (
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex-1 py-2.5 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {downloading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Download
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleCheck}
              disabled={!url.trim() || checking}
              className="flex-1 py-2.5 px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {checking ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Checking...
                </>
              ) : (
                'Check URL'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

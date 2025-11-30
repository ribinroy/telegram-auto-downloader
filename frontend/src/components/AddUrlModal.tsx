import { useState, useEffect, useRef } from 'react';
import { X, Link, Loader2, AlertCircle, CheckCircle, Download } from 'lucide-react';
import { checkUrl, downloadUrl } from '../api';
import type { UrlCheckResult, VideoFormat } from '../types';
import { formatBytes } from '../utils/format';

interface AddUrlModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialUrl?: string | null;
}

export function AddUrlModal({ isOpen, onClose, initialUrl }: AddUrlModalProps) {
  const [url, setUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [checkResult, setCheckResult] = useState<UrlCheckResult | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasAutoChecked = useRef(false);

  const doCheck = async (urlToCheck: string) => {
    if (!urlToCheck.trim()) return;

    setChecking(true);
    setError(null);
    setCheckResult(null);
    setSelectedFormat(null);

    try {
      const result = await checkUrl(urlToCheck.trim());
      setCheckResult(result);
      if (!result.supported) {
        setError(result.error || 'URL not supported');
      } else if (result.formats && result.formats.length > 0) {
        // Select the best format by default (first one, sorted by height desc)
        setSelectedFormat(result.formats[0]);
      }
    } catch {
      setError('Failed to check URL');
    } finally {
      setChecking(false);
    }
  };

  // Normalize URL by adding https:// if missing
  const normalizeUrl = (input: string): string | null => {
    let urlStr = input.trim();

    // If no protocol, add https://
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      urlStr = 'https://' + urlStr;
    }

    // Validate the URL
    try {
      const urlObj = new URL(urlStr);
      if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
        return urlStr;
      }
    } catch {
      // Invalid URL
    }
    return null;
  };

  // Auto-fill and check when initialUrl is provided
  useEffect(() => {
    if (isOpen && initialUrl && !hasAutoChecked.current) {
      hasAutoChecked.current = true;

      const normalized = normalizeUrl(initialUrl);
      if (normalized) {
        setUrl(normalized);
        doCheck(normalized);
      } else {
        setUrl(initialUrl);
        setError('Not a valid URL');
      }
    }
    if (!isOpen) {
      hasAutoChecked.current = false;
    }
  }, [isOpen, initialUrl]);

  const handleDownload = async () => {
    if (!url.trim() || !checkResult?.supported) return;

    // Close modal immediately
    handleClose();

    // Start download in background
    try {
      await downloadUrl({
        url: url.trim(),
        format_id: selectedFormat?.format_id,
        title: checkResult.title,
        ext: selectedFormat?.ext || checkResult.ext,
        filesize: selectedFormat?.filesize || checkResult.filesize,
      });
    } catch {
      // Error will be shown in the download list
    }
  };

  const handleClose = () => {
    setUrl('');
    setCheckResult(null);
    setSelectedFormat(null);
    setError(null);
    setChecking(false);
    setDownloading(false);
    onClose();
  };

  const handleCheckClick = () => {
    const normalized = normalizeUrl(url);
    if (normalized) {
      setUrl(normalized);
      doCheck(normalized);
    } else {
      setError('Not a valid URL');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !checking && !downloading) {
      if (checkResult?.supported) {
        handleDownload();
      } else {
        handleCheckClick();
      }
    }
    if (e.key === 'Escape') {
      handleClose();
    }
  };

  if (!isOpen) return null;

  const formats = checkResult?.formats || [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl w-full max-w-lg border border-slate-700 shadow-xl max-h-[90vh] flex flex-col">
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
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
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
                setSelectedFormat(null);
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
            <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg space-y-3">
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
                  {checkResult.duration && (
                    <span>Duration: {Math.floor(checkResult.duration / 60)}:{String(Math.floor(checkResult.duration % 60)).padStart(2, '0')}</span>
                  )}
                </div>
              </div>

              {/* Format Selection */}
              {formats.length > 0 && (
                <div className="pt-2 border-t border-green-500/20">
                  <p className="text-sm text-slate-400 mb-2">Quality:</p>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {formats.map((format) => (
                      <label
                        key={format.format_id}
                        className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                          selectedFormat?.format_id === format.format_id
                            ? 'bg-cyan-500/20 border border-cyan-500/50'
                            : 'bg-slate-700/30 border border-transparent hover:bg-slate-700/50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="format"
                          value={format.format_id}
                          checked={selectedFormat?.format_id === format.format_id}
                          onChange={() => setSelectedFormat(format)}
                          className="w-4 h-4 text-cyan-500 bg-slate-700 border-slate-600 focus:ring-cyan-500 focus:ring-offset-0"
                        />
                        <span className="flex-1 text-sm text-white">{format.label}</span>
                        {format.filesize && (
                          <span className="text-xs text-slate-400">{formatBytes(format.filesize)}</span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}
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
                  Download {selectedFormat?.resolution && selectedFormat.resolution !== 'best' ? `(${selectedFormat.resolution})` : ''}
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleCheckClick}
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

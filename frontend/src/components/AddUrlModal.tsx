import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Link, Loader2, AlertCircle, CheckCircle, Download, Folder, Magnet, Send } from 'lucide-react';
import { checkUrl, downloadUrl, fetchMappings, addTorrent, fetchTorrentConfig, fetchVpsFolders, type VpsWatchFolder } from '../api';
import type { UrlCheckResult, VideoFormat, SourceMapping } from '../types';
import { formatBytes } from '../utils/format';

const isMagnetLink = (s: string) => s.trim().toLowerCase().startsWith('magnet:');

// Display name from the magnet's dn= param, if present
function magnetName(magnet: string): string | null {
  const m = magnet.match(/[?&]dn=([^&]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
}

// Extract domain/source from URL (e.g., youtube.com -> youtube)
function getSourceFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    let domain = urlObj.hostname;
    if (domain.startsWith('www.')) {
      domain = domain.slice(4);
    }
    const parts = domain.split('.');
    if (parts.length >= 2) {
      if (parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com' || parts[parts.length - 2] === 'org' || parts[parts.length - 2] === 'net') {
        if (parts.length >= 3) {
          return parts[parts.length - 3];
        }
      }
      return parts[parts.length - 2];
    }
    return domain;
  } catch {
    return '';
  }
}

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
  const [customFilename, setCustomFilename] = useState('');
  const [sourceMapping, setSourceMapping] = useState<SourceMapping | null>(null);
  // Magnet -> VPS torrent client (Transmission) state
  const [magnetMode, setMagnetMode] = useState(false);
  const [torrentConfigured, setTorrentConfigured] = useState(false);
  const [vpsFolders, setVpsFolders] = useState<VpsWatchFolder[]>([]);
  const [torrentDest, setTorrentDest] = useState('');
  const [sendingMagnet, setSendingMagnet] = useState(false);
  const [magnetResult, setMagnetResult] = useState<{ status?: 'added' | 'duplicate'; name?: string } | null>(null);
  const hasAutoChecked = useRef(false);
  const filenameInputRef = useRef<HTMLInputElement>(null);

  const enterMagnetMode = async (magnet: string) => {
    setUrl(magnet);
    setMagnetMode(true);
    setError(null);
    setCheckResult(null);
    setSelectedFormat(null);
    setMagnetResult(null);
    try {
      const [cfg, folders] = await Promise.all([fetchTorrentConfig(), fetchVpsFolders()]);
      setTorrentConfigured(cfg.configured);
      setVpsFolders(folders.filter(f => f.active));
      if (!cfg.configured) {
        setError('Torrent client is not configured — add it under Settings → VPS Connection');
      }
    } catch {
      setTorrentConfigured(false);
      setError('Failed to load torrent client settings');
    }
  };

  const handleSendMagnet = async () => {
    if (!isMagnetLink(url) || !torrentConfigured || sendingMagnet) return;
    setSendingMagnet(true);
    setError(null);
    try {
      const res = await addTorrent(url.trim(), torrentDest || null);
      if (res.error) setError(res.error);
      else setMagnetResult(res);
    } catch {
      setError('Failed to send the magnet link');
    } finally {
      setSendingMagnet(false);
    }
  };

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
      }

      // Resolve the source's spec (for folder display + default quality)
      const source = getSourceFromUrl(urlToCheck);
      let mapping: SourceMapping | undefined;
      try {
        const mappings = await fetchMappings();
        mapping = mappings.find(m => m.downloaded_from === source);
        setSourceMapping(mapping ?? null);
      } catch {
        // Ignore mapping fetch errors
      }

      if (result.formats && result.formats.length > 0) {
        let defaultFormat: VideoFormat | null = null;
        if (mapping?.quality) {
          const targetQuality = mapping.quality.toLowerCase().replace('p', '');
          defaultFormat = result.formats.find(f =>
            f.resolution?.toLowerCase().replace('p', '') === targetQuality
          ) || null;
        }
        setSelectedFormat(defaultFormat || result.formats[0]);
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

      if (isMagnetLink(initialUrl)) {
        enterMagnetMode(initialUrl.trim());
        return;
      }
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

  // Focus filename input when URL is supported
  useEffect(() => {
    if (checkResult?.supported && filenameInputRef.current) {
      filenameInputRef.current.focus();
    }
  }, [checkResult?.supported]);

  const handleDownload = async () => {
    if (!url.trim() || !checkResult?.supported) return;

    // Close modal immediately
    handleClose();

    // Start download in background
    try {
      await downloadUrl({
        url: url.trim(),
        format_id: selectedFormat?.format_id,
        title: customFilename.trim() || checkResult.title,
        ext: selectedFormat?.ext || checkResult.ext,
        filesize: selectedFormat?.filesize || checkResult.filesize,
        resolution: selectedFormat?.resolution,
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
    setCustomFilename('');
    setDownloading(false);
    setSourceMapping(null);
    setMagnetMode(false);
    setTorrentDest('');
    setSendingMagnet(false);
    setMagnetResult(null);
    onClose();
  };

  const handleCheckClick = () => {
    if (isMagnetLink(url)) {
      enterMagnetMode(url.trim());
      return;
    }
    const normalized = normalizeUrl(url);
    if (normalized) {
      setUrl(normalized);
      doCheck(normalized);
    } else {
      setError('Not a valid URL');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !checking && !downloading && !sendingMagnet) {
      if (magnetMode && !magnetResult) {
        handleSendMagnet();
      } else if (checkResult?.supported) {
        handleDownload();
      } else if (!magnetMode) {
        handleCheckClick();
      }
    }
    if (e.key === 'Escape') {
      handleClose();
    }
  };

  if (!isOpen) return null;

  const formats = checkResult?.formats || [];

  return createPortal(
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-3 sm:p-4">
      <div className="bg-slate-800 rounded-xl w-full max-w-lg border border-slate-700 shadow-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-3 sm:p-4 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Link className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base sm:text-lg font-semibold text-white">Add URL Download</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-slate-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-3 sm:p-4 space-y-3 sm:space-y-4 overflow-y-auto flex-1">
          {/* URL Input */}
          <div>
            <label className="block text-xs sm:text-sm text-slate-400 mb-1.5 sm:mb-2">
              Video URL (YouTube, Twitter, etc.) or magnet link
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setCheckResult(null);
                setSelectedFormat(null);
                setError(null);
                setMagnetMode(false);
                setMagnetResult(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="https://youtube.com/watch?v=..."
              className="w-full bg-slate-900 border border-slate-600 rounded-lg py-2 sm:py-2.5 px-3 text-sm sm:text-base text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
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

          {/* Magnet link -> VPS torrent client */}
          {magnetMode && (
            <div className="p-2.5 sm:p-3 bg-purple-500/10 border border-purple-500/30 rounded-lg space-y-2 sm:space-y-3">
              <div className="flex items-center gap-2">
                <Magnet className="w-4 h-4 sm:w-5 sm:h-5 text-purple-400" />
                <span className="text-xs sm:text-sm text-purple-300 font-medium">
                  Magnet link — sends to the VPS torrent client
                </span>
              </div>
              {magnetName(url) && (
                <p className="text-xs sm:text-sm text-white font-medium break-all">{magnetName(url)}</p>
              )}
              {magnetResult ? (
                <div className="flex items-center gap-2 p-2 bg-green-500/10 border border-green-500/30 rounded-lg">
                  <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                  <span className="text-xs sm:text-sm text-green-400">
                    {magnetResult.status === 'duplicate' ? 'Already in the torrent client' : 'Sent to the torrent client'}
                    {magnetResult.name ? `: ${magnetResult.name}` : ''}
                  </span>
                </div>
              ) : (
                <div>
                  <p className="text-xs sm:text-sm text-slate-400 mb-1.5">Download to (on the VPS):</p>
                  <select
                    value={torrentDest}
                    onChange={(e) => setTorrentDest(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg py-1.5 px-2.5 text-xs sm:text-sm text-white focus:outline-none focus:border-purple-500 transition-colors"
                  >
                    <option value="">Client default folder</option>
                    {vpsFolders.map(f => (
                      <option key={f.id} value={f.path}>{f.path}{f.auto_sync ? ' (autoSync)' : ''}</option>
                    ))}
                  </select>
                  {torrentDest && vpsFolders.find(f => f.path === torrentDest)?.auto_sync && (
                    <p className="text-[11px] text-slate-500 mt-1">
                      autoSync will pull finished files to the home server on its hourly check.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Video Info */}
          {checkResult?.supported && (
            <div className="p-2.5 sm:p-3 bg-green-500/10 border border-green-500/30 rounded-lg space-y-2 sm:space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5 text-green-400" />
                <span className="text-xs sm:text-sm text-green-400 font-medium">URL supported</span>
              </div>
              <div className="space-y-1 text-xs sm:text-sm">
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
                  <p className="text-xs sm:text-sm text-slate-400 mb-2">Quality:</p>
                  <div className="space-y-1.5 max-h-32 sm:max-h-40 overflow-y-auto">
                    {formats.map((format) => (
                      <label
                        key={format.format_id}
                        className={`flex items-center gap-2 sm:gap-3 p-1.5 sm:p-2 rounded-lg cursor-pointer transition-colors ${
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
                        <span className="flex-1 text-xs sm:text-sm text-white">{format.label}</span>
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

        {/* Custom Filename Input */}
        {checkResult?.supported && (
          <div className="px-3 sm:px-4 pb-3 sm:pb-4">
            <label className="block text-xs sm:text-sm text-slate-400 mb-1.5 sm:mb-2">
              Filename
            </label>
            <input
              ref={filenameInputRef}
              type="text"
              value={customFilename}
              onChange={(e) => setCustomFilename(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={checkResult?.title || 'Enter custom filename...'}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg py-2 sm:py-2.5 px-3 text-sm sm:text-base text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
            />
            {/* Destination folder from the source's spec (configured in Settings -> Sources) */}
            {sourceMapping?.folder && (
              <div className="flex items-center gap-1 mt-1.5 text-xs text-slate-500 min-w-0">
                <Folder className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{sourceMapping.folder}</span>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex gap-2 sm:gap-3 p-3 sm:p-4 border-t border-slate-700">
          <button
            onClick={handleClose}
            className="flex-1 py-2 sm:py-2.5 px-3 sm:px-4 bg-slate-700 hover:bg-slate-600 text-white text-sm sm:text-base rounded-lg transition-colors"
          >
            Cancel
          </button>
          {magnetMode ? (
            magnetResult ? (
              <button
                onClick={handleClose}
                className="flex-1 py-2 sm:py-2.5 px-3 sm:px-4 bg-green-600 hover:bg-green-500 text-white text-sm sm:text-base rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <CheckCircle className="w-4 h-4" />
                Done
              </button>
            ) : (
              <button
                onClick={handleSendMagnet}
                disabled={sendingMagnet || !torrentConfigured}
                className="flex-1 py-2 sm:py-2.5 px-3 sm:px-4 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-900 disabled:cursor-not-allowed text-white text-sm sm:text-base rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {sendingMagnet ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="hidden sm:inline">Sending...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    <span>Send to torrent client</span>
                  </>
                )}
              </button>
            )
          ) : checkResult?.supported ? (
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex-1 py-2 sm:py-2.5 px-3 sm:px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white text-sm sm:text-base rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {downloading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="hidden sm:inline">Starting...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Download</span>
                  {selectedFormat?.resolution && selectedFormat.resolution !== 'best' && (
                    <span className="hidden sm:inline">({selectedFormat.resolution})</span>
                  )}
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleCheckClick}
              disabled={!url.trim() || checking}
              className="flex-1 py-2 sm:py-2.5 px-3 sm:px-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white text-sm sm:text-base rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {checking ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="hidden sm:inline">Checking...</span>
                </>
              ) : (
                'Check URL'
              )}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

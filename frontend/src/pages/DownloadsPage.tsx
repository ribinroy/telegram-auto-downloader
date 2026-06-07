import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Download, Loader2, Plus, X, HardDrive } from 'lucide-react';
import { useLayoutContext } from '../components/Layout';
import { ROUTES } from '../routes';
import { DownloadItem } from '../components/DownloadItem';
import { AddUrlModal } from '../components/AddUrlModal';
import type { SortBy, SortOrder } from '../api';

export function DownloadsPage() {
  const {
    downloads, totalResults, loading, loadingMore, error,
    search, setSearch, debouncedSearch,
    sortBy, setSortBy, sortOrder, setSortOrder,
    authors, selectedAuthor, setSelectedAuthor,
    loadMore, onRetry, onStop, onPause, onResume, onDelete,
    addUrlOpen, setAddUrlOpen, pastedUrl, setPastedUrl,
    vpsReady,
  } = useLayoutContext();

  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Scroll to load more
  useEffect(() => {
    const handleScroll = () => {
      const scrollTop = window.scrollY;
      const scrollHeight = document.documentElement.scrollHeight;
      const clientHeight = window.innerHeight;
      if (scrollHeight - scrollTop - clientHeight < 300) {
        loadMore();
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [loadMore]);

  // Paste to open URL modal
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (addUrlOpen) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      const text = e.clipboardData?.getData('text')?.trim();
      if (!text) return;
      e.preventDefault();
      setPastedUrl(text);
      setAddUrlOpen(true);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [addUrlOpen, setPastedUrl, setAddUrlOpen]);

  return (
    <>
      <div className="max-w-7xl mx-auto px-3 sm:px-4 pt-2 sm:pt-4 pb-24 w-full">
        {/* Search and Sort */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4 sm:mb-6">
          {/* Sort and Author filter - mobile */}
          <div className="flex items-center justify-end gap-1.5 sm:gap-2 sm:hidden">
            {authors.length > 1 && (
              <select
                value={selectedAuthor}
                onChange={(e) => setSelectedAuthor(e.target.value)}
                className="bg-slate-800/50 border border-slate-700 rounded-lg py-1.5 px-2 text-xs text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer"
              >
                <option value="">All authors</option>
                {authors.map(a => {
                  const colonIdx = a.lastIndexOf(':');
                  const label = colonIdx > 0 && colonIdx < a.length - 1 ? a.substring(0, colonIdx) : a;
                  return <option key={a} value={a}>{label}</option>;
                })}
              </select>
            )}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="bg-slate-800/50 border border-slate-700 rounded-lg py-1.5 px-2 text-xs text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer"
            >
              <option value="created_at">Date</option>
              <option value="file">Name</option>
              <option value="status">Status</option>
              <option value="progress">Progress</option>
            </select>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
              className="bg-slate-800/50 border border-slate-700 rounded-lg py-1.5 px-2 text-xs text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer"
            >
              <option value="desc">Desc</option>
              <option value="asc">Asc</option>
            </select>
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
              className="w-full bg-slate-800/50 border border-slate-700 rounded-lg py-2 pl-9 pr-16 sm:pr-20 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
              {debouncedSearch && (
                <>
                  <span className="hidden sm:inline text-xs text-slate-500">
                    {totalResults} result{totalResults !== 1 ? 's' : ''}
                  </span>
                  <button
                    onClick={() => setSearch('')}
                    className="p-0.5 hover:bg-slate-700/50 rounded transition-colors"
                  >
                    <X className="w-4 h-4 text-slate-400 hover:text-white" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Author filter, Sort - desktop */}
          <div className="hidden sm:flex items-center gap-2">
            {authors.length > 1 && (
              <select
                value={selectedAuthor}
                onChange={(e) => setSelectedAuthor(e.target.value)}
                className="bg-slate-800/50 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors cursor-pointer"
              >
                <option value="">All authors</option>
                {authors.map(a => {
                  const colonIdx = a.lastIndexOf(':');
                  const label = colonIdx > 0 && colonIdx < a.length - 1 ? a.substring(0, colonIdx) : a;
                  return <option key={a} value={a}>{label}</option>;
                })}
              </select>
            )}
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

        {/* Error */}
        {error && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-xl p-4 mb-6 text-red-400">
            {error}
          </div>
        )}

        {/* Downloads List */}
        {loading ? (
          <div className="min-h-[50vh] flex items-center justify-center text-slate-400">
            <div className="text-center">
              <Loader2 className="w-12 h-12 mx-auto mb-4 animate-spin text-cyan-500" />
              <p>Loading downloads...</p>
            </div>
          </div>
        ) : downloads.length === 0 ? (
          <div className="min-h-[50vh] flex items-center justify-center text-slate-400">
            <div className="text-center">
              <Download className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No downloads yet</p>
              <p className="text-sm">Files sent to your Telegram chat will appear here</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {downloads.map((download) => (
              <DownloadItem
                key={download.id}
                download={download}
                onRetry={onRetry}
                onStop={onStop}
                onPause={onPause}
                onResume={onResume}
                onDelete={onDelete}
              />
            ))}
            {loadingMore && (
              <div className="flex justify-center py-4">
                <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating VPS Button - only when VPS is configured with watched folders */}
      {vpsReady && (
        <div className="group fixed bottom-20 right-4 sm:bottom-24 sm:right-6 z-40">
          <button
            onClick={() => navigate(ROUTES.VPS)}
            className="p-3 sm:p-4 bg-gradient-to-br from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 text-white rounded-full shadow-lg shadow-purple-500/25 transition-all hover:scale-105"
          >
            <HardDrive className="w-5 h-5 sm:w-6 sm:h-6" />
          </button>
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
            VPS files
          </div>
        </div>
      )}

      {/* Floating Add Button */}
      <div className="group fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-40">
        <button
          onClick={() => setAddUrlOpen(true)}
          className="p-3 sm:p-4 bg-gradient-to-br from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white rounded-full shadow-lg shadow-cyan-500/25 transition-all hover:scale-105"
        >
          <Plus className="w-5 h-5 sm:w-6 sm:h-6" />
        </button>
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
          Add URL download
        </div>
      </div>

      {/* Add URL Modal */}
      <AddUrlModal
        isOpen={addUrlOpen}
        onClose={() => { setAddUrlOpen(false); setPastedUrl(null); }}
        initialUrl={pastedUrl}
      />
    </>
  );
}

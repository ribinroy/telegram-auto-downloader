import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, Loader2, FileQuestion } from 'lucide-react';
import { getFileStreamUrl, getFileDownloadUrl, type FileEntry } from '../../api/files';
import { useFileText } from '../../hooks/useFiles';
import { formatBytes } from '../../utils/format';

/** Preview for one file, with arrow-key paging through the folder's siblings. */
export function FilePreviewModal({
  entry, siblings, onClose, onNavigate,
}: {
  entry: FileEntry;
  siblings: FileEntry[];
  onClose: () => void;
  onNavigate: (entry: FileEntry) => void;
}) {
  const index = siblings.findIndex(e => e.path === entry.path);
  const prev = index > 0 ? siblings[index - 1] : null;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev);
      if (e.key === 'ArrowRight' && next) onNavigate(next);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose, onNavigate, prev, next]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 w-full max-w-6xl mx-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="text-white font-medium truncate" title={entry.path}>{entry.name}</h3>
            <p className="text-xs text-slate-400 truncate">{formatBytes(entry.size)} · {entry.path}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={getFileDownloadUrl(entry.path)}
              className="p-2 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition-colors"
              title="Download to this device"
            >
              <Download className="w-5 h-5" />
            </a>
            <button
              onClick={onClose}
              className="p-2 bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="relative bg-black rounded-xl overflow-hidden shadow-2xl min-h-[240px] flex items-center justify-center">
          <PreviewBody entry={entry} />

          {prev && (
            <button
              onClick={() => onNavigate(prev)}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-black/60 hover:bg-black/80 text-white rounded-full transition-colors"
              title={prev.name}
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}
          {next && (
            <button
              onClick={() => onNavigate(next)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-black/60 hover:bg-black/80 text-white rounded-full transition-colors"
              title={next.name}
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PreviewBody({ entry }: { entry: FileEntry }) {
  const url = getFileStreamUrl(entry.path);

  if (entry.kind === 'video') {
    return (
      <video key={url} src={url} controls autoPlay playsInline className="w-full max-h-[78vh]" />
    );
  }
  if (entry.kind === 'image') {
    return <img key={url} src={url} alt={entry.name} className="max-h-[78vh] w-auto object-contain" />;
  }
  if (entry.kind === 'audio') {
    return (
      <div className="w-full p-10">
        <audio key={url} src={url} controls autoPlay className="w-full" />
      </div>
    );
  }
  if (entry.ext === 'pdf') {
    return <iframe key={url} src={url} title={entry.name} className="w-full h-[78vh] bg-white" />;
  }
  if (entry.kind === 'text') return <TextPreview path={entry.path} />;

  return (
    <div className="p-12 text-center text-slate-400">
      <FileQuestion className="w-10 h-10 mx-auto mb-3 opacity-60" />
      <p className="text-sm">No preview for .{entry.ext || 'this file type'}</p>
      <a href={getFileDownloadUrl(entry.path)} className="text-sm text-cyan-400 hover:text-cyan-300 mt-1 inline-block">
        Download it instead
      </a>
    </div>
  );
}

function TextPreview({ path }: { path: string }) {
  const { data, isLoading, error } = useFileText(path);
  if (isLoading) {
    return <div className="p-12 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }
  if (error) {
    return <div className="p-12 text-red-400 text-sm">{(error as Error).message}</div>;
  }
  return (
    <div className="w-full max-h-[78vh] overflow-auto bg-slate-950">
      <pre className="p-4 text-xs text-slate-200 whitespace-pre-wrap break-words font-mono">
        {data?.text}
      </pre>
      {data?.truncated && (
        <p className="px-4 pb-3 text-xs text-amber-400">
          Preview truncated - showing the first {formatBytes(data.text.length)} of {formatBytes(data.size)}.
        </p>
      )}
    </div>
  );
}

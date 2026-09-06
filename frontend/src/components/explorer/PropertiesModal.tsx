import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Ruler } from 'lucide-react';
import { formatBytes } from '../../utils/format';
import { useDirSize } from '../../hooks/useFiles';
import type { FileEntry } from '../../api/files';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5 border-b border-slate-800 last:border-0">
      <span className="w-28 shrink-0 text-xs text-slate-500">{label}</span>
      <span className="text-sm text-slate-200 break-all">{value}</span>
    </div>
  );
}

export function PropertiesModal({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  // Folder sizes cost a full recursive walk, so they are opt-in per folder
  // rather than something the listing pays for on every row.
  const [measure, setMeasure] = useState(false);
  const size = useDirSize(measure ? entry.path : null);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h3 className="text-white font-medium truncate" title={entry.name}>{entry.name}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-0">
          <Row label="Path" value={entry.path} />
          <Row label="Type" value={entry.is_dir ? 'Folder' : `${entry.kind}${entry.ext ? ` (.${entry.ext})` : ''}`} />
          <Row
            label="Size"
            value={
              entry.is_dir ? (
                size.data ? (
                  <>
                    {formatBytes(size.data.size)}
                    <span className="text-slate-500 text-xs">
                      {' '}· {size.data.files} files, {size.data.dirs} folders
                      {size.data.partial && ' (partial - took too long)'}
                    </span>
                  </>
                ) : (
                  <button
                    onClick={() => setMeasure(true)}
                    disabled={size.isFetching}
                    className="flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300 text-sm transition-colors"
                  >
                    {size.isFetching
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Ruler className="w-3.5 h-3.5" />}
                    Calculate
                  </button>
                )
              ) : formatBytes(entry.size)
            }
          />
          <Row label="Modified" value={entry.modified ? new Date(entry.modified).toLocaleString() : '--'} />
          <Row label="Permissions" value={entry.mode ?? '--'} />
          {entry.is_link && <Row label="Symlink" value={entry.broken ? 'Yes (broken target)' : 'Yes'} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

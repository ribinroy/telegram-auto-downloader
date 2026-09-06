import { useEffect, useRef, type MouseEvent } from 'react';
import {
  Folder, Film, Image as ImageIcon, Music, FileArchive, FileText, FileType, File as FileIcon,
  Link2, ArrowUp, ArrowDown, MoreVertical,
} from 'lucide-react';
import ReactTimeAgo from 'react-time-ago';
import { formatBytes } from '../../utils/format';
import { getFileThumbUrl, type FileEntry, type FileKind } from '../../api/files';

export type SortKey = 'name' | 'size' | 'modified' | 'kind';
export type ViewMode = 'list' | 'grid';

const KIND_ICON: Record<FileKind, typeof FileIcon> = {
  folder: Folder, video: Film, image: ImageIcon, audio: Music,
  archive: FileArchive, document: FileType, text: FileText, file: FileIcon,
};

const KIND_COLOR: Record<FileKind, string> = {
  folder: 'text-cyan-400', video: 'text-purple-400', image: 'text-emerald-400',
  audio: 'text-pink-400', archive: 'text-amber-400', document: 'text-orange-400',
  text: 'text-slate-300', file: 'text-slate-400',
};

function EntryIcon({ entry, className = 'w-5 h-5' }: { entry: FileEntry; className?: string }) {
  const Icon = KIND_ICON[entry.kind] ?? FileIcon;
  return <Icon className={`${className} ${entry.broken ? 'text-red-400' : KIND_COLOR[entry.kind]}`} />;
}

/** Inline name editor - the rename affordance a real file manager has (F2). */
function NameEditor({
  initial, onSubmit, onCancel,
}: { initial: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Preselect the stem only, so ".mkv" survives a careless overtype.
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  return (
    <input
      ref={ref}
      defaultValue={initial}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onBlur={e => onSubmit(e.currentTarget.value)}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Enter') onSubmit(e.currentTarget.value);
        if (e.key === 'Escape') onCancel();
      }}
      className="w-full bg-slate-900 border border-cyan-500 rounded px-2 py-1 text-sm text-white focus:outline-none"
    />
  );
}

interface FileListProps {
  entries: FileEntry[];
  selected: Set<string>;
  view: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  renaming: string | null;
  showPath?: boolean;
  onSort: (key: SortKey) => void;
  onSelect: (entry: FileEntry, e: MouseEvent) => void;
  onOpen: (entry: FileEntry) => void;
  onContext: (entry: FileEntry, x: number, y: number) => void;
  onRename: (entry: FileEntry, name: string) => void;
  onRenameCancel: () => void;
}

export function FileList(props: FileListProps) {
  return props.view === 'grid' ? <GridView {...props} /> : <ListView {...props} />;
}

function SortHeader({
  label, column, sortKey, sortAsc, onSort, className = '',
}: {
  label: string; column: SortKey; sortKey: SortKey; sortAsc: boolean;
  onSort: (k: SortKey) => void; className?: string;
}) {
  const active = sortKey === column;
  return (
    <button
      onClick={() => onSort(column)}
      className={`flex items-center gap-1 text-xs font-medium transition-colors ${
        active ? 'text-white' : 'text-slate-500 hover:text-slate-300'
      } ${className}`}
    >
      {label}
      {active && (sortAsc ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
    </button>
  );
}

function ListView({
  entries, selected, sortKey, sortAsc, renaming, showPath,
  onSort, onSelect, onOpen, onContext, onRename, onRenameCancel,
}: FileListProps) {
  return (
    <div className="rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 bg-slate-800/60 border-b border-slate-700/50">
        <SortHeader label="Name" column="name" sortKey={sortKey} sortAsc={sortAsc} onSort={onSort} className="flex-1" />
        <SortHeader label="Size" column="size" sortKey={sortKey} sortAsc={sortAsc} onSort={onSort} className="w-24 justify-end hidden sm:flex" />
        <SortHeader label="Modified" column="modified" sortKey={sortKey} sortAsc={sortAsc} onSort={onSort} className="w-32 justify-end hidden md:flex" />
        <span className="w-8" />
      </div>

      <div className="divide-y divide-slate-800">
        {entries.map(entry => {
          const isSelected = selected.has(entry.path);
          return (
            <div
              key={entry.path}
              onClick={e => onSelect(entry, e)}
              onDoubleClick={() => onOpen(entry)}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContext(entry, e.clientX, e.clientY); }}
              className={`flex items-center gap-3 px-3 py-2 cursor-default select-none transition-colors ${
                isSelected ? 'bg-cyan-500/15' : 'hover:bg-slate-800/50'
              }`}
            >
              <EntryIcon entry={entry} />
              <div className="flex-1 min-w-0">
                {renaming === entry.path ? (
                  <NameEditor
                    initial={entry.name}
                    onSubmit={name => onRename(entry, name)}
                    onCancel={onRenameCancel}
                  />
                ) : (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`truncate text-sm ${entry.hidden ? 'text-slate-500' : 'text-white'}`}
                      title={entry.path}
                      onDoubleClick={() => onOpen(entry)}
                    >
                      {entry.name}
                    </span>
                    {entry.is_link && <Link2 className="w-3 h-3 text-slate-500 shrink-0" />}
                  </div>
                )}
                {showPath && (
                  <div className="text-[11px] text-slate-500 truncate">{entry.path}</div>
                )}
              </div>
              <span className="w-24 text-right text-xs text-slate-400 tabular-nums hidden sm:block">
                {entry.is_dir ? '--' : formatBytes(entry.size)}
              </span>
              <span className="w-32 text-right text-xs text-slate-500 hidden md:block">
                {entry.modified ? <ReactTimeAgo date={new Date(entry.modified)} locale="en-US" timeStyle="twitter" /> : '--'}
              </span>
              <button
                onClick={e => { e.stopPropagation(); onContext(entry, e.clientX, e.clientY); }}
                className="w-8 flex justify-center text-slate-500 hover:text-white transition-colors"
                title="Actions"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GridView({
  entries, selected, renaming, onSelect, onOpen, onContext, onRename, onRenameCancel,
}: FileListProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
      {entries.map(entry => {
        const isSelected = selected.has(entry.path);
        // Thumbnails are only rendered in grid view: generating one for a
        // video means an ffmpeg frame grab, and a list of 500 files should
        // not kick off 500 of those.
        const thumbable = !entry.is_dir && (entry.kind === 'image' || entry.kind === 'video');
        return (
          <div
            key={entry.path}
            onClick={e => onSelect(entry, e)}
            onDoubleClick={() => onOpen(entry)}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onContext(entry, e.clientX, e.clientY); }}
            className={`rounded-xl border p-2 cursor-default select-none transition-colors ${
              isSelected
                ? 'border-cyan-500/60 bg-cyan-500/10'
                : 'border-slate-700/50 bg-slate-800/30 hover:bg-slate-800/60'
            }`}
          >
            <div className="aspect-square rounded-lg bg-slate-900/60 flex items-center justify-center overflow-hidden mb-2">
              {thumbable ? (
                <img
                  src={getFileThumbUrl(entry.path)}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover"
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                />
              ) : (
                <EntryIcon entry={entry} className="w-10 h-10" />
              )}
            </div>
            {renaming === entry.path ? (
              <NameEditor
                initial={entry.name}
                onSubmit={name => onRename(entry, name)}
                onCancel={onRenameCancel}
              />
            ) : (
              <>
                <div className={`text-xs truncate ${entry.hidden ? 'text-slate-500' : 'text-white'}`} title={entry.name}>
                  {entry.name}
                </div>
                <div className="text-[11px] text-slate-500">
                  {entry.is_dir ? 'folder' : formatBytes(entry.size)}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

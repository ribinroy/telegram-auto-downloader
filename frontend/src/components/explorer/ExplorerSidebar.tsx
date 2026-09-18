import { HardDrive, Home, Download, Loader2, RefreshCw, Trash2, FolderCog, Server } from 'lucide-react';
import { formatBytes } from '../../utils/format';
import type { FileRoot } from '../../api/files';

function UsageBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  // Amber past 80%, red past 95% - a full media drive is the thing you want
  // to notice from across the room.
  const color = pct > 95 ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-cyan-500';
  return (
    <div className="h-1 bg-slate-700 rounded-full overflow-hidden mt-1.5">
      <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function rootIcon(kind: FileRoot['kind']) {
  if (kind === 'home') return <Home className="w-4 h-4 text-cyan-400" />;
  if (kind === 'downloads') return <Download className="w-4 h-4 text-green-400" />;
  if (kind === 'configured') return <FolderCog className="w-4 h-4 text-amber-400" />;
  if (kind === 'vps') return <Server className="w-4 h-4 text-pink-400" />;
  return <HardDrive className="w-4 h-4 text-purple-400" />;
}

function RootButton({
  root, active, containing, onNavigate,
}: {
  root: FileRoot;
  /** The current folder *is* this root. */
  active: boolean;
  /** The current folder lives somewhere under this root. */
  containing: boolean;
  onNavigate: (path: string) => void;
}) {
  const isDrive = root.group === 'drive';
  const here = active || containing;
  return (
    <button
      onClick={() => onNavigate(root.path)}
      className={`relative w-full text-left px-3 py-2 rounded-lg transition-colors ${
        active ? 'bg-slate-700/60' : containing ? 'bg-slate-800/70' : 'hover:bg-slate-800/60'
      }`}
      title={
        containing ? `${root.path} — you are viewing a folder on this ${isDrive ? 'drive' : 'location'}`
          : root.note ? `${root.path} — ${root.note}` : root.path
      }
    >
      {/* Accent bar rather than a stronger fill: "the drive you are on" has to
          be distinguishable at a glance from "the folder you are in", and two
          shades of slate alone aren't. */}
      {here && (
        <span className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full ${
          active ? 'bg-cyan-400' : 'bg-cyan-500/50'
        }`} />
      )}
      <div className="flex items-center gap-2 min-w-0">
        {rootIcon(root.kind)}
        <span className={`text-sm truncate ${active ? 'text-white' : containing ? 'text-slate-200' : 'text-slate-300'}`}>
          {root.label}
        </span>
        {isDrive && root.usage && (
          <span className="ml-auto text-[11px] text-slate-500 tabular-nums shrink-0">
            {formatBytes(root.usage.free)} free
          </span>
        )}
      </div>
      {/* Only drives get a capacity bar: repeating it per folder would just be
          the same disk's numbers three times over. */}
      {isDrive && root.usage && <UsageBar used={root.usage.used} total={root.usage.total} />}
      {root.note && (
        <div className="text-[11px] text-slate-500 truncate mt-0.5 pl-6">{root.note}</div>
      )}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block px-2 pt-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </span>
      {children}
    </div>
  );
}

export function ExplorerSidebar({
  roots, loading, currentPath, onNavigate, onRefresh, refreshing, trashPath,
}: {
  roots: FileRoot[];
  loading: boolean;
  currentPath: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  trashPath: string | null;
}) {
  const drives = roots.filter(r => r.group === 'drive');
  const folders = roots.filter(r => r.group === 'folder');
  const configured = roots.filter(r => r.group === 'configured');

  // The entry a group considers "open": the deepest root the current folder
  // sits under. Resolved per group and per longest prefix, so browsing
  // /mnt/disk/Movies marks the drive it lives on *and* the DownLee folder that
  // points there - without every parent (and '/', prefix of everything)
  // lighting up at once.
  const containerOf = (list: FileRoot[]) => {
    let best: string | null = null;
    for (const root of list) {
      const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`;
      const holds = currentPath === root.path || currentPath.startsWith(prefix);
      if (holds && (best === null || root.path.length > best.length)) best = root.path;
    }
    // Standing on the root itself is `active`, not `containing`. Exact matches
    // have to win the contest first, though: drop them earlier and sitting at
    // /mnt/disk would light up '/' instead, which reads as "this drive is on
    // the root filesystem" - the opposite of true for a mount point.
    return best === currentPath ? null : best;
  };

  const render = (list: FileRoot[]) => {
    const container = containerOf(list);
    return list.map(root => (
      <RootButton
        key={root.path}
        root={root}
        active={currentPath === root.path}
        containing={root.path === container}
        onNavigate={onNavigate}
      />
    ));
  };

  return (
    <nav className="space-y-1">
      <div className="flex items-center justify-between px-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Drives</span>
        <button
          onClick={onRefresh}
          className="p-1 text-slate-500 hover:text-white transition-colors"
          title="Rescan drives"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading && roots.length === 0 && (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading drives...
        </div>
      )}

      {render(drives)}

      {folders.length > 0 && <Section title="Folders">{render(folders)}</Section>}

      {/* The destinations the rest of DownLee already writes to, so the
          explorer opens where files actually land. */}
      {configured.length > 0 && <Section title="DownLee folders">{render(configured)}</Section>}

      {trashPath && (
        <Section title="Trash">
          <button
            onClick={() => onNavigate(trashPath)}
            className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
              currentPath === trashPath ? 'bg-slate-700/60' : 'hover:bg-slate-800/60'
            }`}
            title={trashPath}
          >
            <div className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-slate-400" />
              <span className="text-sm text-slate-300">Deleted files</span>
            </div>
          </button>
        </Section>
      )}
    </nav>
  );
}

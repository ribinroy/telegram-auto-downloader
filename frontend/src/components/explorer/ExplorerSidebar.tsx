import { HardDrive, Home, Download, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { formatBytes } from '../../utils/format';
import type { FileRoot } from '../../api/files';

function usageBar(used: number, total: number) {
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
  return <HardDrive className="w-4 h-4 text-purple-400" />;
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
  return (
    <aside className="w-full lg:w-64 shrink-0 space-y-1">
      <div className="flex items-center justify-between px-2 mb-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Places</span>
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

      {roots.map(root => {
        const active = currentPath === root.path;
        return (
          <button
            key={root.path}
            onClick={() => onNavigate(root.path)}
            className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
              active ? 'bg-slate-700/60' : 'hover:bg-slate-800/60'
            }`}
            title={root.path}
          >
            <div className="flex items-center gap-2 min-w-0">
              {rootIcon(root.kind)}
              <span className={`text-sm truncate ${active ? 'text-white' : 'text-slate-300'}`}>
                {root.label}
              </span>
              {root.usage && (
                <span className="ml-auto text-[11px] text-slate-500 tabular-nums shrink-0">
                  {formatBytes(root.usage.free)} free
                </span>
              )}
            </div>
            {root.usage && usageBar(root.usage.used, root.usage.total)}
          </button>
        );
      })}

      {trashPath && (
        <button
          onClick={() => onNavigate(trashPath)}
          className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
            currentPath === trashPath ? 'bg-slate-700/60' : 'hover:bg-slate-800/60'
          }`}
          title={trashPath}
        >
          <div className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-slate-400" />
            <span className="text-sm text-slate-300">Trash</span>
          </div>
        </button>
      )}
    </aside>
  );
}

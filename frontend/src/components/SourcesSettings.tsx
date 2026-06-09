import { useState, useEffect, useCallback } from 'react';
import {
  Loader2, AlertCircle, Plus, Trash2, Pencil, Check, X, Eye, EyeOff, FolderOpen, Globe,
} from 'lucide-react';
import { fetchMappings, createMapping, updateMapping, deleteMapping, browseLocal } from '../api';
import type { SourceMapping } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { FolderBrowser } from './FolderBrowser';

export function SourcesSettings({ onChange }: { onChange?: () => void }) {
  const [mappings, setMappings] = useState<SourceMapping[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [newQuality, setNewQuality] = useState('');
  const [newHidden, setNewHidden] = useState(false);
  const [adding, setAdding] = useState(false);

  // Edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFolder, setEditFolder] = useState('');
  const [editQuality, setEditQuality] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // Folder picker: 'new' for the add form, or a mapping id for an inline edit
  const [browseTarget, setBrowseTarget] = useState<'new' | number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMappings(await fetchMappings());
    } catch {
      setError('Failed to load source settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSource.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const result = await createMapping({
        downloaded_from: newSource.trim().toLowerCase(),
        folder: newFolder.trim() || null,
        quality: newQuality.trim() || null,
        is_secured: newHidden,
      });
      if ('error' in result) {
        setError(result.error);
      } else {
        setMappings(prev => [...prev, result].sort((a, b) => a.downloaded_from.localeCompare(b.downloaded_from)));
        setNewSource(''); setNewFolder(''); setNewQuality(''); setNewHidden(false);
        setShowAdd(false);
        onChange?.();
      }
    } catch {
      setError('Failed to add source');
    } finally {
      setAdding(false);
    }
  };

  const handleToggleHidden = async (mapping: SourceMapping) => {
    try {
      const result = await updateMapping(mapping.id, { is_secured: !mapping.is_secured });
      if ('error' in result) { setError(result.error); return; }
      setMappings(prev => prev.map(m => m.id === mapping.id ? result : m));
      onChange?.();
    } catch { setError('Failed to update source'); }
  };

  const startEdit = (mapping: SourceMapping) => {
    setEditingId(mapping.id);
    setEditFolder(mapping.folder || '');
    setEditQuality(mapping.quality || '');
  };

  const saveEdit = async (id: number) => {
    setSavingEdit(true);
    setError(null);
    try {
      const result = await updateMapping(id, {
        folder: editFolder.trim() || null,
        quality: editQuality.trim() || null,
      });
      if ('error' in result) { setError(result.error); return; }
      setMappings(prev => prev.map(m => m.id === id ? result : m));
      setEditingId(null);
      onChange?.();
    } catch { setError('Failed to update source'); }
    finally { setSavingEdit(false); }
  };

  const handleDelete = async (id: number) => {
    setDeleteConfirmId(null);
    try {
      await deleteMapping(id);
      setMappings(prev => prev.filter(m => m.id !== id));
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete source');
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Globe className="w-4 h-4 text-cyan-400" /> Sources
            </h3>
            <p className="text-xs text-slate-400">
              Per-source download specs: destination folder, default quality and hide.
              VPS watched folders have their own specs in VPS settings.
            </p>
          </div>
          <button
            onClick={() => setShowAdd(v => !v)}
            className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white text-sm py-2 px-3 rounded-lg transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" /> Add source
          </button>
        </div>

        {showAdd && (
          <form onSubmit={handleAdd} className="bg-slate-700/30 rounded-lg p-3 mb-3 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input value={newSource} onChange={e => setNewSource(e.target.value)} placeholder="Source (e.g. telegram, youtube, vps)"
                className="bg-slate-800/60 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500" />
              <div className="flex items-center gap-2 sm:col-span-2">
                <input value={newFolder} onChange={e => setNewFolder(e.target.value)} placeholder="Folder (e.g. /data/movies)"
                  className="bg-slate-800/60 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1 min-w-0" />
                <button type="button" onClick={() => setBrowseTarget('new')}
                  title="Browse folders" aria-label="Browse folders"
                  className="p-2 bg-slate-600/40 hover:bg-slate-600/70 text-slate-300 rounded-lg shrink-0">
                  <FolderOpen className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input value={newQuality} onChange={e => setNewQuality(e.target.value)} placeholder="Default quality (e.g. 1080p)"
                className="bg-slate-800/60 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1" />
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer px-2">
                <input type="checkbox" checked={newHidden} onChange={e => setNewHidden(e.target.checked)} />
                Hidden
              </label>
              <button type="submit" disabled={adding || !newSource.trim()}
                className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm py-2 px-3 rounded-lg">
                {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Add
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 text-cyan-500 animate-spin" /></div>
        ) : mappings.length === 0 ? (
          <div className="text-center py-6 text-slate-500 text-sm">No sources configured — downloads use the default folders</div>
        ) : (
          <div className="space-y-2">
            {mappings.map(mapping => (
              <div key={mapping.id} className="bg-slate-700/30 rounded-lg p-2.5">
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span className="text-sm font-medium text-white truncate capitalize">{mapping.downloaded_from}</span>
                  {mapping.quality && (
                    <span className="text-[10px] uppercase bg-slate-600/50 text-slate-300 rounded px-1.5 py-0.5">{mapping.quality}</span>
                  )}
                  <div className="flex-1" />
                  {/* Hidden toggle */}
                  <button onClick={() => handleToggleHidden(mapping)}
                    title={mapping.is_secured ? 'Hidden from the default view (click to show)' : 'Visible (click to hide)'}
                    className={`p-1.5 rounded-lg transition-colors ${mapping.is_secured ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-600/40 text-slate-400 hover:text-white'}`}>
                    {mapping.is_secured ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  {editingId !== mapping.id && (
                    <button onClick={() => startEdit(mapping)}
                      className="p-1.5 bg-slate-600/40 hover:bg-slate-600/70 text-slate-300 rounded-lg" title="Edit source">
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                  <button onClick={() => setDeleteConfirmId(mapping.id)}
                    title="Delete source"
                    className="p-1.5 bg-slate-600/40 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {editingId === mapping.id ? (
                  <div className="mt-2 flex items-center gap-2">
                    <input value={editFolder} onChange={e => setEditFolder(e.target.value)} placeholder="Folder"
                      className="bg-slate-800/60 border border-slate-700 rounded-lg py-1.5 px-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1 min-w-0" />
                    <button type="button" onClick={() => setBrowseTarget(mapping.id)}
                      title="Browse folders" aria-label="Browse folders"
                      className="p-1.5 bg-slate-600/40 hover:bg-slate-600/70 text-slate-300 rounded-lg shrink-0">
                      <FolderOpen className="w-4 h-4" />
                    </button>
                    <input value={editQuality} onChange={e => setEditQuality(e.target.value)} placeholder="Quality"
                      className="bg-slate-800/60 border border-slate-700 rounded-lg py-1.5 px-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 w-28" />
                    <button onClick={() => saveEdit(mapping.id)} disabled={savingEdit}
                      className="p-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg">
                      {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    </button>
                    <button onClick={() => setEditingId(null)} className="p-1.5 bg-slate-600/40 text-slate-300 rounded-lg">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 mt-1 pl-6 truncate">
                    {mapping.folder || <span className="italic">default folder</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <FolderBrowser
        isOpen={browseTarget !== null}
        onClose={() => setBrowseTarget(null)}
        browseFn={browseLocal}
        singleSelect
        title="Select a destination folder for this source"
        initialPath={browseTarget === 'new' ? (newFolder || null) : (editFolder || null)}
        onConfirm={(paths) => {
          const picked = paths[0] || '';
          if (browseTarget === 'new') setNewFolder(picked);
          else if (typeof browseTarget === 'number') setEditFolder(picked);
          setBrowseTarget(null);
        }}
      />

      <ConfirmDialog
        isOpen={deleteConfirmId !== null}
        title="Delete source settings?"
        message="Downloads from this source will use the default folder and become visible. Files already on disk are not moved."
        confirmText="Delete"
        variant="danger"
        onConfirm={() => deleteConfirmId !== null && handleDelete(deleteConfirmId)}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </div>
  );
}

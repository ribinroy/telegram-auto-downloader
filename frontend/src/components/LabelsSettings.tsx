import { useState, useEffect, useCallback } from 'react';
import {
  Loader2, AlertCircle, Plus, Trash2, Pencil, Check, X, Lock, Tag, Eye, EyeOff,
} from 'lucide-react';
import {
  fetchLabels, createLabel, updateLabel, deleteLabel,
  fetchSourceLabels, setSourceLabel,
} from '../api';
import type { Label, SourceLabel } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

// Sources that can have a default label
const KNOWN_SOURCES = ['telegram', 'vps', 'youtube'];

export function LabelsSettings({ onChange }: { onChange?: () => void }) {
  const [labels, setLabels] = useState<Label[]>([]);
  const [sourceLabels, setSourceLabels] = useState<SourceLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
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

  // Add-source-default row
  const [newSource, setNewSource] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ls, sls] = await Promise.all([fetchLabels(), fetchSourceLabels()]);
      setLabels(ls);
      setSourceLabels(sls);
    } catch {
      setError('Failed to load labels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const labelName = (id: number | null) => labels.find(l => l.id === id)?.name ?? '';

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const result = await createLabel({
        name: newName.trim(),
        folder: newFolder.trim() || null,
        quality: newQuality.trim() || null,
        is_hidden: newHidden,
      });
      if ('error' in result) {
        setError(result.error);
      } else {
        setLabels(prev => [...prev, result].sort((a, b) => a.name.localeCompare(b.name)));
        setNewName(''); setNewFolder(''); setNewQuality(''); setNewHidden(false);
        setShowAdd(false);
        onChange?.();
      }
    } catch {
      setError('Failed to create label');
    } finally {
      setAdding(false);
    }
  };

  const handleToggleHidden = async (label: Label) => {
    try {
      const result = await updateLabel(label.id, { is_hidden: !label.is_hidden });
      if ('error' in result) { setError(result.error); return; }
      setLabels(prev => prev.map(l => l.id === label.id ? result : l));
      onChange?.();
    } catch { setError('Failed to update label'); }
  };

  const startEdit = (label: Label) => {
    setEditingId(label.id);
    setEditFolder(label.folder || '');
    setEditQuality(label.quality || '');
  };

  const saveEdit = async (id: number) => {
    setSavingEdit(true);
    setError(null);
    try {
      const result = await updateLabel(id, {
        folder: editFolder.trim() || null,
        quality: editQuality.trim() || null,
      });
      if ('error' in result) { setError(result.error); return; }
      setLabels(prev => prev.map(l => l.id === id ? result : l));
      setEditingId(null);
      onChange?.();
    } catch { setError('Failed to update label'); }
    finally { setSavingEdit(false); }
  };

  const handleDelete = async (id: number) => {
    setDeleteConfirmId(null);
    try {
      await deleteLabel(id);
      setLabels(prev => prev.filter(l => l.id !== id));
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete label');
    }
  };

  const handleSetSourceDefault = async (source: string, labelId: number | null) => {
    setError(null);
    try {
      await setSourceLabel(source, labelId);
      setSourceLabels(await fetchSourceLabels());
      onChange?.();
    } catch { setError('Failed to set source default'); }
  };

  // Sources that don't yet have a default and aren't a known suggestion
  const usedSources = new Set(sourceLabels.map(s => s.source));
  const availableSources = KNOWN_SOURCES.filter(s => !usedSources.has(s));

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Labels */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Tag className="w-4 h-4 text-cyan-400" /> Labels
            </h3>
            <p className="text-xs text-slate-400">Named destinations. Downloads connected to a label are saved to its folder.</p>
          </div>
          <button
            onClick={() => setShowAdd(v => !v)}
            className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white text-sm py-2 px-3 rounded-lg transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" /> New label
          </button>
        </div>

        {showAdd && (
          <form onSubmit={handleAdd} className="bg-slate-700/30 rounded-lg p-3 mb-3 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name (e.g. Movies)"
                className="bg-slate-800/60 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500" />
              <input value={newFolder} onChange={e => setNewFolder(e.target.value)} placeholder="Folder (e.g. /data/movies)"
                className="bg-slate-800/60 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500 sm:col-span-2" />
            </div>
            <div className="flex items-center gap-2">
              <input value={newQuality} onChange={e => setNewQuality(e.target.value)} placeholder="Default quality (e.g. 1080p)"
                className="bg-slate-800/60 border border-slate-700 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1" />
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer px-2">
                <input type="checkbox" checked={newHidden} onChange={e => setNewHidden(e.target.checked)} />
                Hidden
              </label>
              <button type="submit" disabled={adding || !newName.trim()}
                className="flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm py-2 px-3 rounded-lg">
                {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Add
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 text-cyan-500 animate-spin" /></div>
        ) : labels.length === 0 ? (
          <div className="text-center py-6 text-slate-500 text-sm">No labels yet</div>
        ) : (
          <div className="space-y-2">
            {labels.map(label => (
              <div key={label.id} className="bg-slate-700/30 rounded-lg p-2.5">
                <div className="flex items-center gap-2">
                  <Tag className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span className="text-sm font-medium text-white truncate">{label.name}</span>
                  {label.is_system && (
                    <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide bg-slate-600/50 text-slate-300 rounded px-1.5 py-0.5">
                      <Lock className="w-3 h-3" /> system
                    </span>
                  )}
                  {label.quality && (
                    <span className="text-[10px] uppercase bg-slate-600/50 text-slate-300 rounded px-1.5 py-0.5">{label.quality}</span>
                  )}
                  <div className="flex-1" />
                  {/* Hidden toggle */}
                  <button onClick={() => handleToggleHidden(label)}
                    title={label.is_hidden ? 'Hidden from list (click to show)' : 'Visible (click to hide)'}
                    className={`p-1.5 rounded-lg transition-colors ${label.is_hidden ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-600/40 text-slate-400 hover:text-white'}`}>
                    {label.is_hidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  {editingId !== label.id && (
                    <button onClick={() => startEdit(label)}
                      className="p-1.5 bg-slate-600/40 hover:bg-slate-600/70 text-slate-300 rounded-lg" title="Edit folder/quality">
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                  <button onClick={() => setDeleteConfirmId(label.id)} disabled={label.is_system}
                    title={label.is_system ? 'System labels cannot be deleted' : 'Delete label'}
                    className="p-1.5 bg-slate-600/40 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-600/40 disabled:hover:text-slate-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {editingId === label.id ? (
                  <div className="flex items-center gap-2 mt-2">
                    <input value={editFolder} onChange={e => setEditFolder(e.target.value)} placeholder="Folder"
                      className="bg-slate-800/60 border border-slate-700 rounded-lg py-1.5 px-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1" />
                    <input value={editQuality} onChange={e => setEditQuality(e.target.value)} placeholder="Quality"
                      className="bg-slate-800/60 border border-slate-700 rounded-lg py-1.5 px-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 w-28" />
                    <button onClick={() => saveEdit(label.id)} disabled={savingEdit}
                      className="p-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg">
                      {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    </button>
                    <button onClick={() => setEditingId(null)} className="p-1.5 bg-slate-600/40 text-slate-300 rounded-lg">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 mt-1 pl-6 truncate">
                    {label.folder || <span className="italic">default folder</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-source default labels */}
      <div className="pt-5 border-t border-slate-700/60">
        <h3 className="text-sm font-semibold text-white">Default label per source</h3>
        <p className="text-xs text-slate-400 mb-3">New downloads from a source use this label unless overridden.</p>
        <div className="space-y-2">
          {sourceLabels.map(sl => (
            <div key={sl.source} className="flex items-center gap-2 bg-slate-700/30 rounded-lg p-2.5">
              <span className="text-sm text-slate-200 w-24 shrink-0 capitalize">{sl.source}</span>
              <select
                value={sl.label_id ?? ''}
                onChange={e => handleSetSourceDefault(sl.source, e.target.value ? Number(e.target.value) : null)}
                className="bg-slate-800/60 border border-slate-700 rounded-lg py-1.5 px-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1"
              >
                <option value="">No default</option>
                {labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <span className="text-xs text-slate-500 hidden sm:inline">{labelName(sl.label_id)}</span>
            </div>
          ))}
          {/* Add a new source default */}
          <div className="flex items-center gap-2">
            <select value={newSource} onChange={e => setNewSource(e.target.value)}
              className="bg-slate-800/60 border border-slate-700 rounded-lg py-1.5 px-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 w-32 shrink-0">
              <option value="">Add source…</option>
              {availableSources.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              disabled={!newSource}
              defaultValue=""
              onChange={e => { if (newSource && e.target.value) { handleSetSourceDefault(newSource, Number(e.target.value)); setNewSource(''); } }}
              className="bg-slate-800/60 border border-slate-700 rounded-lg py-1.5 px-2.5 text-sm text-white focus:outline-none focus:border-cyan-500 flex-1 disabled:opacity-50"
            >
              <option value="">Pick a label…</option>
              {labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={deleteConfirmId !== null}
        title="Delete label?"
        message="Downloads connected to this label keep their files but lose the label. This cannot be undone."
        confirmText="Delete"
        variant="danger"
        onConfirm={() => deleteConfirmId !== null && handleDelete(deleteConfirmId)}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </div>
  );
}

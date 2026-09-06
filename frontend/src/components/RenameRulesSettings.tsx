import { useMemo, useState } from 'react';
import {
  Loader2, Plus, Trash2, ChevronUp, ChevronDown, AlertCircle, CheckCircle,
  Play, ArrowRight, Wand2,
} from 'lucide-react';
import {
  useRenameRules, useCreateRenameRule, useUpdateRenameRule, useDeleteRenameRule,
  useReorderRenameRules, useRenamePreview, useApplyRenameRules,
} from '../hooks/useSettings';
import { testRenameRules, type RenameRule, type RenameRuleInput, type RenameApplyResult } from '../api';
import { ConfirmDialog } from './ConfirmDialog';

const BLANK: RenameRuleInput = {
  name: '', pattern: '', replacement: '', enabled: true, source: null, stop_on_match: false,
};

/**
 * Starting points, so the first rule doesn't have to be written from scratch.
 *
 * `position` matters: the chain is order-sensitive and some rules destroy what
 * a later one needs. "Dots to spaces" turns @Movie_Tamizhaa into
 * "@Movie Tamizhaa", after which the leading-tag rule can no longer reach the
 * separator — so the tag rule has to run first. Spaced weights let presets be
 * clicked in any order and still land in a working sequence.
 */
const PRESETS: { label: string; rule: Partial<RenameRuleInput> & { position: number } }[] = [
  {
    label: 'Strip quality tags',
    rule: {
      name: 'Strip quality tags',
      position: 20,
      pattern: '[.\\s_-]*\\b(2160p|1080p|720p|480p|4K|WEB-?DL|WEBRip|BluRay|BRRip|HDRip|HDTV|DVDRip|x26[45]|H\\.?26[45]|HEVC|AVC|10bit|AAC|AC3|E?AC-?3|DTS|DDP?\\+?\\s?5\\.1|ATMOS|TrueHD)\\b',
      replacement: '',
    },
  },
  {
    // Uploader prefixes, all anchored to the start so separators elsewhere in
    // the title are untouched:
    //   www.UIndex.org -  |  1337x.to -  |  @Movie_Tamizhaa ~  |  RF -
    // The bare-domain branch needs a real TLD and the short-tag branch is
    // uppercase-only, so dotted scene names ("Movie.Name - Extra") and real
    // titles ("Movie - The Return") survive intact.
    label: 'Drop leading tag / site',
    rule: {
      name: 'Drop leading tag / site',
      position: 10,
      pattern:
        '^(?:www\\.[\\w.-]+' +
        '|[\\w-]+\\.(?:com|org|net|info|biz|tv|to|me|cc|io|in|is|se|nu|ru|la|st|ws|sx' +
        '|xyz|site|club|co|uk|us|top|link|online|pro|app|mx|ph|id)' +
        '|@[\\w.]+' +
        '|[A-Z0-9]{2,5})' +
        '\\s*[-~|:]\\s*',
      replacement: '',
    },
  },
  {
    label: 'Dots to spaces',
    rule: { name: 'Dots to spaces',
      position: 30, pattern: '(?<=\\w)[._](?=\\w)', replacement: ' ' },
  },
  {
    label: 'Drop release group',
    rule: { name: 'Drop release group',
      position: 40, pattern: '-[A-Za-z0-9]+$', replacement: '' },
  },
  {
    label: 'Year in brackets',
    rule: { name: 'Year in brackets',
      position: 50, pattern: '[.\\s](19|20)(\\d{2})\\b', replacement: ' (\\1\\2)' },
  },
];

function RuleEditor({
  value, onChange, onSave, onCancel, saving, error,
}: {
  value: RenameRuleInput;
  onChange: (v: RenameRuleInput) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const [preview, setPreview] = useState<{ original: string; new: string }[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [matchCount, setMatchCount] = useState<number | null>(null);

  // Preview this rule on its own, against real filenames from the library.
  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    setMatchCount(null);
    try {
      const res = await testRenameRules(value);
      setPreview(res.results.filter(r => r.changed).slice(0, 8));
      setMatchCount(res.changed);
      if (res.changed === 0) {
        setPreviewError(`No match in any of your ${res.total} filenames`);
      }
    } catch (err) {
      setPreview(null);
      setPreviewError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const field = 'w-full bg-slate-900/60 border border-slate-600 rounded-lg py-2 px-3 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors';

  return (
    <div className="bg-slate-700/30 border border-slate-600/60 rounded-lg p-4 space-y-3">
      <input
        className={field}
        placeholder="Rule name (optional)"
        value={value.name || ''}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Match (regular expression)</label>
          <input
            className={`${field} font-mono`}
            placeholder="\\.(1080p|720p)"
            value={value.pattern}
            onChange={(e) => onChange({ ...value, pattern: e.target.value })}
            spellCheck={false}
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Replace with</label>
          <input
            className={`${field} font-mono`}
            placeholder="(empty to remove)"
            value={value.replacement}
            onChange={(e) => onChange({ ...value, replacement: e.target.value })}
            spellCheck={false}
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Captured groups are <code className="text-slate-400">\1</code>,{' '}
            <code className="text-slate-400">\2</code> — not <code>$1</code>.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm text-slate-300">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
            className="accent-cyan-500"
          />
          Enabled
        </label>
        <label className="flex items-center gap-2 cursor-pointer" title="Skip the remaining rules once this one matches">
          <input
            type="checkbox"
            checked={value.stop_on_match}
            onChange={(e) => onChange({ ...value, stop_on_match: e.target.checked })}
            className="accent-cyan-500"
          />
          Stop after this rule
        </label>
        <label className="flex items-center gap-2">
          <span className="text-slate-400 text-xs">Only for source</span>
          <input
            className="bg-slate-900/60 border border-slate-600 rounded px-2 py-1 text-white text-xs w-32 focus:outline-none focus:border-cyan-500"
            placeholder="all sources"
            value={value.source || ''}
            onChange={(e) => onChange({ ...value, source: e.target.value || null })}
          />
        </label>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/40 rounded-lg p-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="font-mono text-xs">{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={runPreview}
          disabled={!value.pattern || previewing}
          className="flex items-center gap-1.5 text-xs bg-slate-600/50 hover:bg-slate-600 text-slate-200 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Preview
        </button>
        <div className="flex-1" />
        <button onClick={onCancel} className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5">
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={!value.pattern || saving}
          className="flex items-center gap-1.5 text-xs bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Save rule
        </button>
      </div>

      {previewError && <p className="text-xs text-amber-400">{previewError}</p>}
      {preview && preview.length > 0 && (
        <div className="border-t border-slate-600/50 pt-3 space-y-1">
          <p className="text-xs text-slate-400 mb-2">
            Matches {matchCount} file{matchCount === 1 ? '' : 's'} — showing the first {preview.length}:
          </p>
          {preview.map((row, i) => (
            <div key={i} className="text-xs font-mono flex items-start gap-2 min-w-0">
              <span className="text-slate-500 line-through truncate flex-1">{row.original}</span>
              <ArrowRight className="w-3 h-3 text-slate-600 shrink-0 mt-0.5" />
              <span className="text-cyan-300 truncate flex-1">{row.new}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RenameRulesSettings() {
  const { data, isLoading } = useRenameRules();
  const rules = useMemo(() => data?.rules ?? [], [data]);

  const createMut = useCreateRenameRule();
  const updateMut = useUpdateRenameRule();
  const deleteMut = useDeleteRenameRule();
  const reorderMut = useReorderRenameRules();
  const applyMut = useApplyRenameRules();
  const { data: preview, isFetching: previewFetching } = useRenamePreview(rules.length > 0);

  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<RenameRuleInput>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RenameApplyResult | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [applied, setApplied] = useState<RenameApplyResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RenameRule | null>(null);

  const startNew = (seed?: Partial<RenameRuleInput>) => {
    setDraft({ ...BLANK, ...seed });
    setError(null);
    setEditingId('new');
  };

  const startEdit = (rule: RenameRule) => {
    setDraft({
      name: rule.name || '', pattern: rule.pattern, replacement: rule.replacement,
      enabled: rule.enabled, source: rule.source, stop_on_match: rule.stop_on_match,
    });
    setError(null);
    setEditingId(rule.id);
  };

  const save = async () => {
    setError(null);
    try {
      if (editingId === 'new') await createMut.mutateAsync(draft);
      else if (typeof editingId === 'number') await updateMut.mutateAsync({ id: editingId, rule: draft });
      setEditingId(null);
      setPlan(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the rule');
    }
  };

  const move = (index: number, delta: number) => {
    const next = [...rules];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorderMut.mutate(next.map(r => r.id));
    setPlan(null);
  };

  const toggle = (rule: RenameRule) => {
    updateMut.mutate({
      id: rule.id,
      rule: {
        name: rule.name || '', pattern: rule.pattern, replacement: rule.replacement,
        enabled: !rule.enabled, source: rule.source, stop_on_match: rule.stop_on_match,
      },
    });
    setPlan(null);
  };

  const runDryRun = async () => {
    setApplied(null);
    setPlan(await applyMut.mutateAsync(true));
  };

  const runApply = async () => {
    setConfirmApply(false);
    const result = await applyMut.mutateAsync(false);
    setApplied(result);
    setPlan(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading rules...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-slate-400 text-sm">
          Rules rewrite a filename <strong className="text-slate-300">before the download starts</strong>, so
          files are saved under their final name from the first byte. They run top to bottom, and each one
          feeds the next.
        </p>
        <p className="text-slate-500 text-xs mt-2">
          The file extension is never matched or modified — write <code className="text-slate-400">\.1080p</code>,
          not <code className="text-slate-400">\.1080p\.mkv</code>.
        </p>
      </div>

      {/* Rules */}
      <div className="space-y-2">
        {rules.length === 0 && editingId !== 'new' && (
          <p className="text-slate-500 text-sm py-4">No rules yet — downloads keep their original names.</p>
        )}

        {rules.map((rule, index) => (
          <div key={rule.id}>
            {editingId === rule.id ? (
              <RuleEditor
                value={draft} onChange={setDraft} onSave={save}
                onCancel={() => { setEditingId(null); setError(null); }}
                saving={updateMut.isPending} error={error}
              />
            ) : (
              <div className={`flex items-center gap-3 bg-slate-700/30 border border-slate-600/50 rounded-lg px-3 py-2 ${rule.enabled ? '' : 'opacity-50'}`}>
                <div className="flex flex-col">
                  <button onClick={() => move(index, -1)} disabled={index === 0}
                          className="text-slate-500 hover:text-cyan-400 disabled:opacity-20 disabled:hover:text-slate-500"
                          aria-label="Move up">
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => move(index, 1)} disabled={index === rules.length - 1}
                          className="text-slate-500 hover:text-cyan-400 disabled:opacity-20 disabled:hover:text-slate-500"
                          aria-label="Move down">
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>

                <button onClick={() => startEdit(rule)} className="flex-1 min-w-0 text-left">
                  <p className="text-sm text-white truncate">
                    {rule.name || rule.pattern}
                    {rule.source && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400 bg-slate-600/50 rounded px-1.5 py-0.5">
                        {rule.source}
                      </span>
                    )}
                    {rule.stop_on_match && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-300 bg-amber-500/10 rounded px-1.5 py-0.5">
                        stops
                      </span>
                    )}
                  </p>
                  <p className="text-xs font-mono text-slate-500 truncate">
                    {rule.pattern} <span className="text-slate-600">→</span> {rule.replacement || '(removed)'}
                  </p>
                </button>

                <label className="shrink-0 cursor-pointer" title={rule.enabled ? 'Disable' : 'Enable'}>
                  <input type="checkbox" checked={rule.enabled} onChange={() => toggle(rule)} className="accent-cyan-500" />
                </label>
                <button onClick={() => setConfirmDelete(rule)}
                        className="shrink-0 p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        aria-label="Delete rule">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        ))}

        {editingId === 'new' && (
          <RuleEditor
            value={draft} onChange={setDraft} onSave={save}
            onCancel={() => { setEditingId(null); setError(null); }}
            saving={createMut.isPending} error={error}
          />
        )}
      </div>

      {editingId === null && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => startNew()}
                  className="flex items-center gap-1.5 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg px-3 py-2 transition-colors">
            <Plus className="w-4 h-4" /> Add rule
          </button>
          <span className="text-xs text-slate-500">or start from:</span>
          {[...PRESETS].sort((a, b) => a.rule.position - b.rule.position).map(p => (
            <button key={p.label} onClick={() => startNew(p.rule)}
                    className="flex items-center gap-1.5 text-xs bg-slate-700/50 hover:bg-slate-700 text-slate-300 rounded-lg px-2.5 py-1.5 transition-colors">
              <Wand2 className="w-3 h-3" /> {p.label}
            </button>
          ))}
        </div>
      )}

      {/* What the saved chain does to real files */}
      {rules.length > 0 && (
        <div className="border-t border-slate-700/50 pt-5">
          <h3 className="text-white font-medium mb-1">Effect on new downloads</h3>
          <p className="text-slate-400 text-sm mb-3">
            {previewFetching ? 'Checking…'
              : preview
                ? `${preview.changed} of ${preview.total} filenames in your library would be rewritten by these rules.`
                : ''}
          </p>
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {preview?.results.filter(r => r.changed).slice(0, 12).map((row, i) => (
              <div key={i} className="text-xs font-mono flex items-start gap-2 min-w-0">
                <span className="text-slate-500 line-through truncate flex-1">{row.original}</span>
                <ArrowRight className="w-3 h-3 text-slate-600 shrink-0 mt-0.5" />
                <span className="text-cyan-300 truncate flex-1">{row.new}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Retro-apply */}
      <div className="border-t border-slate-700/50 pt-5">
        <h3 className="text-white font-medium mb-1">Apply to existing files</h3>
        <p className="text-slate-400 text-sm mb-3">
          Replays these rules over already-downloaded files, renaming them on disk. Only completed downloads
          are touched — anything still transferring is left alone.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={runDryRun} disabled={applyMut.isPending || rules.length === 0}
                  className="flex items-center gap-1.5 text-sm bg-slate-700/50 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 transition-colors disabled:opacity-50">
            {applyMut.isPending && applyMut.variables === true
              ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Preview changes
          </button>
          {plan && plan.total > 0 && (
            <button onClick={() => setConfirmApply(true)} disabled={applyMut.isPending}
                    className="flex items-center gap-1.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg px-3 py-2 transition-colors disabled:opacity-50">
              Rename {plan.total} file{plan.total === 1 ? '' : 's'}
            </button>
          )}
        </div>

        {plan && (
          <div className="mt-3">
            {plan.total === 0 ? (
              <p className="text-sm text-slate-400">Nothing to rename — every file already matches these rules.</p>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto border border-slate-700/50 rounded-lg p-3">
                {plan.items.map(item => (
                  <div key={item.id} className="text-xs font-mono flex items-start gap-2 min-w-0">
                    <span className="text-slate-500 line-through truncate flex-1">{item.from}</span>
                    <ArrowRight className="w-3 h-3 text-slate-600 shrink-0 mt-0.5" />
                    <span className={`truncate flex-1 ${item.status === 'missing' ? 'text-amber-400' : 'text-cyan-300'}`}>
                      {item.status === 'missing' ? 'file not found on disk' : item.to}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {applied && (
          <div className="mt-3 flex items-start gap-2 bg-green-500/10 border border-green-500/40 rounded-lg p-3 text-sm text-green-400">
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Renamed {applied.renamed} file{applied.renamed === 1 ? '' : 's'}
              {applied.skipped ? `, skipped ${applied.skipped} (not found on disk)` : ''}
              {applied.failed ? `, ${applied.failed} failed` : ''}.
            </span>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmApply}
        title="Rename existing files?"
        message={`${plan?.total ?? 0} file${plan?.total === 1 ? '' : 's'} will be renamed on disk. This can't be undone automatically — the previous names are only in the list you just previewed.`}
        confirmText="Rename them"
        onConfirm={runApply}
        onCancel={() => setConfirmApply(false)}
      />

      <ConfirmDialog
        isOpen={!!confirmDelete}
        title="Delete this rule?"
        message={`"${confirmDelete?.name || confirmDelete?.pattern}" will no longer be applied to new downloads. Files already renamed by it are not affected.`}
        confirmText="Delete"
        onConfirm={() => {
          if (confirmDelete) deleteMut.mutate(confirmDelete.id);
          setConfirmDelete(null);
          setPlan(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

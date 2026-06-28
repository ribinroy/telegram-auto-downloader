import { useState } from 'react';
import { Loader2, AlertCircle, Plus, Trash2, Play, Pencil, X, TerminalSquare, BookOpen, ChevronDown } from 'lucide-react';
import type { BotQuery } from '../api';
import { useBotQueries, useSaveBotQuery, useDeleteBotQuery, useTestBotQuery } from '../hooks/useSettings';
import { ConfirmDialog } from './ConfirmDialog';

export function QueriesSettings() {
  const queriesQuery = useBotQueries();
  const queries = queriesQuery.data ?? [];
  const loading = queriesQuery.isLoading;
  const saveMut = useSaveBotQuery();
  const deleteMut = useDeleteBotQuery();
  const testMut = useTestBotQuery();
  const [error, setError] = useState<string | null>(null);

  // Editor state (shared by "add new" and "edit existing")
  const [editingKey, setEditingKey] = useState<string | null>(null); // original key, '' = new
  const [formKey, setFormKey] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const saving = saveMut.isPending;

  // Test-run state
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, string>>({});

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const startEdit = (q?: BotQuery) => {
    setEditingKey(q ? q.key : '');
    setFormKey(q?.key ?? '');
    setFormCommand(q?.command ?? '');
    setError(null);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setFormKey('');
    setFormCommand('');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await saveMut.mutateAsync({ key: formKey.trim(), command: formCommand, originalKey: editingKey || undefined });
      if (result.error) setError(result.error);
      else cancelEdit();
    } catch {
      setError('Failed to save query');
    }
  };

  const handleDelete = async () => {
    if (deleteTarget === null) return;
    const key = deleteTarget;
    setDeleteTarget(null);
    setError(null);
    try {
      const result = await deleteMut.mutateAsync(key);
      if (result.error) setError(result.error);
    } catch {
      setError('Failed to delete query');
    }
  };

  const handleRun = async (q: BotQuery) => {
    setRunningKey(q.key);
    setError(null);
    try {
      const result = await testMut.mutateAsync(q.command);
      setOutputs(prev => ({ ...prev, [q.key]: result.error || result.output || '(no output)' }));
    } catch {
      setOutputs(prev => ({ ...prev, [q.key]: 'Failed to run command' }));
    } finally {
      setRunningKey(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
      </div>
    );
  }

  const editorOpen = editingKey !== null;

  return (
    <div className="space-y-4">
      <div className="text-sm text-slate-400 space-y-2">
        <p>
          Chat commands for the Telegram bot: tag the bot (or DM it) with a key and the
          shell snippet runs on this server, replying with its output. Tag it with{' '}
          <code className="text-cyan-400 bg-slate-700/50 px-1 rounded">help</code> to list the keys.
        </p>
      </div>

      <details className="bg-slate-700/30 rounded-lg group">
        <summary className="flex items-center gap-2 p-4 cursor-pointer select-none text-sm text-white font-medium">
          <BookOpen className="w-4 h-4 text-cyan-400" />
          How to create a query snippet
          <ChevronDown className="w-4 h-4 text-slate-500 ml-auto transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-4 text-xs text-slate-400 space-y-3">
          <div>
            <p className="text-slate-300 font-medium mb-1">1. Pick a key</p>
            <p>
              A single word (no spaces), e.g. <code className="bg-slate-800/60 px-1 rounded">health</code> or{' '}
              <code className="bg-slate-800/60 px-1 rounded">hddok</code>. Matching is case-insensitive, and{' '}
              <code className="bg-slate-800/60 px-1 rounded">help</code> is reserved.
            </p>
          </div>
          <div>
            <p className="text-slate-300 font-medium mb-1">2. Write the shell snippet</p>
            <p>
              Plain bash, one or more lines. Whatever it prints (stdout + stderr) becomes the bot's reply.
              These variables are set for you:
            </p>
            <ul className="mt-1.5 space-y-1 font-mono text-[11px]">
              <li><code className="text-cyan-400">$DOWNLOAD_DIR</code> <span className="font-sans text-slate-500">— the download root folder</span></li>
              <li><code className="text-cyan-400">$SENDER_NAME</code> <span className="font-sans text-slate-500">— display name of whoever triggered it</span></li>
              <li><code className="text-cyan-400">$SENDER_USERNAME</code> / <code className="text-cyan-400">$SENDER_ID</code> <span className="font-sans text-slate-500">— their @username / numeric ID</span></li>
              <li><code className="text-cyan-400">$CHAT_TITLE</code> <span className="font-sans text-slate-500">— the group it was asked in (empty in DMs)</span></li>
            </ul>
          </div>
          <div>
            <p className="text-slate-300 font-medium mb-1">3. Test, then use it from Telegram</p>
            <p>
              Use the <Play className="w-3 h-3 inline text-green-400" /> button to run it here first. Then in
              Telegram: <code className="bg-slate-800/60 px-1 rounded">@YourBot health</code> in a group, or just{' '}
              <code className="bg-slate-800/60 px-1 rounded">health</code> in a DM.
            </p>
          </div>
          <div>
            <p className="text-slate-300 font-medium mb-1">Examples</p>
            <pre className="bg-slate-800/60 rounded-lg p-3 overflow-x-auto font-mono text-[11px] text-slate-300 whitespace-pre-wrap">{`# greet whoever asked
echo "Hello \${SENDER_NAME:-there}, hope you are good? 😊"

# free disk space on the download drive
df -h "$DOWNLOAD_DIR" | awk 'NR==2 {print "💾 "$4" free of "$2}'

# SMART health of every disk
for d in $(lsblk -dno NAME,TYPE | awk '$2=="disk"{print $1}'); do
  echo "$d: $(sudo -n smartctl -H /dev/$d | tail -1)"
done`}</pre>
          </div>
          <div>
            <p className="text-slate-300 font-medium mb-1">Rules &amp; limits</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Snippets time out after 30 seconds; replies are capped at ~4000 characters.</li>
              <li>A non-zero exit code is appended to the reply so failures are visible.</li>
              <li>Commands needing root (like <code className="bg-slate-800/60 px-1 rounded">smartctl</code>) must use{' '}
                <code className="bg-slate-800/60 px-1 rounded">sudo -n</code> and need a NOPASSWD sudoers entry.</li>
              <li>Changes apply immediately — no restart needed.</li>
            </ul>
          </div>
          <p className="text-amber-400/80">
            Snippets run as the service user, and anyone who can message the bot can trigger
            them — keep them read-only and never include destructive commands.
          </p>
        </div>
      </details>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {queries.length === 0 && !editorOpen && (
        <p className="text-sm text-slate-500">No queries configured yet.</p>
      )}

      {queries.map(q => (
        <div key={q.key} className="bg-slate-700/30 rounded-lg p-4">
          {editingKey === q.key ? (
            <QueryForm
              formKey={formKey} setFormKey={setFormKey}
              formCommand={formCommand} setFormCommand={setFormCommand}
              saving={saving} onSubmit={handleSave} onCancel={cancelEdit}
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <TerminalSquare className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span className="text-white font-medium text-sm font-mono truncate">{q.key}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleRun(q)}
                    disabled={runningKey !== null}
                    className="p-1.5 text-slate-400 hover:text-green-400 transition-colors disabled:opacity-50"
                    title="Run now"
                  >
                    {runningKey === q.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => startEdit(q)}
                    className="p-1.5 text-slate-400 hover:text-cyan-400 transition-colors"
                    title="Edit"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setDeleteTarget(q.key)}
                    className="p-1.5 text-slate-400 hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <pre className="text-xs text-slate-300 bg-slate-800/60 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono">{q.command}</pre>
              {outputs[q.key] !== undefined && (
                <div className="mt-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-slate-500">Output</span>
                    <button
                      onClick={() => setOutputs(prev => { const next = { ...prev }; delete next[q.key]; return next; })}
                      className="text-slate-500 hover:text-white transition-colors"
                      title="Dismiss"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <pre className="text-xs text-green-300/90 bg-slate-900/70 border border-slate-700 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono">{outputs[q.key]}</pre>
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {editingKey === '' ? (
        <div className="bg-slate-700/30 rounded-lg p-4">
          <QueryForm
            formKey={formKey} setFormKey={setFormKey}
            formCommand={formCommand} setFormCommand={setFormCommand}
            saving={saving} onSubmit={handleSave} onCancel={cancelEdit}
          />
        </div>
      ) : !editorOpen && (
        <button
          onClick={() => startEdit()}
          className="flex items-center gap-2 text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add query
        </button>
      )}

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete query?"
        message={`The bot will stop responding to "${deleteTarget ?? ''}".`}
        confirmText="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function QueryForm({ formKey, setFormKey, formCommand, setFormCommand, saving, onSubmit, onCancel }: {
  formKey: string;
  setFormKey: (v: string) => void;
  formCommand: string;
  setFormCommand: (v: string) => void;
  saving: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <label className="block text-sm text-slate-400 mb-1">Key (what you tag the bot with)</label>
        <input
          type="text"
          value={formKey}
          onChange={(e) => setFormKey(e.target.value)}
          placeholder="health"
          className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors font-mono text-sm"
          required
        />
      </div>
      <div>
        <label className="block text-sm text-slate-400 mb-1">Shell command</label>
        <textarea
          value={formCommand}
          onChange={(e) => setFormCommand(e.target.value)}
          placeholder={'df -h "$DOWNLOAD_DIR" | tail -1'}
          rows={4}
          className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors font-mono text-xs resize-y"
          required
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-slate-400 hover:text-white border border-slate-600 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !formKey.trim() || !formCommand.trim()}
          className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? 'Saving...' : 'Save Query'}
        </button>
      </div>
    </form>
  );
}

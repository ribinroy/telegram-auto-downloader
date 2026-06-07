import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, CheckCircle, Check, Plug, FolderPlus, Folder, Trash2 } from 'lucide-react';
import {
  fetchVpsConfig, saveVpsConfig, testVpsConnection,
  fetchVpsFolders, addVpsFolders, deleteVpsFolder,
  type VpsConfig, type VpsWatchFolder,
} from '../api';
import { VpsFolderBrowser } from './VpsFolderBrowser';

export function VpsSettings() {
  // Connection config
  const [config, setConfig] = useState<VpsConfig | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);

  // Watched folders
  const [folders, setFolders] = useState<VpsWatchFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);

  useEffect(() => {
    loadConfig();
    loadFolders();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    setTestResult(null);
    try {
      const cfg = await fetchVpsConfig();
      setConfig(cfg);
      setHost(cfg.host || '');
      setPort(String(cfg.port || 22));
      setUsername(cfg.username || '');
      setPassword('');
    } catch {
      setError('Failed to load VPS configuration');
    } finally {
      setLoading(false);
    }
  };

  const loadFolders = async () => {
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      setFolders(await fetchVpsFolders());
    } catch {
      setFoldersError('Failed to load watched folders');
    } finally {
      setFoldersLoading(false);
    }
  };

  const buildInput = () => ({
    host: host.trim(),
    port: parseInt(port, 10) || 22,
    username: username.trim(),
    remote_path: '',
    ...(password ? { password } : {}),
  });

  const canConnect = host.trim() !== '' && username.trim() !== '';
  const canBrowse = !!config?.configured && !!config?.has_password;

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await testVpsConnection(buildInput()));
    } catch {
      setTestResult({ success: false, error: 'Failed to run connection test' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await saveVpsConfig(buildInput());
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess('VPS connection saved');
        setPassword('');
        await loadConfig();
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch {
      setError('Failed to save VPS configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleAddFolders = async (paths: string[]) => {
    setBrowserOpen(false);
    if (paths.length === 0) return;
    setFoldersError(null);
    try {
      setFolders(await addVpsFolders(paths));
    } catch {
      setFoldersError('Failed to add folders');
    }
  };

  const handleDeleteFolder = async (id: number) => {
    setFoldersError(null);
    try {
      setFolders(await deleteVpsFolder(id));
    } catch {
      setFoldersError('Failed to remove folder');
    }
  };

  return (
    <>
      {/* Connection status banner */}
      <div className={`flex items-center gap-2 rounded-lg p-3 mb-4 text-sm border ${
        config?.configured
          ? 'bg-green-500/10 border-green-500/40 text-green-400'
          : config
            ? 'bg-slate-700/40 border-slate-600 text-slate-400'
            : 'bg-amber-500/10 border-amber-500/40 text-amber-400'
      }`}>
        <span className={`w-2 h-2 rounded-full ${config?.configured ? 'bg-green-400' : config ? 'bg-slate-500' : 'bg-amber-400'}`} />
        {config?.configured ? (
          <span>
            Configured — <span className="font-medium text-white">{config.username}@{config.host}:{config.port}</span>
            {config.has_password ? ' (password saved)' : ' (no password saved)'}
          </span>
        ) : config ? (
          <span>Not configured yet. Enter your VPS details below.</span>
        ) : (
          <span>Couldn't load saved configuration. Check the connection and try again.</span>
        )}
      </div>

      {success && (
        <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/50 rounded-lg p-3 mb-4 text-green-400 text-sm">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <p className="text-sm text-slate-400 mb-4">
        Connect to a remote server over SSH/SFTP to browse and download files from watched folders.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-sm text-slate-400 mb-1">Host</label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="e.g., your-box.seedhost.eu"
                className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
                className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g., myuser"
              autoComplete="off"
              className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
              required
            />
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={config?.has_password ? '•••••••• (leave blank to keep saved password)' : 'SSH password'}
              autoComplete="new-password"
              className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
            />
            <p className="text-xs text-slate-500 mt-1">
              Stored encrypted at rest (Fernet, keyed off your JWT secret). Never sent back to the browser.
            </p>
          </div>

          {testResult && (
            <div className={`flex items-center gap-2 border rounded-lg p-3 text-sm ${
              testResult.success
                ? 'bg-green-500/20 border-green-500/50 text-green-400'
                : 'bg-red-500/20 border-red-500/50 text-red-400'
            }`}>
              {testResult.success ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
              <span>{testResult.success ? testResult.message : testResult.error}</span>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || saving || !canConnect}
              className="flex-1 bg-slate-600 hover:bg-slate-500 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
              Test
            </button>
            <button
              type="submit"
              disabled={saving || testing || !canConnect}
              className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Done
            </button>
          </div>
        </form>
      )}

      {/* Watched folders */}
      <div className="mt-6 pt-5 border-t border-slate-700/60">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Watched Folders</h3>
            <p className="text-xs text-slate-400">Remote folders to browse and download from.</p>
          </div>
          <button
            onClick={() => setBrowserOpen(true)}
            disabled={!canBrowse}
            title={canBrowse ? 'Browse remote folders' : 'Save the connection (with password) first to browse'}
            className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white text-sm py-2 px-3 rounded-lg transition-colors shrink-0"
          >
            <FolderPlus className="w-4 h-4" />
            Browse
          </button>
        </div>

        {!canBrowse && (
          <p className="text-xs text-amber-400/80 mb-3">
            Save the connection with a password above to browse and add folders.
          </p>
        )}

        {foldersError && (
          <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-3 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{foldersError}</span>
          </div>
        )}

        {foldersLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 text-cyan-500 animate-spin" />
          </div>
        ) : folders.length === 0 ? (
          <div className="text-center py-6 text-slate-500">
            <Folder className="w-7 h-7 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No folders watched yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {folders.map((f) => (
              <div key={f.id} className="flex items-center gap-2 bg-slate-700/30 rounded-lg p-2.5">
                <Folder className="w-4 h-4 text-cyan-400 shrink-0" />
                <span className="text-sm text-slate-200 truncate flex-1" title={f.path}>{f.path}</span>
                <button
                  onClick={() => handleDeleteFolder(f.id)}
                  className="p-1.5 bg-slate-600/50 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors shrink-0"
                  title="Remove folder"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <VpsFolderBrowser
        isOpen={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onConfirm={handleAddFolders}
        alreadyAdded={folders.map(f => f.path)}
      />
    </>
  );
}

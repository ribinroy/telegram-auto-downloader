import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, CheckCircle, Check, Plug, FolderPlus, Folder, Trash2, Unplug, Server } from 'lucide-react';
import {
  fetchVpsConfig, saveVpsConfig, testVpsConnection, deleteVpsConfig,
  fetchVpsFolders, addVpsFolders, deleteVpsFolder, setVpsFolderAutoSync,
  type VpsConfig, type VpsWatchFolder,
} from '../api';
import { FolderBrowser } from './FolderBrowser';
import { ConfirmDialog } from './ConfirmDialog';

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
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

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

  const handleRemove = async () => {
    setConfirmRemove(false);
    setRemoving(true);
    setError(null);
    setSuccess(null);
    setTestResult(null);
    try {
      const result = await deleteVpsConfig();
      if (result.error) {
        setError(result.error);
      } else {
        setPassword('');
        await loadConfig();
        setSuccess('VPS connection removed');
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch {
      setError('Failed to remove VPS connection');
    } finally {
      setRemoving(false);
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

  const handleToggleAutoSync = async (folder: VpsWatchFolder) => {
    setFoldersError(null);
    try {
      setFolders(await setVpsFolderAutoSync(folder.id, !folder.auto_sync));
    } catch {
      setFoldersError('Failed to update autoSync');
    }
  };

  const statusPill = config?.configured ? (
    <span
      className="flex items-center gap-1.5 text-xs bg-green-500/15 text-green-400 border border-green-500/30 rounded-full px-2.5 py-1 shrink-0"
      title={`${config.username}@${config.host}:${config.port}${config.has_password ? ' (password saved)' : ' (no password saved)'}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
      Configured
    </span>
  ) : config ? (
    <span className="flex items-center gap-1.5 text-xs bg-slate-700/60 text-slate-400 border border-slate-600 rounded-full px-2.5 py-1 shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
      Not configured
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-xs bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded-full px-2.5 py-1 shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
      Unavailable
    </span>
  );

  return (
    <>
      {/* Title row with status to the right */}
      <div className="flex items-center justify-between gap-3 mb-5 pb-4 border-b border-slate-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <Server className="w-5 h-5 text-cyan-400 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white leading-tight">VPS Connection</h2>
            <p className="text-xs text-slate-400 truncate">
              {config?.configured
                ? `${config.username}@${config.host}:${config.port}`
                : 'Remote SSH/SFTP server'}
            </p>
          </div>
        </div>
        {!loading && statusPill}
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

          {config?.configured && (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              disabled={removing || saving || testing}
              className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/40 text-red-400 font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {removing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unplug className="w-4 h-4" />}
              Remove connection
            </button>
          )}
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
            {folders.map((f) => {
              const inactive = f.active === false;
              return (
                <div
                  key={f.id}
                  className={`flex items-center gap-2 rounded-lg p-2.5 ${inactive ? 'bg-slate-800/30 opacity-60' : 'bg-slate-700/30'}`}
                >
                  <Folder className={`w-4 h-4 shrink-0 ${inactive ? 'text-slate-500' : 'text-cyan-400'}`} />
                  <div className="flex-1 min-w-0">
                    <span className={`block text-sm truncate ${inactive ? 'text-slate-400' : 'text-slate-200'}`} title={f.path}>{f.path}</span>
                    {inactive && (
                      <span className="text-[11px] text-slate-500">
                        {f.username ? `${f.username}@${f.host}` : f.host} — connect to this VPS to manage
                      </span>
                    )}
                  </div>
                  {/* autoSync toggle - only for folders on the current connection */}
                  <button
                    onClick={() => handleToggleAutoSync(f)}
                    disabled={inactive}
                    title={inactive ? 'Connect to this VPS to change autoSync' : (f.auto_sync ? 'autoSync on — checks hourly for new files' : 'autoSync off')}
                    className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg transition-colors shrink-0 disabled:cursor-not-allowed ${
                      f.auto_sync && !inactive
                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                        : 'bg-slate-600/40 text-slate-400 border border-transparent'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${f.auto_sync && !inactive ? 'bg-purple-400' : 'bg-slate-500'}`} />
                    autoSync
                  </button>
                  <button
                    onClick={() => handleDeleteFolder(f.id)}
                    disabled={inactive}
                    className="p-1.5 bg-slate-600/50 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-600/50 disabled:hover:text-slate-400"
                    title="Remove folder"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <FolderBrowser
        isOpen={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onConfirm={handleAddFolders}
        alreadyAdded={folders.map(f => f.path)}
      />

      <ConfirmDialog
        isOpen={confirmRemove}
        title="Remove VPS connection?"
        message="This deletes the saved host, username and password. Your watched folders are kept, but browsing is disabled until you reconnect."
        confirmText="Remove"
        variant="danger"
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}

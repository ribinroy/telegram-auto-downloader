import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, CheckCircle, Key, FolderCog, Plus, Trash2, Shield, ShieldOff, Pencil, Check, Cookie, Wrench, Server, Plug } from 'lucide-react';
import { updatePassword, fetchMappings, addMapping, updateMapping, deleteMapping, fetchCookies, saveCookies, syncThumbnails, getYtdlpVersion, upgradeYtdlp, fetchVpsConfig, saveVpsConfig, testVpsConnection } from '../api';
import type { SyncThumbnailsResult, VpsConfig } from '../api';
import type { DownloadTypeMap } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useLayoutContext } from '../components/Layout';

type TabType = 'password' | 'mappings' | 'cookies' | 'jobs' | 'vps';

export function SettingsPage() {
  const { showSecured: showMappings, loadSecuredMappingIds: onMappingsChanged } = useLayoutContext();
  const [activeTab, setActiveTab] = useState<TabType>('password');

  // Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Mappings state
  const [mappings, setMappings] = useState<DownloadTypeMap[]>([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingsError, setMappingsError] = useState<string | null>(null);

  // New mapping form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newDownloadedFrom, setNewDownloadedFrom] = useState('');
  const [newIsSecured, setNewIsSecured] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [newQuality, setNewQuality] = useState('');
  const [addingMapping, setAddingMapping] = useState(false);

  // Edit mapping state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFolder, setEditFolder] = useState('');
  const [editQuality, setEditQuality] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // Cookies state
  const [cookiesContent, setCookiesContent] = useState('');
  const [cookiesLoading, setCookiesLoading] = useState(false);
  const [cookiesSaving, setCookiesSaving] = useState(false);
  const [cookiesError, setCookiesError] = useState<string | null>(null);
  const [cookiesSuccess, setCookiesSuccess] = useState(false);

  // Jobs state
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncThumbnailsResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // yt-dlp upgrade state
  const [ytdlpVersion, setYtdlpVersion] = useState<string | null>(null);
  const [ytdlpUpgrading, setYtdlpUpgrading] = useState(false);
  const [ytdlpResult, setYtdlpResult] = useState<{ old_version?: string; new_version?: string; upgraded?: boolean } | null>(null);
  const [ytdlpError, setYtdlpError] = useState<string | null>(null);

  // VPS connection state
  const [vpsConfig, setVpsConfig] = useState<VpsConfig | null>(null);
  const [vpsHost, setVpsHost] = useState('');
  const [vpsPort, setVpsPort] = useState('22');
  const [vpsUsername, setVpsUsername] = useState('');
  const [vpsPassword, setVpsPassword] = useState('');
  const [vpsRemotePath, setVpsRemotePath] = useState('');
  const [vpsLoading, setVpsLoading] = useState(false);
  const [vpsSaving, setVpsSaving] = useState(false);
  const [vpsTesting, setVpsTesting] = useState(false);
  const [vpsError, setVpsError] = useState<string | null>(null);
  const [vpsSuccess, setVpsSuccess] = useState<string | null>(null);
  const [vpsTestResult, setVpsTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);

  // Load mappings when tab changes to mappings
  useEffect(() => {
    if (activeTab === 'mappings') {
      loadMappings();
    }
  }, [activeTab]);

  // Load cookies when tab changes to cookies
  useEffect(() => {
    if (activeTab === 'cookies') {
      loadCookies();
    }
  }, [activeTab]);

  // Load yt-dlp version when tab changes to jobs
  useEffect(() => {
    if (activeTab === 'jobs') {
      getYtdlpVersion().then(r => setYtdlpVersion(r.version)).catch(() => {});
    }
  }, [activeTab]);

  // Load VPS config when tab changes to vps
  useEffect(() => {
    if (activeTab === 'vps') {
      loadVpsConfig();
    }
  }, [activeTab]);

  const loadVpsConfig = async () => {
    setVpsLoading(true);
    setVpsError(null);
    setVpsTestResult(null);
    try {
      const cfg = await fetchVpsConfig();
      setVpsConfig(cfg);
      setVpsHost(cfg.host || '');
      setVpsPort(String(cfg.port || 22));
      setVpsUsername(cfg.username || '');
      setVpsRemotePath(cfg.remote_path || '');
      setVpsPassword('');
    } catch {
      setVpsError('Failed to load VPS configuration');
    } finally {
      setVpsLoading(false);
    }
  };

  const buildVpsInput = () => ({
    host: vpsHost.trim(),
    port: parseInt(vpsPort, 10) || 22,
    username: vpsUsername.trim(),
    remote_path: vpsRemotePath.trim(),
    ...(vpsPassword ? { password: vpsPassword } : {}),
  });

  const handleTestVps = async () => {
    setVpsTesting(true);
    setVpsError(null);
    setVpsTestResult(null);
    try {
      const result = await testVpsConnection(buildVpsInput());
      setVpsTestResult(result);
    } catch {
      setVpsTestResult({ success: false, error: 'Failed to run connection test' });
    } finally {
      setVpsTesting(false);
    }
  };

  const handleSaveVps = async () => {
    setVpsSaving(true);
    setVpsError(null);
    setVpsSuccess(null);
    try {
      const result = await saveVpsConfig(buildVpsInput());
      if (result.error) {
        setVpsError(result.error);
      } else {
        setVpsSuccess('VPS connection saved');
        setVpsPassword('');
        await loadVpsConfig();
        setTimeout(() => setVpsSuccess(null), 3000);
      }
    } catch {
      setVpsError('Failed to save VPS configuration');
    } finally {
      setVpsSaving(false);
    }
  };

  const loadCookies = async () => {
    setCookiesLoading(true);
    setCookiesError(null);
    try {
      const data = await fetchCookies();
      setCookiesContent(data);
    } catch {
      setCookiesError('Failed to load cookies');
    } finally {
      setCookiesLoading(false);
    }
  };

  const handleSaveCookies = async () => {
    setCookiesSaving(true);
    setCookiesError(null);
    setCookiesSuccess(false);
    try {
      const result = await saveCookies(cookiesContent);
      if (result.error) {
        setCookiesError(result.error);
      } else {
        setCookiesSuccess(true);
        setTimeout(() => setCookiesSuccess(false), 3000);
      }
    } catch {
      setCookiesError('Failed to save cookies');
    } finally {
      setCookiesSaving(false);
    }
  };

  const handleYtdlpUpgrade = async () => {
    setYtdlpUpgrading(true);
    setYtdlpError(null);
    setYtdlpResult(null);
    try {
      const result = await upgradeYtdlp();
      if (result.error) {
        setYtdlpError(result.error);
      } else {
        setYtdlpResult(result);
        if (result.new_version) setYtdlpVersion(result.new_version);
      }
    } catch {
      setYtdlpError('Failed to upgrade yt-dlp');
    } finally {
      setYtdlpUpgrading(false);
    }
  };

  const handleSyncThumbnails = async () => {
    setSyncRunning(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const result = await syncThumbnails();
      setSyncResult(result);
    } catch {
      setSyncError('Failed to run thumbnail sync');
    } finally {
      setSyncRunning(false);
    }
  };

  const loadMappings = async () => {
    setMappingsLoading(true);
    setMappingsError(null);
    try {
      const data = await fetchMappings();
      setMappings(data);
    } catch {
      setMappingsError('Failed to load mappings');
    } finally {
      setMappingsLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    if (newPassword.length < 3) {
      setPasswordError('Password must be at least 3 characters');
      return;
    }

    setPasswordLoading(true);
    try {
      await updatePassword(currentPassword, newPassword);
      setPasswordSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to update password');
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleAddMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDownloadedFrom.trim()) return;

    setAddingMapping(true);
    setMappingsError(null);
    try {
      const result = await addMapping(
        newDownloadedFrom.trim().toLowerCase(),
        newIsSecured,
        newFolder.trim() || null,
        newQuality.trim() || null
      );
      if ('error' in result) {
        setMappingsError(result.error);
      } else {
        setMappings(prev => [...prev, result].sort((a, b) => a.downloaded_from.localeCompare(b.downloaded_from)));
        setNewDownloadedFrom('');
        setNewIsSecured(false);
        setNewFolder('');
        setNewQuality('');
        setShowAddForm(false);
        onMappingsChanged?.();
      }
    } catch {
      setMappingsError('Failed to add mapping');
    } finally {
      setAddingMapping(false);
    }
  };

  const handleToggleSecured = async (mapping: DownloadTypeMap) => {
    try {
      const result = await updateMapping(mapping.id, { is_secured: !mapping.is_secured });
      if ('error' in result) {
        setMappingsError(result.error);
      } else {
        setMappings(prev => prev.map(m => m.id === mapping.id ? result : m));
        onMappingsChanged?.();
      }
    } catch {
      setMappingsError('Failed to update mapping');
    }
  };

  const handleStartEdit = (mapping: DownloadTypeMap) => {
    setEditingId(mapping.id);
    setEditFolder(mapping.folder || '');
    setEditQuality(mapping.quality || '');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditFolder('');
    setEditQuality('');
  };

  const handleSaveEdit = async (id: number) => {
    setSavingEdit(true);
    setMappingsError(null);
    try {
      const result = await updateMapping(id, {
        folder: editFolder.trim() || null,
        quality: editQuality.trim() || null
      });
      if ('error' in result) {
        setMappingsError(result.error);
      } else {
        setMappings(prev => prev.map(m => m.id === id ? result : m));
        setEditingId(null);
        setEditFolder('');
        setEditQuality('');
        onMappingsChanged?.();
      }
    } catch {
      setMappingsError('Failed to update mapping');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteMapping = async (id: number) => {
    try {
      await deleteMapping(id);
      setMappings(prev => prev.filter(m => m.id !== id));
      onMappingsChanged?.();
    } catch (err) {
      setMappingsError(err instanceof Error ? err.message : 'Failed to delete mapping');
    }
    setDeleteConfirmId(null);
  };

  const tabs: { id: TabType; label: string; description: string; icon: typeof Key; show: boolean }[] = [
    { id: 'password', label: 'Password', description: 'Change your account password', icon: Key, show: true },
    { id: 'mappings', label: 'Mappings', description: 'Per-source folders & quality', icon: FolderCog, show: showMappings },
    { id: 'cookies', label: 'Cookies', description: 'yt-dlp browser cookies', icon: Cookie, show: true },
    { id: 'vps', label: 'VPS Connection', description: 'Remote SSH/SFTP server', icon: Server, show: true },
    { id: 'jobs', label: 'Jobs', description: 'Maintenance & tools', icon: Wrench, show: true },
  ];
  const visibleTabs = tabs.filter(t => t.show);
  const activeTabMeta = visibleTabs.find(t => t.id === activeTab) ?? visibleTabs[0];

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-6 w-full">
      <div className="mb-4 sm:mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-xs sm:text-sm">Manage your preferences and configuration</p>
      </div>

      <div className="flex flex-col md:flex-row gap-4 sm:gap-6">
        {/* Sidebar tabs */}
        <nav className="md:w-64 md:shrink-0 flex md:flex-col gap-1 overflow-x-auto md:overflow-visible border-b md:border-b-0 border-slate-700 pb-2 md:pb-0">
          {visibleTabs.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-3 px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg text-left transition-colors whitespace-nowrap md:whitespace-normal ${
                  active
                    ? 'bg-cyan-500/15 text-cyan-400 md:border md:border-cyan-500/30'
                    : 'text-slate-400 hover:text-white hover:bg-slate-700/40'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{tab.label}</span>
                  <span className={`hidden md:block text-xs ${active ? 'text-cyan-400/70' : 'text-slate-500'}`}>
                    {tab.description}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 bg-slate-800/50 border border-slate-700 rounded-xl p-4 sm:p-6">
          <div className="hidden md:flex items-center gap-2 mb-5 pb-4 border-b border-slate-700/60">
            <activeTabMeta.icon className="w-5 h-5 text-cyan-400" />
            <div>
              <h2 className="text-base font-semibold text-white leading-tight">{activeTabMeta.label}</h2>
              <p className="text-xs text-slate-400">{activeTabMeta.description}</p>
            </div>
          </div>
        {activeTab === 'password' && (
          <>
            {passwordSuccess && (
              <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/50 rounded-lg p-3 mb-4 text-green-400 text-sm">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>Password updated successfully</span>
              </div>
            )}

            {passwordError && (
              <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-400 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{passwordError}</span>
              </div>
            )}

            <form onSubmit={handlePasswordSubmit} className="space-y-3">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Confirm New Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={passwordLoading}
                className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-4"
              >
                {passwordLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Updating...
                  </>
                ) : (
                  'Update Password'
                )}
              </button>
            </form>
          </>
        )}

        {activeTab === 'mappings' && showMappings && (
          <>
            {mappingsError && (
              <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-400 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{mappingsError}</span>
              </div>
            )}

            <p className="text-sm text-slate-400 mb-4">
              Configure download sources. Secured sources are hidden from the download list.
            </p>

            {!showAddForm && (
              <button
                onClick={() => setShowAddForm(true)}
                className="flex items-center gap-2 text-sm text-cyan-400 hover:text-cyan-300 mb-4"
              >
                <Plus className="w-4 h-4" />
                Add Mapping
              </button>
            )}

            {showAddForm && (
              <form onSubmit={handleAddMapping} className="bg-slate-700/30 rounded-lg p-3 mb-4 space-y-3">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Source (domain or identifier)</label>
                  <input
                    type="text"
                    value={newDownloadedFrom}
                    onChange={(e) => setNewDownloadedFrom(e.target.value)}
                    placeholder="e.g., youtube, twitter, tiktok"
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg py-2 px-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Folder (optional, full path)</label>
                  <input
                    type="text"
                    value={newFolder}
                    onChange={(e) => setNewFolder(e.target.value)}
                    placeholder="e.g., /mnt/storage/Videos"
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg py-2 px-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Run <code className="bg-slate-800 px-1 rounded">sudo chmod 777 /path/to/folder</code> to ensure write permissions
                  </p>
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">Default Quality (optional)</label>
                  <input
                    type="text"
                    value={newQuality}
                    onChange={(e) => setNewQuality(e.target.value)}
                    placeholder="e.g., 720p, 1080p, 480p"
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg py-2 px-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Auto-select this quality when downloading from this source
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="newIsSecured"
                    checked={newIsSecured}
                    onChange={(e) => setNewIsSecured(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0"
                  />
                  <label htmlFor="newIsSecured" className="text-sm text-slate-300">
                    Hide downloads from this source
                  </label>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setNewDownloadedFrom('');
                      setNewIsSecured(false);
                      setNewFolder('');
                      setNewQuality('');
                    }}
                    className="flex-1 py-2 bg-slate-600 hover:bg-slate-500 text-white text-sm rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={addingMapping || !newDownloadedFrom.trim()}
                    className="flex-1 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {addingMapping ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add'}
                  </button>
                </div>
              </form>
            )}

            {mappingsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
              </div>
            ) : mappings.length === 0 ? (
              <div className="text-center py-8 text-slate-400">
                <FolderCog className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No mappings configured</p>
              </div>
            ) : (
              <div className="space-y-2">
                {mappings.map((mapping) => (
                  <div
                    key={mapping.id}
                    className="bg-slate-700/30 rounded-lg p-3"
                  >
                    {editingId === mapping.id ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium">{mapping.downloaded_from}</span>
                          {mapping.is_secured && (
                            <span className="px-1.5 py-0.5 text-xs bg-red-500/20 text-red-400 rounded">
                              Hidden
                            </span>
                          )}
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">Folder</label>
                          <input
                            type="text"
                            value={editFolder}
                            onChange={(e) => setEditFolder(e.target.value)}
                            placeholder="Folder path (optional)"
                            className="w-full bg-slate-800 border border-slate-600 rounded-lg py-1.5 px-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">Default Quality</label>
                          <input
                            type="text"
                            value={editQuality}
                            onChange={(e) => setEditQuality(e.target.value)}
                            placeholder="e.g., 720p, 1080p"
                            className="w-full bg-slate-800 border border-slate-600 rounded-lg py-1.5 px-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleCancelEdit}
                            className="flex-1 py-1.5 bg-slate-600 hover:bg-slate-500 text-white text-sm rounded-lg transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleSaveEdit(mapping.id)}
                            disabled={savingEdit}
                            className="flex-1 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 text-white text-sm rounded-lg transition-colors flex items-center justify-center gap-1"
                          >
                            {savingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-white font-medium truncate">{mapping.downloaded_from}</span>
                            {mapping.is_secured && (
                              <span className="px-1.5 py-0.5 text-xs bg-red-500/20 text-red-400 rounded">
                                Hidden
                              </span>
                            )}
                            {mapping.quality && (
                              <span className="px-1.5 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded">
                                {mapping.quality}
                              </span>
                            )}
                          </div>
                          {mapping.folder && (
                            <p className="text-xs text-slate-400 truncate mt-0.5">
                              Folder: {mapping.folder}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 ml-2">
                          <button
                            onClick={() => handleStartEdit(mapping)}
                            className="p-2 bg-slate-600/50 hover:bg-slate-600 text-slate-400 hover:text-white rounded-lg transition-colors"
                            title="Edit mapping"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleToggleSecured(mapping)}
                            className={`p-2 rounded-lg transition-colors ${
                              mapping.is_secured
                                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                                : 'bg-slate-600/50 text-slate-400 hover:bg-slate-600'
                            }`}
                            title={mapping.is_secured ? 'Show in list' : 'Hide from list'}
                          >
                            {mapping.is_secured ? (
                              <Shield className="w-4 h-4" />
                            ) : (
                              <ShieldOff className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            onClick={() => setDeleteConfirmId(mapping.id)}
                            className="p-2 bg-slate-600/50 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors"
                            title="Delete mapping"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === 'cookies' && (
          <>
            {cookiesSuccess && (
              <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/50 rounded-lg p-3 mb-4 text-green-400 text-sm">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>Cookies saved successfully</span>
              </div>
            )}

            {cookiesError && (
              <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-400 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{cookiesError}</span>
              </div>
            )}

            <div className="text-sm text-slate-400 mb-4 space-y-2">
              <p>
                Paste your browser cookies here for sites with Cloudflare protection.
                Use a browser extension like "Get cookies.txt LOCALLY" to export cookies.
              </p>
              <p className="text-amber-400/80">
                <strong>Important:</strong> For CDN-protected sites, you need cookies from both the main site AND the CDN domain.
                Visit the video page in your browser to trigger Cloudflare on the CDN, then export all cookies.
              </p>
            </div>

            {cookiesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
              </div>
            ) : (
              <>
                <textarea
                  value={cookiesContent}
                  onChange={(e) => setCookiesContent(e.target.value)}
                  placeholder="# Netscape HTTP Cookie File&#10;# Paste cookies here...&#10;.example.com&#9;TRUE&#9;/&#9;FALSE&#9;0&#9;session_id&#9;abc123"
                  className="w-full h-64 bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors font-mono text-xs resize-none"
                />
                <button
                  onClick={handleSaveCookies}
                  disabled={cookiesSaving}
                  className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-4"
                >
                  {cookiesSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    'Save Cookies'
                  )}
                </button>
              </>
            )}
          </>
        )}

        {activeTab === 'vps' && (
          <>
            {/* Connection status banner */}
            <div className={`flex items-center gap-2 rounded-lg p-3 mb-4 text-sm border ${
              vpsConfig?.configured
                ? 'bg-green-500/10 border-green-500/40 text-green-400'
                : vpsConfig
                  ? 'bg-slate-700/40 border-slate-600 text-slate-400'
                  : 'bg-amber-500/10 border-amber-500/40 text-amber-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${vpsConfig?.configured ? 'bg-green-400' : vpsConfig ? 'bg-slate-500' : 'bg-amber-400'}`} />
              {vpsConfig?.configured ? (
                <span>
                  Configured — <span className="font-medium text-white">{vpsConfig.username}@{vpsConfig.host}:{vpsConfig.port}</span>
                  {vpsConfig.has_password ? ' (password saved)' : ' (no password saved)'}
                </span>
              ) : vpsConfig ? (
                <span>Not configured yet. Enter your VPS details below.</span>
              ) : (
                <span>Couldn't load saved configuration. Check the connection and try again.</span>
              )}
            </div>

            {vpsSuccess && (
              <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/50 rounded-lg p-3 mb-4 text-green-400 text-sm">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>{vpsSuccess}</span>
              </div>
            )}

            {vpsError && (
              <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-400 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{vpsError}</span>
              </div>
            )}

            <p className="text-sm text-slate-400 mb-4">
              Connect to a remote server over SSH/SFTP to browse and download files from a watched folder.
            </p>

            {vpsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
              </div>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); handleSaveVps(); }} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-sm text-slate-400 mb-1">Host</label>
                    <input
                      type="text"
                      value={vpsHost}
                      onChange={(e) => setVpsHost(e.target.value)}
                      placeholder="e.g., your-box.seedhost.eu"
                      className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Port</label>
                    <input
                      type="number"
                      value={vpsPort}
                      onChange={(e) => setVpsPort(e.target.value)}
                      placeholder="22"
                      className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-slate-400 mb-1">Username</label>
                  <input
                    type="text"
                    value={vpsUsername}
                    onChange={(e) => setVpsUsername(e.target.value)}
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
                    value={vpsPassword}
                    onChange={(e) => setVpsPassword(e.target.value)}
                    placeholder={vpsConfig?.has_password ? '•••••••• (leave blank to keep saved password)' : 'SSH password'}
                    autoComplete="new-password"
                    className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Stored encrypted at rest (Fernet, keyed off your JWT secret). Never sent back to the browser.
                  </p>
                </div>

                <div>
                  <label className="block text-sm text-slate-400 mb-1">Watch Folder (remote path)</label>
                  <input
                    type="text"
                    value={vpsRemotePath}
                    onChange={(e) => setVpsRemotePath(e.target.value)}
                    placeholder="e.g., /home/myuser/downloads"
                    className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Optional — if set, Test will also verify this folder is listable.
                  </p>
                </div>

                {vpsTestResult && (
                  <div className={`flex items-center gap-2 border rounded-lg p-3 text-sm ${
                    vpsTestResult.success
                      ? 'bg-green-500/20 border-green-500/50 text-green-400'
                      : 'bg-red-500/20 border-red-500/50 text-red-400'
                  }`}>
                    {vpsTestResult.success ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                    <span>{vpsTestResult.success ? vpsTestResult.message : vpsTestResult.error}</span>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleTestVps}
                    disabled={vpsTesting || vpsSaving || !vpsHost.trim() || !vpsUsername.trim()}
                    className="flex-1 bg-slate-600 hover:bg-slate-500 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {vpsTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                    Test
                  </button>
                  <button
                    type="submit"
                    disabled={vpsSaving || vpsTesting || !vpsHost.trim() || !vpsUsername.trim()}
                    className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {vpsSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Done
                  </button>
                </div>
              </form>
            )}
          </>
        )}

        {activeTab === 'jobs' && (
          <>
            <p className="text-sm text-slate-400 mb-4">
              Maintenance jobs and tools.
            </p>

            {/* yt-dlp Upgrade */}
            <div className="bg-slate-700/30 rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-white font-medium text-sm">yt-dlp</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {ytdlpVersion ? `Current version: ${ytdlpVersion}` : 'Checking version...'}
                  </p>
                </div>
              </div>

              <button
                onClick={handleYtdlpUpgrade}
                disabled={ytdlpUpgrading}
                className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-3"
              >
                {ytdlpUpgrading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Upgrading...
                  </>
                ) : (
                  'Upgrade yt-dlp'
                )}
              </button>

              {ytdlpError && (
                <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mt-3 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{ytdlpError}</span>
                </div>
              )}

              {ytdlpResult && (
                <div className={`flex items-center gap-2 ${ytdlpResult.upgraded ? 'bg-green-500/20 border-green-500/50 text-green-400' : 'bg-slate-600/30 border-slate-500/50 text-slate-400'} border rounded-lg p-3 mt-3 text-sm`}>
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span>
                    {ytdlpResult.upgraded
                      ? `Upgraded: ${ytdlpResult.old_version} → ${ytdlpResult.new_version}`
                      : `Already up to date (${ytdlpResult.new_version})`
                    }
                  </span>
                </div>
              )}
            </div>

            {/* Sync Thumbnails */}
            <div className="bg-slate-700/30 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-white font-medium text-sm">Sync Thumbnails</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Generate missing thumbnails, clean up orphans, and fix DB counts.
                  </p>
                </div>
              </div>

              <button
                onClick={handleSyncThumbnails}
                disabled={syncRunning}
                className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-3"
              >
                {syncRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  'Run Sync'
                )}
              </button>

              {syncError && (
                <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mt-3 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{syncError}</span>
                </div>
              )}

              {syncResult && (
                <div className="mt-3 bg-slate-800/50 rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center gap-2 text-green-400 text-sm font-medium mb-2">
                    <CheckCircle className="w-4 h-4" />
                    Sync complete
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {syncResult.generated > 0 && (
                      <div className="text-green-400">Generated: {syncResult.generated}</div>
                    )}
                    {syncResult.skipped > 0 && (
                      <div className="text-slate-400">Already had thumbs: {syncResult.skipped}</div>
                    )}
                    {syncResult.orphan_deleted > 0 && (
                      <div className="text-amber-400">Orphans deleted: {syncResult.orphan_deleted}</div>
                    )}
                    {syncResult.db_count_fixed > 0 && (
                      <div className="text-cyan-400">DB counts fixed: {syncResult.db_count_fixed}</div>
                    )}
                    {syncResult.meta_extracted > 0 && (
                      <div className="text-cyan-400">Meta extracted: {syncResult.meta_extracted}</div>
                    )}
                    {syncResult.failed > 0 && (
                      <div className="text-red-400">Failed: {syncResult.failed}</div>
                    )}
                    {syncResult.no_duration > 0 && (
                      <div className="text-slate-500">No duration: {syncResult.no_duration}</div>
                    )}
                    {syncResult.not_video > 0 && (
                      <div className="text-slate-500">Not video: {syncResult.not_video}</div>
                    )}
                    {syncResult.generated === 0 && syncResult.orphan_deleted === 0 && syncResult.db_count_fixed === 0 && syncResult.meta_extracted === 0 && syncResult.failed === 0 && (
                      <div className="col-span-2 text-slate-400">Everything is already in sync.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteConfirmId !== null}
        title="Delete Mapping?"
        message="This will remove the mapping configuration. Downloads from this source will no longer be hidden."
        confirmText="Delete"
        variant="danger"
        onConfirm={() => deleteConfirmId && handleDeleteMapping(deleteConfirmId)}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </div>
  );
}

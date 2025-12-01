import { useState, useEffect } from 'react';
import { X, Loader2, AlertCircle, CheckCircle, Key, FolderCog, Plus, Trash2, Shield, ShieldOff, Pencil, Check, Cookie } from 'lucide-react';
import { updatePassword, fetchMappings, addMapping, updateMapping, deleteMapping, fetchCookies, saveCookies } from '../api';
import type { DownloadTypeMap } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  showMappings?: boolean;
}

type TabType = 'password' | 'mappings' | 'cookies';

export function SettingsDialog({ isOpen, onClose, showMappings = false }: SettingsDialogProps) {
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

  // Load mappings when tab changes to mappings
  useEffect(() => {
    if (isOpen && activeTab === 'mappings') {
      loadMappings();
    }
  }, [isOpen, activeTab]);

  // Load cookies when tab changes to cookies
  useEffect(() => {
    if (isOpen && activeTab === 'cookies') {
      loadCookies();
    }
  }, [isOpen, activeTab]);

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
    } catch (err) {
      setMappingsError(err instanceof Error ? err.message : 'Failed to delete mapping');
    }
    setDeleteConfirmId(null);
  };

  const handleClose = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError(null);
    setPasswordSuccess(false);
    setMappingsError(null);
    setShowAddForm(false);
    setNewDownloadedFrom('');
    setNewIsSecured(false);
    setNewFolder('');
    setNewQuality('');
    setEditingId(null);
    setEditFolder('');
    setEditQuality('');
    setCookiesError(null);
    setCookiesSuccess(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div className="relative bg-slate-800 rounded-xl border border-slate-700 shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={handleClose}
            className="p-1 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700">
          <button
            onClick={() => setActiveTab('password')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'password'
                ? 'text-cyan-400 border-b-2 border-cyan-400'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Key className="w-4 h-4" />
            Password
          </button>
          {showMappings && (
            <button
              onClick={() => setActiveTab('mappings')}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === 'mappings'
                  ? 'text-cyan-400 border-b-2 border-cyan-400'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <FolderCog className="w-4 h-4" />
              Mappings
            </button>
          )}
          <button
            onClick={() => setActiveTab('cookies')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === 'cookies'
                ? 'text-cyan-400 border-b-2 border-cyan-400'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Cookie className="w-4 h-4" />
            Cookies
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto flex-1">
          {activeTab === 'password' && (
            <>
              {/* Success message */}
              {passwordSuccess && (
                <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/50 rounded-lg p-3 mb-4 text-green-400 text-sm">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span>Password updated successfully</span>
                </div>
              )}

              {/* Error message */}
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
              {/* Error message */}
              {mappingsError && (
                <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{mappingsError}</span>
                </div>
              )}

              {/* Description */}
              <p className="text-sm text-slate-400 mb-4">
                Configure download sources. Secured sources are hidden from the download list.
              </p>

              {/* Add button */}
              {!showAddForm && (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="flex items-center gap-2 text-sm text-cyan-400 hover:text-cyan-300 mb-4"
                >
                  <Plus className="w-4 h-4" />
                  Add Mapping
                </button>
              )}

              {/* Add form */}
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

              {/* Mappings list */}
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
                        // Edit mode
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
                        // View mode
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
              {/* Success message */}
              {cookiesSuccess && (
                <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/50 rounded-lg p-3 mb-4 text-green-400 text-sm">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  <span>Cookies saved successfully</span>
                </div>
              )}

              {/* Error message */}
              {cookiesError && (
                <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{cookiesError}</span>
                </div>
              )}

              {/* Description */}
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

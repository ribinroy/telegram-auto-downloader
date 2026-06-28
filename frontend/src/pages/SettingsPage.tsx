import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, CheckCircle, Key, Globe, Cookie, Wrench, Server, Send, TerminalSquare, Users } from 'lucide-react';
import type { SyncThumbnailsResult } from '../api';
import { useCookies, useSaveCookies, useSyncThumbnails, useYtdlpVersion, useUpgradeYtdlp } from '../hooks/useSettings';
import { useUpdatePassword } from '../hooks/useMisc';
import { VpsSettings } from '../components/VpsSettings';
import { SourcesSettings } from '../components/SourcesSettings';
import { TelegramSettings } from '../components/TelegramSettings';
import { QueriesSettings } from '../components/QueriesSettings';
import { UsersSettings } from '../components/UsersSettings';
import { useLayoutContext } from '../components/Layout';
import { settingsTab } from '../routes';

type TabType = 'password' | 'sources' | 'cookies' | 'jobs' | 'vps' | 'telegram' | 'queries' | 'users';
const TAB_IDS: TabType[] = ['password', 'sources', 'cookies', 'telegram', 'queries', 'users', 'vps', 'jobs'];

export function SettingsPage() {
  const { refreshDownloads } = useLayoutContext();
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const isValidTab = (t?: string): t is TabType => !!t && (TAB_IDS as string[]).includes(t);
  const [activeTab, setActiveTab] = useState<TabType>(isValidTab(tab) ? tab : 'password');

  // Keep the active tab in sync with the URL (/settings/:tab)
  useEffect(() => {
    if (isValidTab(tab)) setActiveTab(tab);
    else if (!tab) setActiveTab('password');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Navigate to a tab's unique URL (also updates activeTab via the effect)
  const goToTab = (id: TabType) => navigate(settingsTab(id));

  // Mutations / queries
  const passwordMut = useUpdatePassword();
  const cookiesQuery = useCookies(activeTab === 'cookies');
  const saveCookiesMut = useSaveCookies();
  const syncMut = useSyncThumbnails();
  const ytdlpQuery = useYtdlpVersion(activeTab === 'jobs');
  const upgradeMut = useUpgradeYtdlp();

  // Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const passwordLoading = passwordMut.isPending;

  // Cookies state (editable; seeded from the query)
  const [cookiesContent, setCookiesContent] = useState('');
  const [cookiesError, setCookiesError] = useState<string | null>(null);
  const [cookiesSuccess, setCookiesSuccess] = useState(false);
  const cookiesLoading = cookiesQuery.isLoading;
  const cookiesSaving = saveCookiesMut.isPending;

  // Jobs state
  const [syncResult, setSyncResult] = useState<SyncThumbnailsResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncRunning = syncMut.isPending;

  // yt-dlp upgrade state
  const [ytdlpResult, setYtdlpResult] = useState<{ old_version?: string; new_version?: string; upgraded?: boolean } | null>(null);
  const [ytdlpError, setYtdlpError] = useState<string | null>(null);
  const ytdlpUpgrading = upgradeMut.isPending;
  const ytdlpVersion = ytdlpResult?.new_version ?? ytdlpQuery.data?.version ?? null;

  // Seed the editable cookies textarea when the query resolves.
  useEffect(() => {
    if (cookiesQuery.data !== undefined) setCookiesContent(cookiesQuery.data);
  }, [cookiesQuery.data]);

  const handleSaveCookies = async () => {
    setCookiesError(null);
    setCookiesSuccess(false);
    try {
      const result = await saveCookiesMut.mutateAsync(cookiesContent);
      if (result.error) {
        setCookiesError(result.error);
      } else {
        setCookiesSuccess(true);
        setTimeout(() => setCookiesSuccess(false), 3000);
      }
    } catch {
      setCookiesError('Failed to save cookies');
    }
  };

  const handleYtdlpUpgrade = async () => {
    setYtdlpError(null);
    setYtdlpResult(null);
    try {
      const result = await upgradeMut.mutateAsync();
      if (result.error) setYtdlpError(result.error);
      else setYtdlpResult(result);
    } catch {
      setYtdlpError('Failed to upgrade yt-dlp');
    }
  };

  const handleSyncThumbnails = async () => {
    setSyncError(null);
    setSyncResult(null);
    try {
      setSyncResult(await syncMut.mutateAsync());
    } catch {
      setSyncError('Failed to run thumbnail sync');
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

    try {
      await passwordMut.mutateAsync({ currentPassword, newPassword });
      setPasswordSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to update password');
    }
  };

  const tabs: { id: TabType; label: string; description: string; icon: typeof Key; show: boolean }[] = [
    { id: 'password', label: 'Password', description: 'Change your account password', icon: Key, show: true },
    { id: 'sources', label: 'Sources', description: 'Per-source folders & defaults', icon: Globe, show: true },
    { id: 'cookies', label: 'Cookies', description: 'yt-dlp browser cookies', icon: Cookie, show: true },
    { id: 'telegram', label: 'Telegram', description: 'Account login & monitored channels', icon: Send, show: true },
    { id: 'queries', label: 'Queries', description: 'Bot chat commands', icon: TerminalSquare, show: true },
    { id: 'users', label: 'Users', description: 'Roles & bot access', icon: Users, show: true },
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
                onClick={() => goToTab(tab.id)}
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
          {activeTab !== 'vps' && (
            <div className="hidden md:flex items-center gap-2 mb-5 pb-4 border-b border-slate-700/60">
              <activeTabMeta.icon className="w-5 h-5 text-cyan-400" />
              <div>
                <h2 className="text-base font-semibold text-white leading-tight">{activeTabMeta.label}</h2>
                <p className="text-xs text-slate-400">{activeTabMeta.description}</p>
              </div>
            </div>
          )}
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

        {activeTab === 'sources' && <SourcesSettings onChange={refreshDownloads} />}

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

        {activeTab === 'telegram' && <TelegramSettings />}

        {activeTab === 'queries' && <QueriesSettings />}

        {activeTab === 'users' && <UsersSettings />}

        {activeTab === 'vps' && <VpsSettings onChange={refreshDownloads} />}

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
    </div>
  );
}

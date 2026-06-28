import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, CheckCircle, Send, LogOut, Plus, Trash2, Radio, Search, RefreshCw, KeyRound } from 'lucide-react';
import { fetchTelegramDialogs } from '../api';
import type { TelegramChannel, TelegramDialog, TorrentClient } from '../api';
import {
  useTelegramStatus, useTelegramApiConfig,
  useSendTelegramCode, useVerifyTelegramCode, useVerifyTelegramPassword,
  useTelegramBotLogin, useTelegramLogout, useAddTelegramChannel, useRemoveTelegramChannel,
  useSetChannelTorrentClient, useSaveTelegramApiConfig,
} from '../hooks/useTelegram';
import { useTorrentConfig } from '../hooks/useTorrents';
import { ConfirmDialog } from './ConfirmDialog';

type LoginStep = 'phone' | 'code' | 'password';

export function TelegramSettings() {
  const statusQuery = useTelegramStatus();
  const status = statusQuery.data ?? null;
  const apiConfig = useTelegramApiConfig().data ?? null;
  const torrentConfig = useTorrentConfig().data ?? null;
  const channels = status?.channels ?? [];
  const loading = statusQuery.isLoading;

  const sendCodeMut = useSendTelegramCode();
  const verifyCodeMut = useVerifyTelegramCode();
  const verifyPasswordMut = useVerifyTelegramPassword();
  const botLoginMut = useTelegramBotLogin();
  const logoutMut = useTelegramLogout();
  const addChannelMut = useAddTelegramChannel();
  const removeChannelMut = useRemoveTelegramChannel();
  const setChannelClientMut = useSetChannelTorrentClient();
  const saveApiMut = useSaveTelegramApiConfig();

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Login wizard state
  const [loginMode, setLoginMode] = useState<'phone' | 'bot'>('phone');
  const [step, setStep] = useState<LoginStep>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [botToken, setBotToken] = useState('');
  const submitting = sendCodeMut.isPending || verifyCodeMut.isPending || verifyPasswordMut.isPending || botLoginMut.isPending;

  // Channels state
  const [newChannel, setNewChannel] = useState('');
  const addingChannel = addChannelMut.isPending;
  const [removeTarget, setRemoveTarget] = useState<TelegramChannel | null>(null);
  const [logoutConfirm, setLogoutConfirm] = useState(false);

  // Dialog picker state (loaded on demand)
  const [dialogs, setDialogs] = useState<TelegramDialog[] | null>(null);
  const [dialogsLoading, setDialogsLoading] = useState(false);
  const [dialogSearch, setDialogSearch] = useState('');

  // API credentials state
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [showApiForm, setShowApiForm] = useState(false);
  const apiSaving = saveApiMut.isPending;

  // Seed API form + surface status errors when the queries resolve.
  useEffect(() => {
    if (apiConfig) {
      setApiId(apiConfig.api_id ? String(apiConfig.api_id) : '');
      setShowApiForm(!apiConfig.configured);
    }
  }, [apiConfig]);
  useEffect(() => { if (status?.error) setError(status.error); }, [status?.error]);

  const flashSuccess = (msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 4000);
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await sendCodeMut.mutateAsync(phone);
      if (result.error) setError(result.error);
      else {
        setStep('code');
        flashSuccess('Code sent — check your Telegram app (or SMS)');
      }
    } catch {
      setError('Failed to send code');
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await verifyCodeMut.mutateAsync(code);
      if (result.error) setError(result.error);
      else if (result.status === 'password_required') setStep('password');
      else {
        flashSuccess('Connected to Telegram');
        setStep('phone');
        setCode('');
      }
    } catch {
      setError('Failed to verify code');
    }
  };

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await verifyPasswordMut.mutateAsync(password);
      if (result.error) setError(result.error);
      else {
        flashSuccess('Connected to Telegram');
        setStep('phone');
        setCode('');
        setPassword('');
      }
    } catch {
      setError('Failed to verify password');
    }
  };

  const handleBotLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await botLoginMut.mutateAsync(botToken);
      if (result.error) setError(result.error);
      else {
        flashSuccess('Connected as bot');
        setBotToken('');
      }
    } catch {
      setError('Failed to sign in with bot token');
    }
  };

  const handleLogout = async () => {
    setLogoutConfirm(false);
    setError(null);
    try {
      const result = await logoutMut.mutateAsync();
      if (result.error) setError(result.error);
      else {
        flashSuccess('Logged out of Telegram');
        setDialogs(null);
      }
    } catch {
      setError('Failed to log out');
    }
  };

  const handleAddChannel = async (chat: string) => {
    setError(null);
    try {
      const result = await addChannelMut.mutateAsync(chat);
      if (result.error) setError(result.error);
      else if (result.channels) {
        setNewChannel('');
        flashSuccess('Channel added — new files will be downloaded automatically');
        if (dialogs) {
          setDialogs(dialogs.map(d =>
            result.channels!.some(c => c.id === d.id) ? { ...d, monitored: true } : d));
        }
      }
    } catch {
      setError('Failed to add channel');
    }
  };

  const handleRemoveChannel = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    setError(null);
    try {
      const result = await removeChannelMut.mutateAsync(target.id);
      if (result.error) setError(result.error);
      else if (result.channels && dialogs) {
        setDialogs(dialogs.map(d => (d.id === target.id ? { ...d, monitored: false } : d)));
      }
    } catch {
      setError('Failed to remove channel');
    }
  };

  const handleChannelClientChange = async (channel: TelegramChannel, client: TorrentClient | null) => {
    setError(null);
    try {
      const result = await setChannelClientMut.mutateAsync({ chatId: channel.id, client });
      if (result.error) setError(result.error);
    } catch {
      setError('Failed to update the channel torrent client');
    }
  };

  const handleSaveApi = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await saveApiMut.mutateAsync({ apiId: apiId.trim(), apiHash: apiHash.trim() });
      if (result.error) setError(result.error);
      else {
        setApiHash('');
        flashSuccess('API credentials saved — the client reconnected with them');
        setStep('phone');
        // Give the client a moment to reconnect, then refresh status.
        setTimeout(() => statusQuery.refetch(), 1500);
      }
    } catch {
      setError('Failed to save API credentials');
    }
  };

  const loadDialogs = async () => {
    setDialogsLoading(true);
    setError(null);
    try {
      const result = await fetchTelegramDialogs();
      if (result.error) setError(result.error);
      else setDialogs(result.dialogs || []);
    } catch {
      setError('Failed to load your chats');
    } finally {
      setDialogsLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
      </div>
    );
  }

  const authorized = !!status?.authorized;
  const isBot = !!status?.user?.is_bot;
  const filteredDialogs = (dialogs || []).filter(d =>
    d.type !== 'user' &&
    (!dialogSearch || d.title.toLowerCase().includes(dialogSearch.toLowerCase()) ||
      (d.username || '').toLowerCase().includes(dialogSearch.toLowerCase())));

  return (
    <div className="space-y-4">
      {success && (
        <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/50 rounded-lg p-3 text-green-400 text-sm">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Connection status / account */}
      <div className="bg-slate-700/30 rounded-lg p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${authorized ? 'bg-green-400' : status?.connected ? 'bg-amber-400' : 'bg-red-400'}`} />
            <div className="min-w-0">
              {authorized && status?.user ? (
                <>
                  <h3 className="text-white font-medium text-sm truncate flex items-center gap-2">
                    {[status.user.first_name, status.user.last_name].filter(Boolean).join(' ') || status.user.username || 'Telegram account'}
                    {status.user.is_bot && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide bg-purple-500/20 text-purple-300 border border-purple-500/40 rounded px-1.5 py-0.5">
                        Bot
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-slate-400 truncate">
                    {status.user.username ? `@${status.user.username}` : ''}
                    {status.user.username && status.user.phone ? ' · ' : ''}
                    {status.user.phone ? `+${status.user.phone}` : ''}
                  </p>
                </>
              ) : (
                <>
                  <h3 className="text-white font-medium text-sm">
                    {status?.connected ? 'Not signed in' : 'Not connected'}
                  </h3>
                  <p className="text-xs text-slate-400">
                    {status?.connected
                      ? 'Sign in below to start monitoring channels'
                      : status?.api_configured === false
                        ? 'Add your API credentials below to get started'
                        : 'The Telegram client is not running'}
                  </p>
                </>
              )}
            </div>
          </div>
          {authorized && (
            <button
              onClick={() => setLogoutConfirm(true)}
              className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 border border-red-500/40 hover:border-red-500/70 rounded-lg px-3 py-1.5 transition-colors shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              Log out
            </button>
          )}
        </div>
      </div>

      {/* API credentials */}
      <div className="bg-slate-700/30 rounded-lg p-4">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-cyan-400" />
            <h3 className="text-white font-medium text-sm">API credentials</h3>
          </div>
          {apiConfig?.configured && !showApiForm && (
            <button
              onClick={() => setShowApiForm(true)}
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              Edit
            </button>
          )}
        </div>
        {apiConfig?.configured && !showApiForm ? (
          <p className="text-xs text-slate-400">
            API ID <span className="text-slate-300 font-mono">{apiConfig.api_id}</span>
            {' '}· hash saved · {apiConfig.source === 'env' ? 'from .env file' : 'stored in database'}
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-400 mb-3">
              Get these from{' '}
              <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-cyan-400 hover:text-cyan-300">
                my.telegram.org
              </a>{' '}
              → API development tools. The hash is stored encrypted.
            </p>
            <form onSubmit={handleSaveApi} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">API ID</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={apiId}
                    onChange={(e) => setApiId(e.target.value)}
                    placeholder="1234567"
                    className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">API hash</label>
                  <input
                    type="password"
                    value={apiHash}
                    onChange={(e) => setApiHash(e.target.value)}
                    placeholder={apiConfig?.has_hash ? '(unchanged)' : 'abcdef0123456789...'}
                    className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                    required={!apiConfig?.has_hash}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                {apiConfig?.configured && (
                  <button
                    type="button"
                    onClick={() => { setShowApiForm(false); setApiHash(''); }}
                    className="px-4 py-2 text-sm text-slate-400 hover:text-white border border-slate-600 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="submit"
                  disabled={apiSaving || !apiId.trim()}
                  className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {apiSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {apiSaving ? 'Saving...' : 'Save Credentials'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>

      {/* Login wizard */}
      {!authorized && status?.connected && (
        <div className="bg-slate-700/30 rounded-lg p-4">
          <h3 className="text-white font-medium text-sm mb-1">Sign in to Telegram</h3>
          <p className="text-xs text-slate-400 mb-4">
            Your session is stored on the server, so this only needs to be done once.
          </p>

          <div className="flex gap-1 bg-slate-800/60 rounded-lg p-1 mb-4 w-fit">
            {(['phone', 'bot'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => { setLoginMode(mode); setStep('phone'); setError(null); }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  loginMode === mode ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {mode === 'phone' ? 'User account' : 'Bot token'}
              </button>
            ))}
          </div>

          {loginMode === 'bot' && (
            <form onSubmit={handleBotLogin} className="space-y-3">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Bot token (from @BotFather)</label>
                <input
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="123456789:AbCdEf..."
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  required
                />
              </div>
              <p className="text-xs text-amber-400/80">
                The bot must be a member of every monitored group, and either be an admin or have
                privacy mode disabled (BotFather → /setprivacy), otherwise it won't see other
                members' messages. Bots also can't browse chats — add channels by @username or ID.
              </p>
              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {submitting ? 'Signing in...' : 'Sign In as Bot'}
              </button>
            </form>
          )}

          {loginMode === 'phone' && step === 'phone' && (
            <form onSubmit={handleSendCode} className="space-y-3">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Phone number</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+49123456789"
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {submitting ? 'Sending...' : 'Send Code'}
              </button>
            </form>
          )}

          {loginMode === 'phone' && step === 'code' && (
            <form onSubmit={handleVerifyCode} className="space-y-3">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Login code sent to {phone}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="12345"
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors tracking-widest"
                  autoFocus
                  required
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setStep('phone'); setCode(''); }}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-white border border-slate-600 rounded-lg transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {submitting ? 'Verifying...' : 'Verify Code'}
                </button>
              </div>
            </form>
          )}

          {loginMode === 'phone' && step === 'password' && (
            <form onSubmit={handleVerifyPassword} className="space-y-3">
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Two-factor password (your Telegram cloud password)
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  autoFocus
                  required
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                {submitting ? 'Verifying...' : 'Sign In'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Monitored channels */}
      {authorized && (
        <div className="bg-slate-700/30 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <Radio className="w-4 h-4 text-cyan-400" />
            <h3 className="text-white font-medium text-sm">Monitored channels</h3>
          </div>
          <p className="text-xs text-slate-400 mb-4">
            New files posted in these chats are downloaded automatically.
            {isBot && (
              <span className="block mt-1 text-amber-400/80">
                You are signed in as a bot: it must be a member of each of these groups, and an
                admin (or have privacy mode disabled via BotFather) to see other members' messages.
              </span>
            )}
          </p>

          {channels.length === 0 ? (
            <p className="text-sm text-slate-500 mb-3">No channels are being monitored yet.</p>
          ) : (
            <ul className="space-y-2 mb-4">
              {channels.map(c => {
                const transmissionOn = !!torrentConfig?.transmission?.configured;
                const qbittorrentOn = !!torrentConfig?.qbittorrent?.configured;
                const anyClient = transmissionOn || qbittorrentOn;
                return (
                  <li key={c.id} className="flex items-center justify-between gap-2 bg-slate-800/50 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{c.title}</p>
                      <p className="text-xs text-slate-500">{c.id}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {anyClient && (
                        <select
                          value={c.torrent_client ?? ''}
                          onChange={(e) => handleChannelClientChange(c, (e.target.value || null) as TorrentClient | null)}
                          title="Torrent client for magnets posted in this channel"
                          className="bg-slate-700/50 border border-slate-600 rounded-lg py-1 px-1.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition-colors max-w-[130px]"
                        >
                          <option value="">Default magnet client</option>
                          {transmissionOn && <option value="transmission">Transmission</option>}
                          {qbittorrentOn && <option value="qbittorrent">qBittorrent</option>}
                        </select>
                      )}
                      <button
                        onClick={() => setRemoveTarget(c)}
                        className="text-slate-500 hover:text-red-400 transition-colors"
                        title="Stop monitoring"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); if (newChannel.trim()) handleAddChannel(newChannel.trim()); }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={newChannel}
              onChange={(e) => setNewChannel(e.target.value)}
              placeholder="@channelname, t.me link, or chat ID"
              className="flex-1 bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors text-sm"
            />
            <button
              type="submit"
              disabled={addingChannel || !newChannel.trim()}
              className="bg-cyan-600 hover:bg-cyan-700 text-white font-medium px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-sm"
            >
              {addingChannel ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add
            </button>
          </form>

          {/* Dialog picker (user accounts only — bots can't list their chats) */}
          {!isBot && (
          <div className="mt-4 pt-4 border-t border-slate-700/60">
            {dialogs === null ? (
              <button
                onClick={loadDialogs}
                disabled={dialogsLoading}
                className="flex items-center gap-2 text-sm text-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-50"
              >
                {dialogsLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Browse my channels & groups
              </button>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={dialogSearch}
                      onChange={(e) => setDialogSearch(e.target.value)}
                      placeholder="Filter chats..."
                      className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-1.5 pl-8 pr-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors text-sm"
                    />
                  </div>
                  <button
                    onClick={loadDialogs}
                    disabled={dialogsLoading}
                    className="text-slate-400 hover:text-white transition-colors disabled:opacity-50"
                    title="Refresh"
                  >
                    <RefreshCw className={`w-4 h-4 ${dialogsLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <ul className="max-h-64 overflow-y-auto space-y-1">
                  {filteredDialogs.length === 0 && (
                    <li className="text-sm text-slate-500 py-2">No channels or groups found.</li>
                  )}
                  {filteredDialogs.map(d => (
                    <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-700/40">
                      <div className="min-w-0">
                        <p className="text-sm text-white truncate">{d.title}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {d.type}{d.username ? ` · @${d.username}` : ''}
                        </p>
                      </div>
                      {d.monitored ? (
                        <span className="text-xs text-green-400 shrink-0 flex items-center gap-1">
                          <CheckCircle className="w-3.5 h-3.5" /> Monitoring
                        </span>
                      ) : (
                        <button
                          onClick={() => handleAddChannel(String(d.id))}
                          disabled={addingChannel}
                          className="text-xs text-cyan-400 hover:text-cyan-300 border border-cyan-500/40 hover:border-cyan-500/70 rounded px-2 py-1 transition-colors disabled:opacity-50 shrink-0"
                        >
                          Monitor
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!removeTarget}
        title="Stop monitoring channel?"
        message={`New files posted in "${removeTarget?.title ?? ''}" will no longer be downloaded. Existing downloads are kept.`}
        confirmText="Remove"
        onConfirm={handleRemoveChannel}
        onCancel={() => setRemoveTarget(null)}
      />
      <ConfirmDialog
        isOpen={logoutConfirm}
        title="Log out of Telegram?"
        message="The saved session will be invalidated and automatic downloads will stop until you sign in again."
        confirmText="Log out"
        onConfirm={handleLogout}
        onCancel={() => setLogoutConfirm(false)}
      />
    </div>
  );
}

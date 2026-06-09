import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, Shield, User as UserIcon, Globe, Send, RefreshCw, CheckCircle } from 'lucide-react';
import { fetchUsers, updateUserRole, syncUsers } from '../api';
import type { AppUser } from '../api';

export function UsersSettings() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<number | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const result = await syncUsers();
      if (result.error) setError(result.error);
      else {
        if (result.users) setUsers(result.users);
        setSyncResult(result.synced ?? 0);
        setTimeout(() => setSyncResult(null), 5000);
      }
    } catch {
      setError('Failed to sync group members');
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchUsers()
      .then(r => setUsers(r.users || []))
      .catch(() => setError('Failed to load users'))
      .finally(() => setLoading(false));
  }, []);

  const handleRoleChange = async (user: AppUser, role: 'admin' | 'user') => {
    if (role === user.role) return;
    setSavingId(user.id);
    setError(null);
    try {
      const result = await updateUserRole(user.id, role);
      if (result.error) setError(result.error);
      else if (result.user) {
        setUsers(prev => prev.map(u => (u.id === user.id ? result.user! : u)));
      }
    } catch {
      setError('Failed to update role');
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-slate-400">
          Web login accounts, members of the monitored groups, and everyone who has
          messaged where the bot can see. Only <span className="text-cyan-400">admins</span> can
          run bot queries — new Telegram users start as regular users.
        </p>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 border border-cyan-500/40 hover:border-cyan-500/70 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 shrink-0"
          title="Register all current members of the monitored groups"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing...' : 'Sync members'}
        </button>
      </div>

      {syncResult !== null && (
        <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/50 rounded-lg p-3 text-green-400 text-sm">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>Synced {syncResult} group member(s)</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <ul className="space-y-2">
        {users.map(u => (
          <li key={u.id} className="flex items-center justify-between gap-3 bg-slate-700/30 rounded-lg px-3 py-2.5">
            <div className="flex items-center gap-3 min-w-0">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${u.role === 'admin' ? 'bg-cyan-500/20 text-cyan-400' : 'bg-slate-600/40 text-slate-400'}`}>
                {u.role === 'admin' ? <Shield className="w-4 h-4" /> : <UserIcon className="w-4 h-4" />}
              </div>
              <div className="min-w-0">
                <p className="text-sm text-white truncate flex items-center gap-1.5">
                  {u.display_name || u.username}
                  {u.is_web ? (
                    <span title="Web login account"><Globe className="w-3 h-3 text-slate-500" /></span>
                  ) : (
                    <span title="Telegram user"><Send className="w-3 h-3 text-slate-500" /></span>
                  )}
                </p>
                <p className="text-xs text-slate-500 truncate">
                  @{u.username}
                  {u.telegram_id ? ` · ${u.telegram_id}` : ''}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {savingId === u.id && <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />}
              {u.is_web ? (
                <span className="text-xs text-slate-500 px-2 py-1.5" title="Web login users are always admins">admin</span>
              ) : (
                <select
                  value={u.role}
                  onChange={(e) => handleRoleChange(u, e.target.value as 'admin' | 'user')}
                  disabled={savingId !== null}
                  className="bg-slate-700/50 border border-slate-600 rounded-lg py-1.5 px-2 text-xs text-white focus:outline-none focus:border-cyan-500 disabled:opacity-50"
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              )}
            </div>
          </li>
        ))}
      </ul>

      {users.every(u => u.is_web) && (
        <p className="text-xs text-slate-500">
          Telegram users appear here automatically after they tag or DM the bot.
        </p>
      )}
    </div>
  );
}

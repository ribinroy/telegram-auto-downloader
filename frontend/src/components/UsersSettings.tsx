import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, Shield, User as UserIcon, Globe, Send } from 'lucide-react';
import { fetchUsers, updateUserRole } from '../api';
import type { AppUser } from '../api';

export function UsersSettings() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);

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
      <p className="text-sm text-slate-400">
        Web login accounts and everyone who has interacted with the Telegram bot.
        Only <span className="text-cyan-400">admins</span> can run bot queries — new
        Telegram users start as regular users.
      </p>

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

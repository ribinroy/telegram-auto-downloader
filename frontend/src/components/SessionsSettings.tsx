import { useEffect, useState } from 'react';
import { Loader2, LogOut, Monitor, ShieldOff, Trash2 } from 'lucide-react';
import { fetchSessions, revokeSession, logoutEverywhere, type AuthSession } from '../api';

/** Turn a User-Agent string into something a person can recognise. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const os =
    /Android/i.test(userAgent) ? 'Android' :
    /iPhone|iPad|iPod/i.test(userAgent) ? 'iOS' :
    /Mac OS X|Macintosh/i.test(userAgent) ? 'macOS' :
    /Windows/i.test(userAgent) ? 'Windows' :
    /Linux/i.test(userAgent) ? 'Linux' : null;
  const browser =
    /Edg\//i.test(userAgent) ? 'Edge' :
    /OPR\//i.test(userAgent) ? 'Opera' :
    /Firefox\//i.test(userAgent) ? 'Firefox' :
    /Chrome\//i.test(userAgent) ? 'Chrome' :
    /Safari\//i.test(userAgent) ? 'Safari' : null;
  if (os && browser) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'unknown';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SessionsSettings({ onSignedOut }: { onSignedOut: () => void }) {
  const [sessions, setSessions] = useState<AuthSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | 'all' | null>(null);

  const load = async () => {
    try {
      const data = await fetchSessions();
      setSessions(data.sessions);
      setError(null);
    } catch {
      setError('Could not load your active sessions');
    }
  };

  useEffect(() => { load(); }, []);

  const handleRevoke = async (id: number) => {
    setBusy(id);
    try {
      await revokeSession(id);
      await load();
    } catch {
      setError('Could not sign that device out');
    } finally {
      setBusy(null);
    }
  };

  const handleRevokeAll = async () => {
    setBusy('all');
    try {
      // This revokes the current session too, so the app returns to login.
      await logoutEverywhere();
      onSignedOut();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-8 border-t border-slate-700/50 pt-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-white font-medium flex items-center gap-2">
            <Monitor className="w-4 h-4 text-cyan-400" />
            Active sessions
          </h3>
          <p className="text-slate-400 text-sm mt-1">
            Every browser or device signed in to DownLee. Signing one out revokes
            its token immediately.
          </p>
        </div>
        <button
          onClick={handleRevokeAll}
          disabled={busy !== null}
          className="shrink-0 flex items-center gap-2 text-sm bg-red-500/10 hover:bg-red-500/20 border border-red-500/40 text-red-400 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
        >
          {busy === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldOff className="w-4 h-4" />}
          Sign out everywhere
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/40 rounded-lg p-3 mb-3">
          {error}
        </div>
      )}

      {sessions === null ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-3">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading sessions...
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-slate-400 text-sm py-3">No active sessions.</p>
      ) : (
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 bg-slate-700/30 border border-slate-600/50 rounded-lg px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-white truncate">{describeDevice(s.user_agent)}</p>
                <p className="text-xs text-slate-400 truncate">
                  {s.ip || 'unknown IP'} · last used {formatWhen(s.last_used_at)}
                </p>
              </div>
              <button
                onClick={() => handleRevoke(s.id)}
                disabled={busy !== null}
                title="Sign this device out"
                className="shrink-0 p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                {busy === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-slate-500 mt-3 flex items-center gap-1.5">
        <LogOut className="w-3 h-3 shrink-0" />
        Changing your password also signs out every other device.
      </p>
    </div>
  );
}

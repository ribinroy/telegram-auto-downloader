import { useState } from 'react';
import { Loader2, AlertCircle, Phone, KeyRound, Lock, CheckCircle2, MessageSquare } from 'lucide-react';
import {
  checkTelegramAuth,
  sendTelegramCode,
  verifyTelegramCode,
  verifyTelegramPassword,
} from '../api';
import type { TelegramUser } from '../api';

type Step = 'phone' | 'code' | 'password' | 'success';

interface TelegramSetupProps {
  onComplete: () => void;
}

export function TelegramSetup({ onComplete }: TelegramSetupProps) {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<TelegramUser | null>(null);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await sendTelegramCode(phone);

      if (result.already_authenticated) {
        // Already logged in, check status
        const status = await checkTelegramAuth();
        if (status.authenticated && status.user) {
          setUser(status.user);
          setStep('success');
        }
      } else if (result.success) {
        setStep('code');
      } else {
        setError(result.error || 'Failed to send code');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await verifyTelegramCode(code);

      if (result.needs_password) {
        setStep('password');
      } else if (result.success && result.user) {
        setUser(result.user);
        setStep('success');
      } else {
        setError(result.error || 'Invalid code');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await verifyTelegramPassword(password);

      if (result.success && result.user) {
        setUser(result.user);
        setStep('success');
      } else {
        setError(result.error || 'Invalid password');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = () => {
    onComplete();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-slate-800/50 rounded-2xl p-8 border border-slate-700/50 shadow-xl">
          {/* Header */}
          <div className="flex flex-col items-center mb-8">
            <div className="p-4 rounded-xl mb-4">
              <img src="/logo.png" alt="DownLee logo" className="w-16 h-16" />
            </div>
            <h1 className="text-2xl font-bold text-white">Telegram Setup</h1>
            <p className="text-slate-400 text-sm mt-1 text-center">
              Connect your Telegram account to enable auto-downloads
            </p>
          </div>

          {/* Progress Steps */}
          <div className="flex items-center justify-center gap-2 mb-8">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
              step === 'phone' ? 'bg-cyan-500 text-white' :
              ['code', 'password', 'success'].includes(step) ? 'bg-green-500 text-white' : 'bg-slate-700 text-slate-400'
            }`}>
              <Phone className="w-4 h-4" />
            </div>
            <div className={`w-8 h-0.5 ${['code', 'password', 'success'].includes(step) ? 'bg-green-500' : 'bg-slate-700'}`} />
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
              step === 'code' ? 'bg-cyan-500 text-white' :
              ['password', 'success'].includes(step) ? 'bg-green-500 text-white' : 'bg-slate-700 text-slate-400'
            }`}>
              <KeyRound className="w-4 h-4" />
            </div>
            <div className={`w-8 h-0.5 ${['password', 'success'].includes(step) ? 'bg-green-500' : 'bg-slate-700'}`} />
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
              step === 'password' ? 'bg-cyan-500 text-white' :
              step === 'success' ? 'bg-green-500 text-white' : 'bg-slate-700 text-slate-400'
            }`}>
              <Lock className="w-4 h-4" />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-6 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Phone Step */}
          {step === 'phone' && (
            <form onSubmit={handleSendCode} className="space-y-4">
              <div>
                <label htmlFor="phone" className="block text-sm font-medium text-slate-300 mb-1.5">
                  Phone Number
                </label>
                <input
                  id="phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2.5 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  placeholder="+1234567890"
                  required
                  autoFocus
                />
                <p className="text-xs text-slate-500 mt-1">
                  Include country code (e.g., +1 for US)
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white font-medium py-2.5 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending code...
                  </>
                ) : (
                  <>
                    <MessageSquare className="w-4 h-4" />
                    Send Code
                  </>
                )}
              </button>
            </form>
          )}

          {/* Code Step */}
          {step === 'code' && (
            <form onSubmit={handleVerifyCode} className="space-y-4">
              <div className="bg-slate-700/30 rounded-lg p-3 mb-4">
                <p className="text-sm text-slate-300">
                  A verification code was sent to <span className="text-cyan-400 font-medium">{phone}</span>
                </p>
              </div>

              <div>
                <label htmlFor="code" className="block text-sm font-medium text-slate-300 mb-1.5">
                  Verification Code
                </label>
                <input
                  id="code"
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2.5 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors text-center text-2xl tracking-widest"
                  placeholder="12345"
                  required
                  autoFocus
                  maxLength={6}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white font-medium py-2.5 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <KeyRound className="w-4 h-4" />
                    Verify Code
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => { setStep('phone'); setError(null); }}
                className="w-full text-slate-400 hover:text-white text-sm py-2"
              >
                Use different number
              </button>
            </form>
          )}

          {/* Password Step (2FA) */}
          {step === 'password' && (
            <form onSubmit={handleVerifyPassword} className="space-y-4">
              <div className="bg-slate-700/30 rounded-lg p-3 mb-4">
                <p className="text-sm text-slate-300">
                  Your account has Two-Factor Authentication enabled. Please enter your password.
                </p>
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-1.5">
                  2FA Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2.5 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  placeholder="Enter your 2FA password"
                  required
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white font-medium py-2.5 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4" />
                    Verify Password
                  </>
                )}
              </button>
            </form>
          )}

          {/* Success Step */}
          {step === 'success' && (
            <div className="text-center space-y-6">
              <div className="flex justify-center">
                <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-green-500" />
                </div>
              </div>

              <div>
                <h2 className="text-xl font-semibold text-white mb-2">Connected!</h2>
                {user && (
                  <p className="text-slate-400">
                    Logged in as <span className="text-cyan-400 font-medium">{user.first_name}</span>
                    {user.username && <span className="text-slate-500"> (@{user.username})</span>}
                  </p>
                )}
              </div>

              <div className="bg-slate-700/30 rounded-lg p-4 text-left">
                <p className="text-sm text-slate-300 mb-2">
                  <strong>Important:</strong> You need to restart the application for Telegram downloads to start working.
                </p>
                <p className="text-xs text-slate-500">
                  Run: <code className="bg-slate-800 px-1 rounded">sudo systemctl restart downlee</code>
                </p>
              </div>

              <button
                onClick={handleContinue}
                className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-medium py-2.5 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4" />
                Continue to Dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

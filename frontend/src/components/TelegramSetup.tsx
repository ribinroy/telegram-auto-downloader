import { useState, useEffect } from 'react';
import { Loader2, AlertCircle, Phone, KeyRound, Lock, CheckCircle2, MessageSquare, Settings2, ExternalLink } from 'lucide-react';
import {
  sendTelegramCode,
  verifyTelegramCode,
  verifyTelegramPassword,
  getTelegramConfig,
  saveTelegramConfig,
} from '../api';
import type { TelegramUser } from '../api';

type Step = 'config' | 'phone' | 'code' | 'password' | 'success';

interface TelegramSetupProps {
  onComplete: () => void;
}

export function TelegramSetup({ onComplete }: TelegramSetupProps) {
  const [step, setStep] = useState<Step>('config');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [chatId, setChatId] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingConfig, setCheckingConfig] = useState(true);
  const [user, setUser] = useState<TelegramUser | null>(null);

  // Check if config exists on mount
  useEffect(() => {
    const checkConfig = async () => {
      try {
        const config = await getTelegramConfig();
        if (config.configured) {
          // Config exists, skip to phone step
          setStep('phone');
        }
      } catch {
        // Config doesn't exist, stay on config step
      } finally {
        setCheckingConfig(false);
      }
    };
    checkConfig();
  }, []);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await saveTelegramConfig(
        parseInt(apiId),
        apiHash,
        parseInt(chatId)
      );

      if (result.error) {
        setError(result.error);
      } else {
        setStep('phone');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setLoading(false);
    }
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await sendTelegramCode(phone);

      if (result.already_authenticated && result.user) {
        // Already logged in, use user info from response
        setUser(result.user);
        setStep('success');
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

  if (checkingConfig) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
      </div>
    );
  }

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
              {step === 'config'
                ? 'Configure your Telegram API credentials'
                : 'Connect your Telegram account to enable auto-downloads'}
            </p>
          </div>

          {/* Progress Steps */}
          <div className="flex items-center justify-center gap-2 mb-8">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
              step === 'config' ? 'bg-cyan-500 text-white' :
              ['phone', 'code', 'password', 'success'].includes(step) ? 'bg-green-500 text-white' : 'bg-slate-700 text-slate-400'
            }`}>
              <Settings2 className="w-4 h-4" />
            </div>
            <div className={`w-8 h-0.5 ${['phone', 'code', 'password', 'success'].includes(step) ? 'bg-green-500' : 'bg-slate-700'}`} />
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

          {/* Config Step */}
          {step === 'config' && (
            <form onSubmit={handleSaveConfig} className="space-y-4">
              <div className="bg-slate-700/30 rounded-lg p-3 mb-4">
                <p className="text-sm text-slate-300">
                  Get your API credentials from{' '}
                  <a
                    href="https://my.telegram.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                  >
                    my.telegram.org
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
              </div>

              <div>
                <label htmlFor="apiId" className="block text-sm font-medium text-slate-300 mb-1.5">
                  API ID
                </label>
                <input
                  id="apiId"
                  type="text"
                  value={apiId}
                  onChange={(e) => setApiId(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2.5 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  placeholder="12345678"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="apiHash" className="block text-sm font-medium text-slate-300 mb-1.5">
                  API Hash
                </label>
                <input
                  id="apiHash"
                  type="text"
                  value={apiHash}
                  onChange={(e) => setApiHash(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2.5 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors font-mono text-sm"
                  placeholder="0123456789abcdef0123456789abcdef"
                  required
                />
              </div>

              <div>
                <label htmlFor="chatId" className="block text-sm font-medium text-slate-300 mb-1.5">
                  Chat ID
                </label>
                <input
                  id="chatId"
                  type="text"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  className="w-full bg-slate-700/50 border border-slate-600 rounded-lg py-2.5 px-3 text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
                  placeholder="-1001234567890"
                  required
                />
                <p className="text-xs text-slate-500 mt-1">
                  The chat/channel ID to monitor for files
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
                    Saving...
                  </>
                ) : (
                  <>
                    <Settings2 className="w-4 h-4" />
                    Save & Continue
                  </>
                )}
              </button>
            </form>
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

              <button
                type="button"
                onClick={() => { setStep('config'); setError(null); }}
                className="w-full text-slate-400 hover:text-white text-sm py-2"
              >
                Edit API credentials
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
                  Run: <code className="bg-slate-800 px-1 rounded">sudo systemctl restart telegram-downloader</code>
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

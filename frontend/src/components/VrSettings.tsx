import { useState } from 'react';
import { Check, Copy, Glasses, KeyRound, Loader2, Power, RefreshCw } from 'lucide-react';
import { useVrSettings, useRegenerateVrKey, useDisableVrKey, useSetVrIncludeSecured } from '../hooks/useMisc';
import { useErrorToast, notify } from '../lib/notify';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Settings → VR headset: the library feed HereSphere and DeoVR read. One
 * key is the credential (the apps can't log in); the two URLs are what you
 * type into the app's "Web stream" box.
 */
export function VrSettings() {
  const settings = useVrSettings();
  const regenerate = useRegenerateVrKey();
  const disable = useDisableVrKey();
  const setSecured = useSetVrIncludeSecured();
  const [confirm, setConfirm] = useState<'regenerate' | 'disable' | null>(null);
  useErrorToast(settings.error, 'Could not load the VR settings');
  useErrorToast(regenerate.error, 'Could not create a key');
  useErrorToast(disable.error, 'Could not disable the feed');
  useErrorToast(setSecured.error, 'Could not save');

  const s = settings.data;
  const busy = regenerate.isPending || disable.isPending;

  return (
    <>
      <p className="text-sm text-slate-400 mb-4">
        Watch the library in a headset. HereSphere and DeoVR (Quest, PC VR) have a
        "Web stream" box - enter the URL below and DownLee shows up inside the app, with
        the projection set per file and hardware-decoded playback, which a browser can't do
        for 8K files.
      </p>

      <div className="bg-slate-700/30 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-white font-medium text-sm flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-cyan-400" /> Access key
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {s?.enabled
                ? `Created ${s.created_at ? new Date(s.created_at).toLocaleString() : ''}. Anyone with the URL can browse and stream the library.`
                : 'No key yet - the feed is off.'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {s?.enabled && (
              <button
                onClick={() => setConfirm('disable')}
                disabled={busy}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm transition-colors disabled:opacity-50"
                title="Turn the feed off"
              >
                <Power className="w-4 h-4" /> Disable
              </button>
            )}
            <button
              onClick={() => (s?.enabled ? setConfirm('regenerate') : regenerate.mutate(undefined))}
              disabled={busy || settings.isLoading}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : s?.enabled ? <RefreshCw className="w-4 h-4" /> : <Glasses className="w-4 h-4" />}
              {s?.enabled ? 'New key' : 'Enable the feed'}
            </button>
          </div>
        </div>

        {s?.enabled && s.urls && (
          <div className="space-y-3">
            <UrlRow label="HereSphere" hint="Web stream → paste this URL. Subtitles and lens profiles included." url={s.urls.heresphere} />
            <UrlRow label="DeoVR" hint="Open the in-app browser and enter this URL." url={s.urls.deovr} />
            <label className="flex items-center gap-2 text-sm text-slate-300 pt-1">
              <input
                type="checkbox"
                checked={s.include_secured}
                disabled={setSecured.isPending}
                onChange={e => setSecured.mutate(e.target.checked)}
                className="accent-cyan-500"
              />
              Include secured sources in the feed
            </label>
          </div>
        )}

        <p className="text-xs text-slate-500 mt-3">
          The URL uses this page's address ({window.location.host}); from outside the home
          network it has to be reachable the same way. A new key invalidates the old URLs at once.
        </p>
      </div>

      <div className="bg-slate-700/30 rounded-lg p-4">
        <h3 className="text-white font-medium text-sm mb-1">What the headset gets</h3>
        <ul className="text-xs text-slate-400 space-y-1 list-disc pl-4">
          <li>Every finished video, grouped as All videos · VR · per source; secured ones only with the box above.</li>
          <li>The projection (flat, 180°/360°, side-by-side / top-bottom, fisheye lenses) guessed from the filename - or the one you picked in the web player, which is saved for the file.</li>
          <li>HereSphere also gets each file's subtitle tracks (sidecar and embedded). DeoVR's format has no subtitle field.</li>
          <li>PLAY'A and other players without a web library: they read SMB/DLNA shares, not this feed.</li>
        </ul>
      </div>

      <ConfirmDialog
        isOpen={confirm === 'regenerate'}
        title="Create a new key?"
        message="The current URLs stop working at once; every headset has to be given the new one."
        confirmText="New key"
        variant="warning"
        onConfirm={() => { setConfirm(null); regenerate.mutate(undefined); }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        isOpen={confirm === 'disable'}
        title="Disable the feed?"
        message="Headsets lose access until a new key is created."
        confirmText="Disable"
        variant="danger"
        onConfirm={() => { setConfirm(null); disable.mutate(); }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

function UrlRow({ label, hint, url }: { label: string; hint: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      notify({ type: 'error', title: 'Copy failed', message: 'Select the URL and copy it by hand.' });
    }
  };
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-white font-medium">{label}</span>
        <span className="text-xs text-slate-500 truncate">{hint}</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <code className="flex-1 min-w-0 text-xs text-cyan-300 bg-slate-900/60 rounded-lg px-3 py-2 overflow-x-auto whitespace-nowrap select-all">{url}</code>
        <button
          onClick={copy}
          className="p-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors shrink-0"
          title="Copy"
        >
          {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

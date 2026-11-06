import { authFetch } from './index';
import type { Projection } from '../utils/vr';

// The VR headset feed (HereSphere / DeoVR): one key, two URLs. See
// backend/vr.py. Also the per-download projection pick the feed and the web
// player share.

export interface VrFeedSettings {
  enabled: boolean;
  key: string | null;
  include_secured: boolean;
  created_at: string | null;
  urls: { heresphere: string; deovr: string } | null;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authFetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const fetchVrSettings = () => call<VrFeedSettings>('/api/settings/vr');

export const regenerateVrKey = (includeSecured?: boolean) =>
  call<VrFeedSettings>('/api/settings/vr', { method: 'POST', ...json({ action: 'regenerate', include_secured: includeSecured }) });

export const disableVrKey = () =>
  call<VrFeedSettings>('/api/settings/vr', { method: 'POST', ...json({ action: 'disable' }) });

export const setVrIncludeSecured = (includeSecured: boolean) =>
  call<VrFeedSettings>('/api/settings/vr', { method: 'POST', ...json({ include_secured: includeSecured }) });

export interface DownloadProjection {
  /** The user's pick, or null for "guess from the filename". */
  projection: Projection | null;
  detected: Projection;
  lens: string | null;
}

export const fetchDownloadProjection = (downloadId: number) =>
  call<DownloadProjection>(`/api/downloads/${downloadId}/projection`);

export const saveDownloadProjection = (downloadId: number, projection: Projection | null) =>
  call<{ projection: Projection | null }>(`/api/downloads/${downloadId}/projection`, { method: 'PUT', ...json({ projection }) });

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  fetchVrSettings, regenerateVrKey, disableVrKey, setVrIncludeSecured,
  fetchDownloadProjection, saveDownloadProjection,
} from './vr';
import { API_BASE, setToken } from './index';
import { jsonResponse, textResponse, stubFetch, sentRequest } from '../test/http';

const api = (path: string) => `${API_BASE}${path}`;
const settings = { enabled: true, key: 'k', include_secured: false, created_at: null, urls: { heresphere: 'h', deovr: 'd' } };

beforeEach(() => {
  localStorage.clear();
  setToken('access');
});
afterEach(() => vi.unstubAllGlobals());

describe('VR feed settings', () => {
  it.each([
    ['fetchVrSettings', () => fetchVrSettings(), 'GET', undefined],
    ['regenerateVrKey', () => regenerateVrKey(), 'POST', { action: 'regenerate' }],
    ['regenerateVrKey (with secured)', () => regenerateVrKey(true), 'POST', { action: 'regenerate', include_secured: true }],
    ['disableVrKey', () => disableVrKey(), 'POST', { action: 'disable' }],
    ['setVrIncludeSecured', () => setVrIncludeSecured(false), 'POST', { include_secured: false }],
  ])('%s', async (_name, call, method, body) => {
    const fetchMock = stubFetch(jsonResponse(settings));
    await expect(call()).resolves.toEqual(settings);
    const req = sentRequest(fetchMock);
    expect(req).toMatchObject({ url: api('/api/settings/vr'), method, body });
    expect(req.headers.Authorization).toBe('Bearer access');
    if (body) expect(req.headers['Content-Type']).toBe('application/json');
  });

  it('throws the server\'s reason, or the status when there is none', async () => {
    stubFetch(jsonResponse({ error: 'Feed disabled' }, 400));
    await expect(fetchVrSettings()).rejects.toThrow('Feed disabled');
    stubFetch(textResponse('', 503));
    await expect(disableVrKey()).rejects.toThrow('Request failed (503)');
  });
});

describe('per-download projection', () => {
  it('reads the pick, the guess and the lens', async () => {
    const fetchMock = stubFetch(jsonResponse({ projection: null, detected: '180-sbs', lens: null }));
    await expect(fetchDownloadProjection(12)).resolves.toEqual({ projection: null, detected: '180-sbs', lens: null });
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/downloads/12/projection'), method: 'GET' });
  });

  it('saves a pick, null meaning "guess from the filename"', async () => {
    const fetchMock = stubFetch(jsonResponse({ projection: '360-tb' }), jsonResponse({ projection: null }));
    await expect(saveDownloadProjection(12, '360-tb')).resolves.toEqual({ projection: '360-tb' });
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/downloads/12/projection'), method: 'PUT', body: { projection: '360-tb' } });
    await saveDownloadProjection(12, null);
    expect(sentRequest(fetchMock, 1).body).toEqual({ projection: null });
  });
});

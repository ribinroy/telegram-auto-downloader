import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fetchMediaInfo } from './mediaInfo';
import { API_BASE, setToken } from './index';
import { jsonResponse, stubFetch, sentRequest } from '../test/http';

const api = (path: string) => `${API_BASE}${path}`;
const info = { file: { name: 'a.mkv' }, container: {}, streams: [], chapters: [] };

beforeEach(() => {
  localStorage.clear();
  setToken('access');
});
afterEach(() => vi.unstubAllGlobals());

describe('fetchMediaInfo', () => {
  it('reads a download\'s details with a GET', async () => {
    const fetchMock = stubFetch(jsonResponse(info));
    await expect(fetchMediaInfo({ downloadId: 7 })).resolves.toEqual(info);
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/video/info/7'), method: 'GET' });
  });

  it('reads a file\'s details with a POST carrying the path', async () => {
    const fetchMock = stubFetch(jsonResponse(info));
    await expect(fetchMediaInfo({ path: '/mnt/a.mkv' })).resolves.toEqual(info);
    expect(sentRequest(fetchMock)).toMatchObject({
      url: api('/api/files/info'), method: 'POST', body: { path: '/mnt/a.mkv' },
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('throws the server\'s reason, or a default', async () => {
    stubFetch(jsonResponse({ error: 'Probing the file timed out' }, 504));
    await expect(fetchMediaInfo({ downloadId: 1 })).rejects.toThrow('Probing the file timed out');
    stubFetch(new Response('<html>', { status: 502 }));
    await expect(fetchMediaInfo({ path: '/x' })).rejects.toThrow('Failed to load video details');
  });
});

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { subtitleSourceKey, listSubtitleTracks, getSubtitleUrl } from './subtitles';
import { API_BASE, setToken } from './index';
import { jsonResponse, textResponse, tokenExpiringIn, stubFetch, sentRequest } from '../test/http';

const api = (path: string) => `${API_BASE}${path}`;
const tracks = [{ id: 's0', label: 'English', lang: 'en', kind: 'sidecar', format: 'srt', forced: false, default: true }];

beforeEach(() => {
  localStorage.clear();
  setToken('access');
});
afterEach(() => vi.unstubAllGlobals());

describe('subtitleSourceKey', () => {
  it('keeps a download and a path apart even with the same text', () => {
    expect(subtitleSourceKey({ downloadId: 7 })).toBe('d:7');
    expect(subtitleSourceKey({ path: '7' })).toBe('p:7');
  });
});

describe('listSubtitleTracks', () => {
  it('reads a download\'s tracks with a GET', async () => {
    const fetchMock = stubFetch(jsonResponse({ tracks }));
    await expect(listSubtitleTracks({ downloadId: 7 })).resolves.toEqual(tracks);
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/video/subtitles/7'), method: 'GET' });
  });

  it('reads a file\'s tracks with a POST carrying the path', async () => {
    const fetchMock = stubFetch(jsonResponse({ tracks }));
    await expect(listSubtitleTracks({ path: '/mnt/a.mkv' })).resolves.toEqual(tracks);
    expect(sentRequest(fetchMock)).toMatchObject({
      url: api('/api/files/subtitles'), method: 'POST', body: { path: '/mnt/a.mkv' },
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('throws the server\'s reason or a default', async () => {
    stubFetch(jsonResponse({ error: 'ffprobe missing' }, 500));
    await expect(listSubtitleTracks({ downloadId: 1 })).rejects.toThrow('ffprobe missing');
    stubFetch(textResponse('', 404));
    await expect(listSubtitleTracks({ path: '/x' })).rejects.toThrow('Failed to list subtitles');
  });
});

describe('getSubtitleUrl', () => {
  it('builds a <track> URL with the media token for either source', () => {
    const token = tokenExpiringIn(3600);
    localStorage.setItem('media_token', token);
    expect(getSubtitleUrl({ downloadId: 7 }, 'e:0')).toBe(api(`/api/video/subtitle/7?track=e%3A0&token=${token}`));
    expect(getSubtitleUrl({ path: '/mnt/a b.mkv' }, 's0')).toBe(api(`/api/files/subtitle?path=%2Fmnt%2Fa%20b.mkv&track=s0&token=${token}`));
  });

  it('leaves the token empty when there is none', () => {
    expect(getSubtitleUrl({ downloadId: 7 }, 's0')).toBe(api('/api/video/subtitle/7?track=s0&token='));
  });
});

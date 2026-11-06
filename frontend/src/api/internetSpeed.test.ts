import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  fetchInternetSpeed, startInternetSpeed, cancelInternetSpeed, isInternetRunning,
  fetchSpeedResults, recordBrowserResult, deleteSpeedResult, describeClient,
} from './internetSpeed';
import { API_BASE, setToken } from './index';
import { jsonResponse, textResponse, stubFetch, sentRequest } from '../test/http';

const api = (path: string) => `${API_BASE}${path}`;
const idle = { phase: 'idle', live_mbps: 0, progress: 0, result: null, error: null, meta: null };

beforeEach(() => {
  localStorage.clear();
  setToken('access');
});
afterEach(() => vi.unstubAllGlobals());

describe('the box\'s own uplink test', () => {
  it.each([
    ['fetchInternetSpeed', () => fetchInternetSpeed(), 'GET'],
    ['startInternetSpeed', () => startInternetSpeed(), 'POST'],
    ['cancelInternetSpeed', () => cancelInternetSpeed(), 'DELETE'],
  ])('%s never reads from the HTTP cache', async (_name, call, method) => {
    const fetchMock = stubFetch(jsonResponse(idle));
    await expect(call()).resolves.toEqual(idle);
    const req = sentRequest(fetchMock);
    expect(req).toMatchObject({ url: api('/api/speedtest/internet'), method });
    expect(req.init?.cache).toBe('no-store');
    expect(req.headers.Authorization).toBe('Bearer access');
  });

  it('throws the server\'s reason, or the status', async () => {
    stubFetch(jsonResponse({ error: 'Already running' }, 409));
    await expect(startInternetSpeed()).rejects.toThrow('Already running');
    stubFetch(textResponse('', 500));
    await expect(fetchInternetSpeed()).rejects.toThrow('Request failed (500)');
  });

  it('counts every phase between the first probe and the result as running', () => {
    expect(isInternetRunning('servers')).toBe(true);
    expect(isInternetRunning('ping')).toBe(true);
    expect(isInternetRunning('download')).toBe(true);
    expect(isInternetRunning('upload')).toBe(true);
    expect(isInternetRunning('idle')).toBe(false);
    expect(isInternetRunning('done')).toBe(false);
    expect(isInternetRunning('error')).toBe(false);
    expect(isInternetRunning(undefined)).toBe(false);
  });
});

describe('recorded results', () => {
  const row = { id: 1, kind: 'browser', at: 't', ping: { min: 1, avg: 2, max: 3, jitter: 0 }, download_mbps: 1, upload_mbps: 1, download_bytes: 1, upload_bytes: 1, client: null, ip: null, meta: null };

  it('lists the last 20 of every kind by default, unwrapping the rows', async () => {
    const fetchMock = stubFetch(jsonResponse({ results: [row] }));
    await expect(fetchSpeedResults()).resolves.toEqual([row]);
    expect(sentRequest(fetchMock).url).toBe(api('/api/speedtest/results?limit=20'));
  });

  it('filters by kind and limit', async () => {
    const fetchMock = stubFetch(jsonResponse({ results: [] }));
    await fetchSpeedResults('internet', 5);
    expect(sentRequest(fetchMock).url).toBe(api('/api/speedtest/results?limit=5&kind=internet'));
  });

  it('records a browser run and deletes a row', async () => {
    const input = { ping: row.ping, download_mbps: 900, upload_mbps: 400, download_bytes: 1e9, upload_bytes: 4e8 };
    const fetchMock = stubFetch(jsonResponse(row), jsonResponse({ deleted: true }));
    await expect(recordBrowserResult(input)).resolves.toEqual(row);
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/speedtest/results'), method: 'POST', body: input, headers: { 'Content-Type': 'application/json' } });
    await expect(deleteSpeedResult(1)).resolves.toEqual({ deleted: true });
    expect(sentRequest(fetchMock, 1)).toMatchObject({ url: api('/api/speedtest/results/1'), method: 'DELETE' });
  });
});

describe('describeClient', () => {
  it.each([
    ['nothing', null, '—'],
    ['Chrome on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Chrome · macOS'],
    ['Edge on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge · Windows'],
    ['Opera on Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', 'Opera · Linux'],
    ['Firefox on Linux', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox · Linux'],
    ['Safari on an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 'Safari · iPhone'],
    ['Safari on an iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1', 'Safari · iPad'],
    ['Chrome on Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['the Quest browser', 'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36 OculusBrowser/33.0 Chrome/130.0.0.0 Mobile Safari/537.36', 'Quest Browser · Android'],
    ['Chrome on ChromeOS', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', 'Chrome · ChromeOS'],
    ['an unknown agent', 'curl/8.4.0', 'Browser'],
    ['a browser on an unknown OS', 'SomethingElse/1.0 Firefox/100.0', 'Firefox'],
  ])('names %s', (_what, ua, expected) => {
    expect(describeClient(ua)).toBe(expected);
  });
});

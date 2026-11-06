import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  API_BASE,
  getToken, setToken, setTokens, getRefreshToken, clearToken,
  authFetch, setSessionExpiredHandler,
  login, verifyToken, updatePassword, logout, logoutEverywhere, fetchSessions, revokeSession,
  fetchDownloads, fetchAuthors, fetchStats, retryDownload,
  setTransferFilesStatus, fetchTransferFiles,
  fetchQueue, setQueueLimits, reorderQueue, startQueuedNow, stopAllDownloads, resumeAllDownloads,
  stopDownload, pauseDownload, resumeDownload, deleteDownload,
  fetchRenameRules, createRenameRule, updateRenameRule, deleteRenameRule, reorderRenameRules, testRenameRules, applyRenameRules,
  checkUrl, downloadUrl,
  fetchMappings, createMapping, updateMapping, deleteMapping,
  fetchCookies, saveCookies,
  fetchTelegramStatus, fetchTelegramApiConfig, saveTelegramApiConfig, sendTelegramCode, verifyTelegramCode,
  verifyTelegramPassword, telegramBotLogin, telegramLogout, addTelegramChannel, removeTelegramChannel,
  setChannelTorrentClient, fetchTelegramDialogs,
  fetchUsers, syncUsers, updateUserRole,
  fetchBotQueries, saveBotQuery, deleteBotQuery, testBotQuery,
  fetchVpsConfig, saveVpsConfig, testVpsConnection, deleteVpsConfig, fetchVpsUsage,
  fetchTorrentConfig, saveTorrentConfig, setStopOnComplete, setTorrentHidden, deleteTorrentConfig,
  testTorrentConnection, setTelegramDefault, fetchTorrentDetails, renameTorrent, setTorrentFilePriority,
  downloadTorrentFiles, fetchTorrentList, torrentAction, addTorrent, addTorrentFile,
  browseVps, browseLocal,
  fetchVpsFolders, addVpsFolders, fetchVpsFolderDeleteImpact, deleteVpsFolder, updateVpsFolder,
  fetchVpsFiles, downloadVpsFile, deleteVpsRemote,
  fetchAnalytics, checkVideoFile, checkFiles, fetchJobSchedules, saveJobSchedule,
  syncThumbnails, getYtdlpVersion, upgradeYtdlp,
  getMediaToken, ensureMediaToken, startMediaTokenKeeper, getVideoStreamUrl, getThumbUrl,
  type RenameRuleInput,
} from './index';
import {
  jsonResponse, textResponse, jwt, tokenExpiringIn, stubFetch, sentRequest, stubReload, nextTick,
  type FetchMock,
} from '../test/http';

const api = (path: string) => `${API_BASE}${path}`;
const rule: RenameRuleInput = { name: 'dots', pattern: '\\.', replacement: ' ', enabled: true, source: null, stop_on_match: false };

let expired: Mock<() => void>;

beforeEach(() => {
  localStorage.clear();
  expired = vi.fn<() => void>();
  setSessionExpiredHandler(expired);
});

afterEach(async () => {
  // The transport clears its shared in-flight promises on the next tick.
  await nextTick();
  vi.unstubAllGlobals();
});

describe('token storage', () => {
  it('starts signed out', () => {
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('stores the pair and reads each back', () => {
    setTokens('access', 'refresh');
    expect(getToken()).toBe('access');
    expect(getRefreshToken()).toBe('refresh');
  });

  it('keeps the refresh token when only a new access token comes in', () => {
    setTokens('a1', 'r1');
    setTokens('a2');
    setToken('a3');
    expect(getToken()).toBe('a3');
    expect(getRefreshToken()).toBe('r1');
  });

  it('forgets the access, refresh and media tokens together', () => {
    setTokens('a', 'r');
    localStorage.setItem('media_token', tokenExpiringIn(3600));
    clearToken();
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getMediaToken()).toBeNull();
  });
});

describe('authFetch', () => {
  it('prefixes the API base and sends the access token', async () => {
    setTokens('access', 'refresh');
    const fetchMock = stubFetch(jsonResponse({ ok: 1 }));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(200);
    const req = sentRequest(fetchMock);
    expect(req.url).toBe(api('/api/stats'));
    expect(req.headers.Authorization).toBe('Bearer access');
  });

  it('passes an absolute URL through and keeps the caller\'s headers', async () => {
    setTokens('access');
    const fetchMock = stubFetch(jsonResponse({}));
    await authFetch('http://elsewhere/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const req = sentRequest(fetchMock);
    expect(req.url).toBe('http://elsewhere/x');
    expect(req.method).toBe('POST');
    expect(req.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer access' });
  });

  it('sends no Authorization header when signed out', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    await authFetch('/api/stats');
    expect(sentRequest(fetchMock).headers).toEqual({});
  });

  it('returns any non-401 response untouched', async () => {
    stubFetch(jsonResponse({ error: 'boom' }, 500));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom' });
    expect(expired).not.toHaveBeenCalled();
  });

  it('refreshes once on a 401 and retries with the new access token', async () => {
    setTokens('old-access', 'old-refresh');
    const fetchMock = stubFetch(
      jsonResponse({ error: 'expired' }, 401),
      jsonResponse({ token: 'new-access', refresh_token: 'new-refresh' }),
      jsonResponse({ fine: true }),
    );
    const res = await authFetch('/api/stats', { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fine: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refresh = sentRequest(fetchMock, 1);
    expect(refresh.url).toBe(api('/api/auth/refresh'));
    expect(refresh.method).toBe('POST');
    expect(refresh.body).toEqual({ refresh_token: 'old-refresh' });
    expect(refresh.headers.Authorization).toBeUndefined();
    const retry = sentRequest(fetchMock, 2);
    expect(retry.url).toBe(api('/api/stats'));
    expect(retry.method).toBe('POST');
    expect(retry.body).toEqual({ a: 1 });
    expect(retry.headers.Authorization).toBe('Bearer new-access');
    expect(getToken()).toBe('new-access');
    expect(getRefreshToken()).toBe('new-refresh');
    expect(expired).not.toHaveBeenCalled();
  });

  it('leaves the media token alone across a refresh', async () => {
    setTokens('a', 'r');
    const media = tokenExpiringIn(3600);
    localStorage.setItem('media_token', media);
    stubFetch(jsonResponse({}, 401), jsonResponse({ token: 'a2', refresh_token: 'r2' }), jsonResponse({}));
    await authFetch('/api/stats');
    expect(getMediaToken()).toBe(media);
  });

  it('hands a "password change required" 401 back without refreshing', async () => {
    setTokens('a', 'r');
    const fetchMock = stubFetch(jsonResponse({ code: 'password_change_required' }, 401));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'password_change_required' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
  });

  it('declares the session over when there is no refresh token to try', async () => {
    setToken('a');
    const fetchMock = stubFetch(jsonResponse({}, 401));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('refreshes normally after an earlier 401 found no refresh token', async () => {
    // Another tab signed out, this one got a 401 with nothing to exchange...
    setToken('a');
    stubFetch(jsonResponse({}, 401));
    await authFetch('/api/stats');
    expect(expired).toHaveBeenCalledTimes(1);
    await nextTick();
    // ...then the user signed in again here, and the next expiry must refresh,
    // not reuse the "no refresh token" answer and sign them out again.
    setTokens('a2', 'r2');
    const fetchMock = stubFetch(jsonResponse({}, 401), jsonResponse({ token: 'a3', refresh_token: 'r3' }), jsonResponse({ ok: 1 }));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(200);
    expect(sentRequest(fetchMock, 1).body).toEqual({ refresh_token: 'r2' });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('declares the session over when the refresh is refused', async () => {
    setTokens('a', 'r');
    stubFetch(jsonResponse({}, 401), jsonResponse({ error: 'revoked' }, 401));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(getToken()).toBe('a');
  });

  it('declares the session over when the refresh reply carries no token', async () => {
    setTokens('a', 'r');
    stubFetch(jsonResponse({}, 401), jsonResponse({ status: 'ok' }));
    await authFetch('/api/stats');
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('declares the session over when the refresh request itself fails', async () => {
    setTokens('a', 'r');
    stubFetch(jsonResponse({}, 401), new TypeError('Failed to fetch'));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('declares the session over when the retry is refused too', async () => {
    setTokens('a', 'r');
    stubFetch(jsonResponse({}, 401), jsonResponse({ token: 'a2', refresh_token: 'r2' }), jsonResponse({}, 401));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('copes with a 401 whose body is not JSON', async () => {
    setTokens('a', 'r');
    stubFetch(textResponse('Unauthorized', 401), jsonResponse({ token: 'a2' }), jsonResponse({ ok: 1 }));
    const res = await authFetch('/api/stats');
    expect(res.status).toBe(200);
  });

  it('shares one refresh exchange between concurrent 401s', async () => {
    setTokens('a', 'r');
    const fetchMock: FetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = String(input);
      if (url.endsWith('/api/auth/refresh')) return Promise.resolve(jsonResponse({ token: 'a2', refresh_token: 'r2' }));
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return Promise.resolve(auth === 'Bearer a2' ? jsonResponse({ ok: 1 }) : jsonResponse({}, 401));
    });
    vi.stubGlobal('fetch', fetchMock);

    const [r1, r2, r3] = await Promise.all([authFetch('/api/a'), authFetch('/api/b'), authFetch('/api/c')]);
    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
    const refreshes = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/auth/refresh'));
    expect(refreshes).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
  });

  it('never replays a superseded refresh token: a later 401 exchanges the rotated one', async () => {
    setTokens('a1', 'r1');
    const fetchMock = stubFetch(
      jsonResponse({}, 401), jsonResponse({ token: 'a2', refresh_token: 'r2' }), jsonResponse({}),
      jsonResponse({}, 401), jsonResponse({ token: 'a3', refresh_token: 'r3' }), jsonResponse({}),
    );
    await authFetch('/api/first');
    await nextTick();
    await authFetch('/api/second');

    expect(sentRequest(fetchMock, 1).body).toEqual({ refresh_token: 'r1' });
    expect(sentRequest(fetchMock, 4).body).toEqual({ refresh_token: 'r2' });
    expect(getRefreshToken()).toBe('r3');
    expect(sentRequest(fetchMock, 5).headers.Authorization).toBe('Bearer a3');
  });
});

describe('session expiry handler', () => {
  it('replaces the handler authFetch calls', async () => {
    const mine = vi.fn();
    setSessionExpiredHandler(mine);
    stubFetch(jsonResponse({}, 401));
    await authFetch('/api/stats');
    expect(mine).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
  });
});

describe('login', () => {
  it('posts the credentials without an auth header and returns the pair', async () => {
    setToken('stale');
    const reply = { token: 't', refresh_token: 'r', expires_in: 1800, user: { id: 1, username: 'admin' } };
    const fetchMock = stubFetch(jsonResponse(reply));
    await expect(login('admin', 'pw')).resolves.toEqual(reply);
    const req = sentRequest(fetchMock);
    expect(req.url).toBe(api('/api/auth/login'));
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ username: 'admin', password: 'pw' });
    expect(req.headers.Authorization).toBeUndefined();
  });

  it('throws the server\'s reason, or a default, when refused', async () => {
    stubFetch(jsonResponse({ error: 'Too many attempts' }, 429));
    await expect(login('admin', 'pw')).rejects.toThrow('Too many attempts');
    stubFetch(jsonResponse({}, 401));
    await expect(login('admin', 'pw')).rejects.toThrow('Login failed');
  });
});

describe('verifyToken', () => {
  it('is invalid without asking the server when signed out', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    await expect(verifyToken()).resolves.toEqual({ valid: false, mustChangePassword: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a valid token and the forced password change', async () => {
    setTokens('a', 'r');
    stubFetch(jsonResponse({ must_change_password: true }));
    await expect(verifyToken()).resolves.toEqual({ valid: true, mustChangePassword: true });
  });

  it('treats a non-JSON ok reply as valid with no forced change', async () => {
    setTokens('a', 'r');
    stubFetch(textResponse('ok'));
    await expect(verifyToken()).resolves.toEqual({ valid: true, mustChangePassword: false });
  });

  it('is invalid when the server refuses', async () => {
    setTokens('a', 'r');
    stubFetch(jsonResponse({}, 403));
    await expect(verifyToken()).resolves.toEqual({ valid: false, mustChangePassword: false });
  });
});

describe('updatePassword', () => {
  it('throws the server\'s reason when refused', async () => {
    setTokens('a', 'r');
    stubFetch(jsonResponse({ error: 'Wrong password' }, 400));
    await expect(updatePassword('old', 'new')).rejects.toThrow('Wrong password');
  });

  it('adopts the replacement pair and mints a fresh media token', async () => {
    setTokens('a', 'r');
    localStorage.setItem('media_token', tokenExpiringIn(3600));
    const media = tokenExpiringIn(7200);
    const fetchMock = stubFetch(
      jsonResponse({ token: 'a2', refresh_token: 'r2' }),
      jsonResponse({ media_token: media }),
    );
    await updatePassword('old', 'new-password');
    expect(sentRequest(fetchMock, 0).body).toEqual({ current_password: 'old', new_password: 'new-password' });
    expect(getToken()).toBe('a2');
    expect(getRefreshToken()).toBe('r2');
    expect(sentRequest(fetchMock, 1).url).toBe(api('/api/auth/media-token'));
    expect(sentRequest(fetchMock, 1).headers.Authorization).toBe('Bearer a2');
    expect(getMediaToken()).toBe(media);
  });

  it('keeps the current pair when the reply carries none', async () => {
    setTokens('a', 'r');
    const fetchMock = stubFetch(jsonResponse({ status: 'ok' }));
    await updatePassword('old', 'new');
    expect(getToken()).toBe('a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('logout', () => {
  it('revokes this session then forgets every token', async () => {
    setTokens('a', 'r');
    localStorage.setItem('media_token', tokenExpiringIn(3600));
    const fetchMock = stubFetch(jsonResponse({}));
    await logout();
    const req = sentRequest(fetchMock);
    expect(req.url).toBe(api('/api/auth/logout'));
    expect(req.body).toEqual({ refresh_token: 'r' });
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getMediaToken()).toBeNull();
  });

  it('skips the server when there is no session to revoke', async () => {
    setToken('a');
    const fetchMock = stubFetch(jsonResponse({}));
    await logout();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getToken()).toBeNull();
  });

  it('still signs out locally when the server is unreachable', async () => {
    setTokens('a', 'r');
    stubFetch(new TypeError('Failed to fetch'));
    await expect(logout()).resolves.toBeUndefined();
    expect(getToken()).toBeNull();
  });
});

describe('logoutEverywhere', () => {
  it('posts logout-all with the access token and clears locally', async () => {
    setTokens('a', 'r');
    const fetchMock = stubFetch(jsonResponse({}));
    await logoutEverywhere();
    const req = sentRequest(fetchMock);
    expect(req.url).toBe(api('/api/auth/logout-all'));
    expect(req.method).toBe('POST');
    expect(req.headers.Authorization).toBe('Bearer a');
    expect(getToken()).toBeNull();
  });

  it('clears locally even when the request fails', async () => {
    setTokens('a', 'r');
    stubFetch(new TypeError('offline'));
    await logoutEverywhere();
    expect(getToken()).toBeNull();
  });
});

describe('sessions', () => {
  it('lists the active devices', async () => {
    const sessions = [{ id: 1, created_at: null, last_used_at: null, expires_at: null, user_agent: 'x', ip: null }];
    stubFetch(jsonResponse({ sessions }));
    await expect(fetchSessions()).resolves.toEqual({ sessions });
  });

  it('fails plainly when the list or the revoke is refused', async () => {
    stubFetch(jsonResponse({}, 500));
    await expect(fetchSessions()).rejects.toThrow('Failed to fetch sessions');
    await expect(revokeSession(3)).rejects.toThrow('Failed to revoke session');
  });

  it('revokes one device by id', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    await revokeSession(7);
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/auth/sessions/7'), method: 'DELETE' });
  });
});

describe('downloads list', () => {
  it('builds the default query string', async () => {
    const fetchMock = stubFetch(jsonResponse({ downloads: [], total: 0 }));
    await fetchDownloads();
    const url = new URL(sentRequest(fetchMock).url);
    expect(url.pathname).toBe('/api/downloads');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filter: 'all', sort_by: 'created_at', sort_order: 'desc', limit: '30', offset: '0',
    });
  });

  it('adds search, author and the hidden flag only when set', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    await fetchDownloads({ search: 'cat', author: 'bob', includeHidden: true, filter: 'on_disk', sortBy: 'file', sortOrder: 'asc', limit: 5, offset: 10 });
    const params = Object.fromEntries(new URL(sentRequest(fetchMock).url).searchParams);
    expect(params).toEqual({
      search: 'cat', author: 'bob', include_hidden: 'true', filter: 'on_disk',
      sort_by: 'file', sort_order: 'asc', limit: '5', offset: '10',
    });
    await fetchDownloads({ includeHidden: false, search: '' });
    const again = Object.fromEntries(new URL(sentRequest(fetchMock, 1).url).searchParams);
    expect(again).not.toHaveProperty('include_hidden');
    expect(again).not.toHaveProperty('search');
  });

  it('returns the body as the page', async () => {
    const page = { downloads: [{ id: 1 }], total: 1 };
    stubFetch(jsonResponse(page));
    await expect(fetchDownloads()).resolves.toEqual(page);
  });

  it('signs out and reloads on a 401 the refresh could not clear', async () => {
    setToken('a');
    const { reload, restore } = stubReload();
    try {
      stubFetch(jsonResponse({ error: 'no' }, 401));
      await fetchStats();
      expect(getToken()).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('fetches authors and stats as plain JSON', async () => {
    const fetchMock = stubFetch(jsonResponse(['ann', 'bob']), jsonResponse({ total: 2 }));
    await expect(fetchAuthors()).resolves.toEqual(['ann', 'bob']);
    await expect(fetchStats()).resolves.toEqual({ total: 2 });
    expect(sentRequest(fetchMock, 0).url).toBe(api('/api/authors'));
    expect(sentRequest(fetchMock, 1).url).toBe(api('/api/stats'));
  });
});

describe('retryDownload', () => {
  it('posts the id and resolves on success', async () => {
    const fetchMock = stubFetch(jsonResponse({ status: 'started' }));
    await expect(retryDownload(42)).resolves.toBeUndefined();
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/retry'), method: 'POST', body: { id: 42 } });
  });

  it('surfaces the server\'s reason, with a default for a bodiless failure', async () => {
    stubFetch(jsonResponse({ error: 'Nothing on disk to resume' }, 400));
    await expect(retryDownload(42)).rejects.toThrow('Nothing on disk to resume');
    stubFetch(textResponse('Bad gateway', 502));
    await expect(retryDownload(42)).rejects.toThrow('Failed to restart the download');
  });
});

describe('transfer files', () => {
  it('lists the files of a pull and throws the server\'s reason', async () => {
    const listing = { source: 'vps', error: null, is_dir: true, files: [] };
    const fetchMock = stubFetch(jsonResponse(listing), jsonResponse({ error: 'VPS unreachable' }, 502), textResponse('x', 500));
    await expect(fetchTransferFiles(5)).resolves.toEqual(listing);
    expect(sentRequest(fetchMock).url).toBe(api('/api/downloads/5/files'));
    await expect(fetchTransferFiles(5)).rejects.toThrow('VPS unreachable');
    await expect(fetchTransferFiles(5)).rejects.toThrow('Failed to load the file list');
  });

  it('sets a per-file decision, null clearing it', async () => {
    const reply = { file_status: {}, status: 'downloading', restarted: 'started' };
    const fetchMock = stubFetch(jsonResponse(reply), jsonResponse({ error: 'bad path' }, 400));
    await expect(setTransferFilesStatus(5, ['a.mkv'], null)).resolves.toEqual(reply);
    expect(sentRequest(fetchMock)).toMatchObject({
      url: api('/api/downloads/5/files/status'), method: 'POST', body: { paths: ['a.mkv'], status: null },
    });
    await expect(setTransferFilesStatus(5, ['zz'], 'paused')).rejects.toThrow('bad path');
  });
});

describe('download queue', () => {
  const state = { limits: { global: 3 }, running: [], waiting: [] };

  it.each([
    ['fetchQueue', () => fetchQueue(), { url: '/api/queue', method: 'GET' }],
    ['setQueueLimits', () => setQueueLimits({ global: 2, vps: null }), { url: '/api/queue/limits', method: 'PUT', body: { global: 2, vps: null } }],
    ['reorderQueue', () => reorderQueue(['m1', 'm2']), { url: '/api/queue/reorder', method: 'POST', body: { message_ids: ['m1', 'm2'] } }],
    ['startQueuedNow', () => startQueuedNow('m1'), { url: '/api/queue/start-now', method: 'POST', body: { message_id: 'm1' } }],
    ['stopAllDownloads', () => stopAllDownloads(), { url: '/api/queue/stop-all', method: 'POST' }],
    ['resumeAllDownloads', () => resumeAllDownloads(), { url: '/api/queue/resume-all', method: 'POST' }],
  ])('%s hits the queue route and returns the state', async (_name, call, expected) => {
    const fetchMock = stubFetch(jsonResponse(state));
    await expect(call()).resolves.toEqual(state);
    expect(sentRequest(fetchMock)).toMatchObject({ ...expected, url: api(expected.url) });
  });

  it('throws the server\'s reason or a default', async () => {
    stubFetch(jsonResponse({ error: 'Unknown download' }, 404));
    await expect(startQueuedNow('x')).rejects.toThrow('Unknown download');
    stubFetch(textResponse('oops', 500));
    await expect(fetchQueue()).rejects.toThrow('Queue request failed');
  });
});

describe('download actions', () => {
  it.each([
    ['stopDownload', () => stopDownload('m'), '/api/stop', { message_id: 'm' }],
    ['pauseDownload', () => pauseDownload('m'), '/api/pause', { message_id: 'm' }],
    ['resumeDownload', () => resumeDownload('m'), '/api/resume', { message_id: 'm' }],
    ['deleteDownload (record only)', () => deleteDownload('m'), '/api/delete', { message_id: 'm', delete_file: false }],
    ['deleteDownload (with file)', () => deleteDownload('m', true), '/api/delete', { message_id: 'm', delete_file: true }],
  ])('%s posts the message id', async (_name, call, url, body) => {
    const fetchMock = stubFetch(jsonResponse({}));
    await expect(call()).resolves.toBeUndefined();
    expect(sentRequest(fetchMock)).toMatchObject({ url: api(url), method: 'POST', body });
  });
});

describe('rename rules', () => {
  const rules = { rules: [{ ...rule, id: 1, position: 0 }] };

  it.each([
    ['fetchRenameRules', () => fetchRenameRules(), { url: '', method: 'GET', body: undefined }],
    ['createRenameRule', () => createRenameRule(rule), { url: '', method: 'POST', body: rule }],
    ['updateRenameRule', () => updateRenameRule(4, rule), { url: '/4', method: 'PUT', body: rule }],
    ['deleteRenameRule', () => deleteRenameRule(4), { url: '/4', method: 'DELETE', body: undefined }],
    ['reorderRenameRules', () => reorderRenameRules([2, 1]), { url: '/reorder', method: 'POST', body: { ids: [2, 1] } }],
  ])('%s', async (_name, call, expected) => {
    const fetchMock = stubFetch(jsonResponse(rules));
    await expect(call()).resolves.toEqual(rules);
    const req = sentRequest(fetchMock);
    expect(req).toMatchObject({ ...expected, url: api(`/api/settings/rename-rules${expected.url}`) });
    // JSON content type only when there is a body to describe.
    expect(req.headers['Content-Type']).toBe(expected.body === undefined ? undefined : 'application/json');
  });

  it('previews the saved chain, or one unsaved draft alone', async () => {
    const preview = { results: [], changed: 0, total: 0 };
    const fetchMock = stubFetch(jsonResponse(preview));
    await expect(testRenameRules()).resolves.toEqual(preview);
    expect(sentRequest(fetchMock, 0).body).toEqual({});
    await testRenameRules(rule);
    expect(sentRequest(fetchMock, 1).body).toEqual({ rule });
  });

  it('applies with the dry-run flag', async () => {
    const fetchMock = stubFetch(jsonResponse({ dry_run: true, total: 0, renamed: 0, skipped: 0, failed: 0, items: [] }));
    await applyRenameRules(true);
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/settings/rename-rules/apply'), body: { dry_run: true } });
  });

  it('throws the server\'s validation message', async () => {
    stubFetch(jsonResponse({ error: 'Invalid regex' }, 400));
    await expect(createRenameRule(rule)).rejects.toThrow('Invalid regex');
    stubFetch(textResponse('', 500));
    await expect(fetchRenameRules()).rejects.toThrow('Request failed');
  });
});

describe('URL downloads', () => {
  it('checks a URL and starts a download with the chosen format', async () => {
    const fetchMock = stubFetch(jsonResponse({ title: 'clip', formats: [] }), jsonResponse({ id: 1 }));
    await expect(checkUrl('https://v.example/1')).resolves.toEqual({ title: 'clip', formats: [] });
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/url/check'), method: 'POST', body: { url: 'https://v.example/1' } });
    const options = { url: 'https://v.example/1', format_id: '22', title: 'clip' };
    await expect(downloadUrl(options)).resolves.toEqual({ id: 1 });
    expect(sentRequest(fetchMock, 1)).toMatchObject({ url: api('/api/url/download'), method: 'POST', body: options });
  });
});

describe('mappings', () => {
  it('lists, creates and updates per-source specs', async () => {
    const fetchMock = stubFetch(jsonResponse([]), jsonResponse({ id: 1 }), jsonResponse({ id: 1 }));
    await expect(fetchMappings()).resolves.toEqual([]);
    await createMapping({ downloaded_from: 'youtube.com', folder: '/yt' });
    await updateMapping(1, { is_secured: true });
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/mappings'), method: 'GET' });
    expect(sentRequest(fetchMock, 1)).toMatchObject({ url: api('/api/mappings'), method: 'POST', body: { downloaded_from: 'youtube.com', folder: '/yt' } });
    expect(sentRequest(fetchMock, 2)).toMatchObject({ url: api('/api/mappings/1'), method: 'PUT', body: { is_secured: true } });
  });

  it('deletes one, throwing the server\'s reason', async () => {
    const fetchMock = stubFetch(jsonResponse({}), jsonResponse({ error: 'In use' }, 409), jsonResponse({}, 500));
    await expect(deleteMapping(3)).resolves.toBeUndefined();
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/mappings/3'), method: 'DELETE' });
    await expect(deleteMapping(3)).rejects.toThrow('In use');
    await expect(deleteMapping(3)).rejects.toThrow('Failed to delete mapping');
  });
});

describe('cookies', () => {
  it('reads the stored cookies, empty when none', async () => {
    stubFetch(jsonResponse({ cookies: '# Netscape' }), jsonResponse({}));
    await expect(fetchCookies()).resolves.toBe('# Netscape');
    await expect(fetchCookies()).resolves.toBe('');
  });

  it('saves them', async () => {
    const fetchMock = stubFetch(jsonResponse({ status: 'saved' }));
    await expect(saveCookies('c=1')).resolves.toEqual({ status: 'saved' });
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/settings/cookies'), method: 'POST', body: { cookies: 'c=1' } });
  });
});

describe('telegram settings', () => {
  const TG = '/api/settings/telegram';
  it.each([
    ['fetchTelegramStatus', () => fetchTelegramStatus(), '/status', 'GET', undefined],
    ['fetchTelegramApiConfig', () => fetchTelegramApiConfig(), '/api', 'GET', undefined],
    ['saveTelegramApiConfig', () => saveTelegramApiConfig('123', 'hash'), '/api', 'POST', { api_id: '123', api_hash: 'hash' }],
    ['sendTelegramCode', () => sendTelegramCode('+1555'), '/send-code', 'POST', { phone: '+1555' }],
    ['verifyTelegramCode', () => verifyTelegramCode('12345'), '/verify-code', 'POST', { code: '12345' }],
    ['verifyTelegramPassword', () => verifyTelegramPassword('pw'), '/verify-password', 'POST', { password: 'pw' }],
    ['telegramBotLogin', () => telegramBotLogin('bot:token'), '/bot-login', 'POST', { token: 'bot:token' }],
    ['telegramLogout', () => telegramLogout(), '/logout', 'POST', {}],
    ['addTelegramChannel', () => addTelegramChannel('@chan'), '/channels', 'POST', { chat: '@chan' }],
    ['removeTelegramChannel', () => removeTelegramChannel(-100), '/channels/-100', 'DELETE', undefined],
    ['setChannelTorrentClient', () => setChannelTorrentClient(-100, 'qbittorrent'), '/channels/-100', 'PATCH', { torrent_client: 'qbittorrent' }],
    ['fetchTelegramDialogs', () => fetchTelegramDialogs(), '/dialogs', 'GET', undefined],
  ])('%s', async (_name, call, path, method, body) => {
    const fetchMock = stubFetch(jsonResponse({ status: 'ok' }));
    await expect(call()).resolves.toEqual({ status: 'ok' });
    const req = sentRequest(fetchMock);
    expect(req).toMatchObject({ url: api(`${TG}${path}`), method, body });
    expect(req.headers['Content-Type']).toBe(body === undefined ? undefined : 'application/json');
  });
});

describe('users', () => {
  it('lists, syncs and changes a role', async () => {
    const fetchMock = stubFetch(jsonResponse({ users: [] }), jsonResponse({ synced: 2 }), jsonResponse({ user: { id: 2 } }));
    await expect(fetchUsers()).resolves.toEqual({ users: [] });
    await expect(syncUsers()).resolves.toEqual({ synced: 2 });
    await expect(updateUserRole(2, 'admin')).resolves.toEqual({ user: { id: 2 } });
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/users'), method: 'GET' });
    expect(sentRequest(fetchMock, 1)).toMatchObject({ url: api('/api/users/sync'), method: 'POST' });
    expect(sentRequest(fetchMock, 2)).toMatchObject({ url: api('/api/users/2'), method: 'PATCH', body: { role: 'admin' } });
  });
});

describe('bot queries', () => {
  it.each([
    ['fetchBotQueries', () => fetchBotQueries(), '', 'GET', undefined],
    ['saveBotQuery', () => saveBotQuery('df', 'df -h', 'disk'), '', 'POST', { key: 'df', command: 'df -h', original_key: 'disk' }],
    ['deleteBotQuery (key url-encoded)', () => deleteBotQuery('a/b c'), '/a%2Fb%20c', 'DELETE', undefined],
    ['testBotQuery', () => testBotQuery('uptime'), '/test', 'POST', { command: 'uptime' }],
  ])('%s', async (_name, call, path, method, body) => {
    const fetchMock = stubFetch(jsonResponse({ queries: [] }));
    await expect(call()).resolves.toEqual({ queries: [] });
    expect(sentRequest(fetchMock)).toMatchObject({ url: api(`/api/settings/queries${path}`), method, body });
  });
});

describe('VPS connection settings', () => {
  const input = { host: 'box', port: 22, username: 'me', remote_path: '/home/me', password: 'pw' };
  it.each([
    ['fetchVpsConfig', () => fetchVpsConfig(), '/api/settings/vps', 'GET', undefined],
    ['saveVpsConfig', () => saveVpsConfig(input), '/api/settings/vps', 'POST', input],
    ['testVpsConnection', () => testVpsConnection(input), '/api/settings/vps/test', 'POST', input],
    ['deleteVpsConfig', () => deleteVpsConfig(), '/api/settings/vps', 'DELETE', undefined],
    ['fetchVpsUsage', () => fetchVpsUsage(), '/api/vps/usage', 'GET', undefined],
    ['fetchVpsUsage (refresh)', () => fetchVpsUsage(true), '/api/vps/usage?refresh=1', 'GET', undefined],
  ])('%s', async (_name, call, path, method, body) => {
    const fetchMock = stubFetch(jsonResponse({ configured: true }));
    await expect(call()).resolves.toEqual({ configured: true });
    expect(sentRequest(fetchMock)).toMatchObject({ url: api(path), method, body });
  });
});

describe('torrent client settings', () => {
  it.each([
    ['fetchTorrentConfig', () => fetchTorrentConfig(), '/api/settings/torrent', 'GET', undefined],
    ['saveTorrentConfig', () => saveTorrentConfig('transmission', { url: 'http://t', username: 'u' }),
      '/api/settings/torrent', 'POST', { client: 'transmission', url: 'http://t', username: 'u' }],
    ['setStopOnComplete', () => setStopOnComplete('qbittorrent', false),
      '/api/settings/torrent/stop-on-complete', 'POST', { client: 'qbittorrent', enabled: false }],
    ['setTorrentHidden', () => setTorrentHidden('qbittorrent', true),
      '/api/settings/torrent/hidden', 'POST', { client: 'qbittorrent', hidden: true }],
    ['deleteTorrentConfig', () => deleteTorrentConfig('transmission'), '/api/settings/torrent?client=transmission', 'DELETE', undefined],
    ['testTorrentConnection', () => testTorrentConnection('qbittorrent', { url: 'http://q', username: 'u', password: 'p' }),
      '/api/settings/torrent/test', 'POST', { client: 'qbittorrent', url: 'http://q', username: 'u', password: 'p' }],
    ['setTelegramDefault', () => setTelegramDefault(null), '/api/settings/torrent/telegram-default', 'POST', { client: null }],
  ])('%s', async (_name, call, path, method, body) => {
    const fetchMock = stubFetch(jsonResponse({ status: 'ok' }));
    await expect(call()).resolves.toEqual({ status: 'ok' });
    expect(sentRequest(fetchMock)).toMatchObject({ url: api(path), method, body });
  });
});

describe('torrents', () => {
  it('fetches one torrent\'s details with the hash url-encoded', async () => {
    const details = { torrent: { hash: 'ab+c' }, files: [], priorities: [], rename_renames_folder: true, info: {} };
    const fetchMock = stubFetch(jsonResponse(details), jsonResponse({ error: 'No such torrent' }, 404));
    await expect(fetchTorrentDetails('transmission', 'ab+c')).resolves.toEqual(details);
    expect(sentRequest(fetchMock).url).toBe(api('/api/torrent/details?client=transmission&hash=ab%2Bc'));
    await expect(fetchTorrentDetails('transmission', 'gone')).rejects.toThrow('No such torrent');
  });

  it('renames a torrent or one of its files', async () => {
    const fetchMock = stubFetch(jsonResponse({}), jsonResponse({}), jsonResponse({ error: 'Name taken' }, 409), textResponse('', 500));
    await renameTorrent('qbittorrent', 'h', 'New name');
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/torrent/rename'), method: 'POST', body: { client: 'qbittorrent', hash: 'h', name: 'New name' } });
    await renameTorrent('qbittorrent', 'h', 'ep1.mkv', 'Show/ep01.mkv');
    expect(sentRequest(fetchMock, 1).body).toMatchObject({ path: 'Show/ep01.mkv', name: 'ep1.mkv' });
    await expect(renameTorrent('qbittorrent', 'h', 'x')).rejects.toThrow('Name taken');
    await expect(renameTorrent('qbittorrent', 'h', 'x')).rejects.toThrow('Rename failed');
  });

  it('sets file priorities', async () => {
    const fetchMock = stubFetch(jsonResponse({}), jsonResponse({ error: 'Unsupported priority' }, 400));
    await setTorrentFilePriority('transmission', 'h', [0, 2], 'skip');
    expect(sentRequest(fetchMock)).toMatchObject({
      url: api('/api/torrent/files/priority'), method: 'POST', body: { client: 'transmission', hash: 'h', indices: [0, 2], priority: 'skip' },
    });
    await expect(setTorrentFilePriority('transmission', 'h', [0], 'max')).rejects.toThrow('Unsupported priority');
  });

  it('pulls files to DownLee, filling in the lists the server left out', async () => {
    const fetchMock = stubFetch(jsonResponse({ started: [{ index: 1, id: 9, message_id: 'm' }] }));
    await expect(downloadTorrentFiles('qbittorrent', 'h', [1])).resolves.toEqual({
      started: [{ index: 1, id: 9, message_id: 'm' }], skipped: [], errors: [],
    });
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/torrent/files/download'), body: { client: 'qbittorrent', hash: 'h', indices: [1] } });
  });

  it('returns per-file errors from a failed pull instead of throwing', async () => {
    stubFetch(jsonResponse({ errors: [{ index: 1, error: 'not finished' }] }, 400));
    await expect(downloadTorrentFiles('qbittorrent', 'h', [1])).resolves.toEqual({
      started: [], skipped: [], errors: [{ index: 1, error: 'not finished' }],
    });
  });

  it('throws when the pull is refused outright', async () => {
    stubFetch(jsonResponse({ error: 'Client not configured' }, 400));
    await expect(downloadTorrentFiles('qbittorrent', 'h', [1])).rejects.toThrow('Client not configured');
    stubFetch(textResponse('', 500));
    await expect(downloadTorrentFiles('qbittorrent', 'h', [1])).rejects.toThrow('Failed to start the download to DownLee');
  });

  it('lists a client\'s torrents', async () => {
    const fetchMock = stubFetch(jsonResponse({ configured: true, torrents: [] }));
    await expect(fetchTorrentList('qbittorrent')).resolves.toEqual({ configured: true, torrents: [] });
    expect(sentRequest(fetchMock).url).toBe(api('/api/torrent/list?client=qbittorrent'));
  });

  it('sends an action over hashes, keeping data unless told otherwise', async () => {
    const fetchMock = stubFetch(jsonResponse({ status: 'ok' }));
    await torrentAction('transmission', 'force-start', ['h1', 'h2']);
    expect(sentRequest(fetchMock, 0)).toMatchObject({
      url: api('/api/torrent/action'), body: { client: 'transmission', action: 'force-start', hashes: ['h1', 'h2'], delete_data: false },
    });
    await torrentAction('transmission', 'remove', ['h1'], true);
    expect(sentRequest(fetchMock, 1).body).toMatchObject({ action: 'remove', delete_data: true });
  });

  it('adds a magnet, with the download dir null when not chosen', async () => {
    const fetchMock = stubFetch(jsonResponse({ status: 'added', name: 'x' }));
    await expect(addTorrent('magnet:?xt=1', 'qbittorrent')).resolves.toEqual({ status: 'added', name: 'x' });
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/torrent/add'), body: { magnet: 'magnet:?xt=1', client: 'qbittorrent', download_dir: null } });
    await addTorrent('magnet:?xt=1', 'qbittorrent', '/dl');
    expect(sentRequest(fetchMock, 1).body).toMatchObject({ download_dir: '/dl' });
  });

  it('uploads a .torrent as multipart, letting the browser set the boundary', async () => {
    setToken('a');
    const fetchMock = stubFetch(jsonResponse({ status: 'added' }));
    const file = new File(['d8:announce'], 'x.torrent');
    await expect(addTorrentFile(file, 'transmission', '/dl')).resolves.toEqual({ status: 'added' });
    const req = sentRequest(fetchMock);
    expect(req.url).toBe(api('/api/torrent/add-file'));
    expect(req.headers).toEqual({ Authorization: 'Bearer a' });
    const form = req.body as FormData;
    expect(form.get('file')).toBeInstanceOf(File);
    expect(form.get('client')).toBe('transmission');
    expect(form.get('download_dir')).toBe('/dl');
    await addTorrentFile(file, 'transmission');
    expect((sentRequest(fetchMock, 1).body as FormData).has('download_dir')).toBe(false);
  });
});

describe('folder browsing', () => {
  it('browses the VPS and the local disk from the root by default', async () => {
    const fetchMock = stubFetch(jsonResponse({ entries: [] }));
    await expect(browseVps()).resolves.toEqual({ entries: [] });
    await browseLocal('/mnt');
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/settings/vps/browse'), method: 'POST', body: { path: '' } });
    expect(sentRequest(fetchMock, 1)).toMatchObject({ url: api('/api/settings/local/browse'), method: 'POST', body: { path: '/mnt' } });
  });
});

describe('VPS watched folders', () => {
  const folders = [{ id: 1, path: '/w' }];

  it('lists, adds and updates folders, unwrapping the list', async () => {
    const fetchMock = stubFetch(jsonResponse({ folders }), jsonResponse({}), jsonResponse({ folders }), jsonResponse({ folders }));
    await expect(fetchVpsFolders()).resolves.toEqual(folders);
    await expect(fetchVpsFolders()).resolves.toEqual([]);
    await expect(addVpsFolders(['/w'])).resolves.toEqual(folders);
    await expect(updateVpsFolder(1, { auto_sync: true })).resolves.toEqual(folders);
    expect(sentRequest(fetchMock, 2)).toMatchObject({ url: api('/api/settings/vps/folders'), method: 'POST', body: { paths: ['/w'] } });
    expect(sentRequest(fetchMock, 3)).toMatchObject({ url: api('/api/settings/vps/folders/1'), method: 'PATCH', body: { auto_sync: true } });
  });

  it('checks what a removal would unhide', async () => {
    const fetchMock = stubFetch(jsonResponse({ count: 2, sample: ['a', 'b'] }), jsonResponse({ error: 'Unknown folder' }, 404));
    await expect(fetchVpsFolderDeleteImpact(1)).resolves.toEqual({ count: 2, sample: ['a', 'b'] });
    expect(sentRequest(fetchMock).url).toBe(api('/api/settings/vps/folders/1/delete-impact'));
    await expect(fetchVpsFolderDeleteImpact(1)).rejects.toThrow('Unknown folder');
  });

  it('removes a folder, confirming the unhide when asked', async () => {
    const fetchMock = stubFetch(jsonResponse({ error: 'unhide', count: 2 }, 409), jsonResponse({ folders: [] }));
    await expect(deleteVpsFolder(1)).rejects.toThrow('unhide');
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/settings/vps/folders/1'), method: 'DELETE' });
    await expect(deleteVpsFolder(1, true)).resolves.toEqual([]);
    expect(sentRequest(fetchMock, 1).url).toBe(api('/api/settings/vps/folders/1?confirm_unhide=1'));
  });
});

describe('VPS files', () => {
  it('lists watched folders live, hidden ones on request', async () => {
    const groups = [{ path: '/w', entries: [] }];
    const fetchMock = stubFetch(jsonResponse({ folders: groups }), jsonResponse({}));
    await expect(fetchVpsFiles()).resolves.toEqual(groups);
    expect(sentRequest(fetchMock, 0).url).toBe(api('/api/vps/files'));
    await expect(fetchVpsFiles(true)).resolves.toEqual([]);
    expect(sentRequest(fetchMock, 1).url).toBe(api('/api/vps/files?include_hidden=true'));
  });

  it('starts a pull with the size and client only when known', async () => {
    const fetchMock = stubFetch(jsonResponse({ id: 1, message_id: 'm' }));
    await expect(downloadVpsFile('/w/a.mkv')).resolves.toEqual({ id: 1, message_id: 'm' });
    expect(sentRequest(fetchMock, 0)).toMatchObject({ url: api('/api/vps/download'), body: { path: '/w/a.mkv', size: 0 } });
    expect(sentRequest(fetchMock, 0).body).not.toHaveProperty('client');
    await downloadVpsFile('/w/a.mkv', 1234, 'qbittorrent');
    expect(sentRequest(fetchMock, 1).body).toEqual({ path: '/w/a.mkv', size: 1234, client: 'qbittorrent' });
  });

  it('deletes on the VPS', async () => {
    const fetchMock = stubFetch(jsonResponse({ status: 'deleted' }));
    await expect(deleteVpsRemote('/w/a.mkv')).resolves.toEqual({ status: 'deleted' });
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/vps/delete-remote'), body: { path: '/w/a.mkv' } });
  });
});

describe('analytics and video', () => {
  it('builds the analytics query', async () => {
    const fetchMock = stubFetch(jsonResponse({ series: [] }));
    await expect(fetchAnalytics()).resolves.toEqual({ series: [] });
    expect(Object.fromEntries(new URL(sentRequest(fetchMock, 0).url).searchParams)).toEqual({ days: '30', group_by: 'day' });
    await fetchAnalytics(7, 'hour', true);
    expect(Object.fromEntries(new URL(sentRequest(fetchMock, 1).url).searchParams)).toEqual({ days: '7', group_by: 'hour', include_deleted: 'true' });
  });

  it('asks what is on disk for a download', async () => {
    const fetchMock = stubFetch(jsonResponse({ exists: true, kind: 'video' }));
    await expect(checkVideoFile(12)).resolves.toEqual({ exists: true, kind: 'video' });
    expect(sentRequest(fetchMock).url).toBe(api('/api/video/check/12'));
  });
});

describe('jobs', () => {
  it('runs the file check and throws on an error even in a 200', async () => {
    const result = { checked: 3, present: 2, missing: 1, marked_missing: 1, restored: 0 };
    const fetchMock = stubFetch(jsonResponse(result), jsonResponse({ error: 'Busy' }), textResponse('', 500));
    await expect(checkFiles()).resolves.toEqual(result);
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/jobs/check-files'), method: 'POST' });
    await expect(checkFiles()).rejects.toThrow('Busy');
    await expect(checkFiles()).rejects.toThrow('Failed to check files');
  });

  it('loads the schedules and saves one, unwrapping the schedule', async () => {
    const schedule = { enabled: true, time: '03:00', days: [0, 1], last_run: null, last_status: null, last_summary: null, next_run: 'x' };
    const fetchMock = stubFetch(
      jsonResponse({ jobs: [], schedules: {}, tz: 'UTC', server_time: 't' }),
      jsonResponse({ schedule }),
      jsonResponse({ error: 'Bad time' }, 400),
      textResponse('', 500),
    );
    await expect(fetchJobSchedules()).resolves.toMatchObject({ tz: 'UTC' });
    await expect(saveJobSchedule('check_files', { time: '03:00' })).resolves.toEqual(schedule);
    expect(sentRequest(fetchMock, 1)).toMatchObject({ url: api('/api/jobs/schedules/check_files'), method: 'PUT', body: { time: '03:00' } });
    await expect(saveJobSchedule('check_files', { time: '25:00' })).rejects.toThrow('Bad time');
    await expect(fetchJobSchedules()).rejects.toThrow('Failed to load schedules');
  });

  it.each([
    ['syncThumbnails', () => syncThumbnails(), '/api/jobs/sync-thumbnails', 'POST'],
    ['getYtdlpVersion', () => getYtdlpVersion(), '/api/jobs/ytdlp-version', 'GET'],
    ['upgradeYtdlp', () => upgradeYtdlp(), '/api/jobs/ytdlp-upgrade', 'POST'],
  ])('%s', async (_name, call, path, method) => {
    const fetchMock = stubFetch(jsonResponse({ ok: 1 }));
    await expect(call()).resolves.toEqual({ ok: 1 });
    expect(sentRequest(fetchMock)).toMatchObject({ url: api(path), method });
  });
});

describe('media token', () => {
  it('reads a live token and ignores an expired one', () => {
    expect(getMediaToken()).toBeNull();
    const live = tokenExpiringIn(3600);
    localStorage.setItem('media_token', live);
    expect(getMediaToken()).toBe(live);
    localStorage.setItem('media_token', tokenExpiringIn(-5));
    expect(getMediaToken()).toBeNull();
    localStorage.setItem('media_token', 'garbage');
    expect(getMediaToken()).toBeNull();
  });

  it('reuses a token with more than ten minutes left', async () => {
    const live = tokenExpiringIn(3600);
    localStorage.setItem('media_token', live);
    const fetchMock = stubFetch(jsonResponse({ media_token: 'never' }));
    await expect(ensureMediaToken()).resolves.toBe(live);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints a new token when the old one is inside the margin', async () => {
    setToken('a');
    localStorage.setItem('media_token', tokenExpiringIn(5 * 60));
    const fresh = tokenExpiringIn(12 * 3600);
    const fetchMock = stubFetch(jsonResponse({ media_token: fresh }));
    await expect(ensureMediaToken()).resolves.toBe(fresh);
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/auth/media-token'), headers: { Authorization: 'Bearer a' } });
    expect(getMediaToken()).toBe(fresh);
  });

  it('mints regardless when forced', async () => {
    localStorage.setItem('media_token', tokenExpiringIn(3600));
    const fresh = tokenExpiringIn(7200);
    const fetchMock = stubFetch(jsonResponse({ media_token: fresh }));
    await expect(ensureMediaToken(true)).resolves.toBe(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null, keeping what is stored, when the mint is refused or empty', async () => {
    stubFetch(jsonResponse({ error: 'no' }, 403));
    await expect(ensureMediaToken(true)).resolves.toBeNull();
    await nextTick();
    stubFetch(jsonResponse({}));
    await expect(ensureMediaToken(true)).resolves.toBeNull();
    await nextTick();
    stubFetch(new TypeError('offline'));
    await expect(ensureMediaToken(true)).resolves.toBeNull();
    expect(localStorage.getItem('media_token')).toBeNull();
  });

  it('shares one mint between concurrent callers', async () => {
    const fresh = tokenExpiringIn(7200);
    const fetchMock = stubFetch(jsonResponse({ media_token: fresh }));
    const [a, b] = await Promise.all([ensureMediaToken(true), ensureMediaToken(true)]);
    expect(a).toBe(fresh);
    expect(b).toBe(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('puts the media token in stream and thumbnail URLs, empty when there is none', () => {
    expect(getVideoStreamUrl(3)).toBe(api('/api/video/stream/3?token='));
    const live = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    localStorage.setItem('media_token', live);
    expect(getVideoStreamUrl(3)).toBe(api(`/api/video/stream/3?token=${live}`));
    expect(getThumbUrl(3, 'thumb_1.jpg')).toBe(api(`/api/thumbs/3/thumb_1.jpg?token=${live}`));
  });
});

describe('media token keeper', () => {
  let visibility: DocumentVisibilityState;
  let fetchMock: FetchMock;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    fetchMock = stubFetch(jsonResponse({ media_token: tokenExpiringIn(12 * 3600) }));
  });

  afterEach(() => {
    stop?.();
    stop = null;
    delete (document as { visibilityState?: unknown }).visibilityState;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('mints at once when there is no token', async () => {
    stop = startMediaTokenKeeper();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getMediaToken()).not.toBeNull();
  });

  it('re-mints ten minutes before the token\'s own expiry, checking every minute', async () => {
    localStorage.setItem('media_token', tokenExpiringIn(30 * 60));
    stop = startMediaTokenKeeper();
    await vi.advanceTimersByTimeAsync(19 * 60 * 1000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The fresh token lasts hours, so the next ticks do nothing.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks again when the tab regains focus or becomes visible', async () => {
    localStorage.setItem('media_token', tokenExpiringIn(3600));
    stop = startMediaTokenKeeper();
    // A phone suspends timers: jump the clock without any interval firing.
    vi.setSystemTime(new Date('2026-06-01T12:55:00Z'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    localStorage.setItem('media_token', tokenExpiringIn(60));
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops checking once stopped', async () => {
    localStorage.setItem('media_token', tokenExpiringIn(3600));
    stop = startMediaTokenKeeper();
    stop();
    stop = null;
    localStorage.setItem('media_token', tokenExpiringIn(60));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

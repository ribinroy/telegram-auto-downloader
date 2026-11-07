import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  fetchFileRoots, listFiles, createFolder, renamePath, deletePaths, transferPaths,
  fetchTransfers, fetchTransferFiles, pauseTransferFiles, cancelTransfer, ackTransfers, dismissTransfer,
  searchFiles, dirSize, warmThumbs, thumbStatus, readTextFile, uploadFiles,
  getFileStreamUrl, getFileDownloadUrl, getFileThumbUrl, pathBaseName,
} from './files';
import { API_BASE, setToken } from './index';
import { jsonResponse, textResponse, tokenExpiringIn, stubFetch, sentRequest } from '../test/http';

const api = (path: string) => `${API_BASE}${path}`;

beforeEach(() => {
  localStorage.clear();
  setToken('access');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('file explorer requests', () => {
  it.each([
    ['fetchFileRoots', () => fetchFileRoots(), '/roots?include_hidden=false', 'GET', undefined],
    ['fetchFileRoots (hidden)', () => fetchFileRoots(true), '/roots?include_hidden=true', 'GET', undefined],
    ['listFiles (default root)', () => listFiles(), '/list', 'POST', { path: '', show_hidden: false }],
    ['listFiles', () => listFiles('/mnt/hdd', true), '/list', 'POST', { path: '/mnt/hdd', show_hidden: true }],
    ['createFolder', () => createFolder('/mnt', 'New'), '/mkdir', 'POST', { path: '/mnt', name: 'New' }],
    ['renamePath', () => renamePath('/mnt/a', 'b'), '/rename', 'POST', { path: '/mnt/a', name: 'b' }],
    ['deletePaths (trash)', () => deletePaths(['/a']), '/delete', 'POST', { paths: ['/a'], permanent: false }],
    ['deletePaths (permanent)', () => deletePaths(['/a'], true), '/delete', 'POST', { paths: ['/a'], permanent: true }],
    ['transferPaths', () => transferPaths(['/a'], '/b', true), '/transfer', 'POST', { paths: ['/a'], dest: '/b', move: true }],
    ['fetchTransfers', () => fetchTransfers(), '/transfers', 'GET', undefined],
    ['fetchTransferFiles', () => fetchTransferFiles('j1'), '/transfers/j1/files', 'GET', undefined],
    ['pauseTransferFiles', () => pauseTransferFiles('j1', ['x'], true), '/transfers/j1/files/pause', 'POST', { paths: ['x'], paused: true }],
    ['cancelTransfer', () => cancelTransfer('j1'), '/transfers/j1/cancel', 'POST', {}],
    ['ackTransfers', () => ackTransfers(['j1', 'j2']), '/transfers/ack', 'POST', { ids: ['j1', 'j2'] }],
    ['searchFiles', () => searchFiles('/mnt', 'cat'), '/search', 'POST', { path: '/mnt', query: 'cat', show_hidden: false }],
    ['dirSize', () => dirSize('/mnt/x'), '/size', 'POST', { path: '/mnt/x' }],
    ['warmThumbs', () => warmThumbs(['/a.mkv']), '/thumb/warm', 'POST', { paths: ['/a.mkv'] }],
    ['thumbStatus', () => thumbStatus(['/a.mkv']), '/thumb/status', 'POST', { paths: ['/a.mkv'] }],
    ['readTextFile', () => readTextFile('/a.txt'), '/text', 'POST', { path: '/a.txt' }],
  ])('%s', async (_name, call, path, method, body) => {
    const fetchMock = stubFetch(jsonResponse({ ok: true }));
    await expect(call()).resolves.toEqual({ ok: true });
    const req = sentRequest(fetchMock);
    expect(req).toMatchObject({ url: api(`/api/files${path}`), method, body });
    expect(req.headers.Authorization).toBe('Bearer access');
    // JSON content type only on a POST with a body.
    expect(req.headers['Content-Type']).toBe(method === 'GET' ? undefined : 'application/json');
  });

  it('throws the server\'s reason, with a default for a bodiless failure', async () => {
    stubFetch(jsonResponse({ error: 'Permission denied' }, 403));
    await expect(listFiles('/root')).rejects.toThrow('Permission denied');
    stubFetch(textResponse('<html>502</html>', 502));
    await expect(listFiles('/root')).rejects.toThrow('Request failed');
  });
});

describe('dismissTransfer', () => {
  it('deletes the finished job and resolves with nothing', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await expect(dismissTransfer('j1')).resolves.toBeUndefined();
    expect(sentRequest(fetchMock)).toMatchObject({ url: api('/api/files/transfers/j1'), method: 'DELETE' });
  });

  it('throws while the job is still running', async () => {
    stubFetch(jsonResponse({ error: 'Transfer is still running' }, 409));
    await expect(dismissTransfer('j1')).rejects.toThrow('Transfer is still running');
    stubFetch(textResponse('', 500));
    await expect(dismissTransfer('j1')).rejects.toThrow('Request failed');
  });
});

describe('uploadFiles', () => {
  it('posts the destination and every file as multipart', async () => {
    const fetchMock = stubFetch(jsonResponse({ results: [], errors: [], entries: [] }));
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
    await expect(uploadFiles('/mnt/in', files)).resolves.toEqual({ results: [], errors: [], entries: [] });
    const req = sentRequest(fetchMock);
    expect(req.url).toBe(api('/api/files/upload'));
    expect(req.method).toBe('POST');
    // No Content-Type: the browser writes the multipart boundary itself.
    expect(req.headers).toEqual({ Authorization: 'Bearer access' });
    const form = req.body as FormData;
    expect(form.get('path')).toBe('/mnt/in');
    expect(form.getAll('files').map(f => (f as File).name)).toEqual(['a.txt', 'b.txt']);
  });

  it('throws the server\'s reason or "Upload failed"', async () => {
    stubFetch(jsonResponse({ error: 'Read-only' }, 403));
    await expect(uploadFiles('/x', [])).rejects.toThrow('Read-only');
    stubFetch(textResponse('', 500));
    await expect(uploadFiles('/x', [])).rejects.toThrow('Upload failed');
  });
});

describe('media URL builders', () => {
  it('carry the media token and encode the path', () => {
    const token = tokenExpiringIn(3600);
    localStorage.setItem('media_token', token);
    expect(getFileStreamUrl('/mnt/a b.mkv')).toBe(api(`/api/files/stream?path=%2Fmnt%2Fa%20b.mkv&token=${token}`));
    expect(getFileDownloadUrl('/mnt/a.mkv')).toBe(api(`/api/files/download?path=%2Fmnt%2Fa.mkv&token=${token}`));
    expect(getFileThumbUrl('/mnt/a.mkv')).toBe(api(`/api/files/thumb?path=%2Fmnt%2Fa.mkv&token=${token}`));
  });

  it('leave the token empty when there is none, or it has expired', () => {
    expect(getFileStreamUrl('/a')).toBe(api('/api/files/stream?path=%2Fa&token='));
    localStorage.setItem('media_token', tokenExpiringIn(-1));
    expect(getFileThumbUrl('/a')).toBe(api('/api/files/thumb?path=%2Fa&token='));
  });
});

describe('pathBaseName', () => {
  it('takes the last path component, ignoring a trailing slash', () => {
    expect(pathBaseName('/mnt/hdd/Films')).toBe('Films');
    expect(pathBaseName('/mnt/hdd/Films/')).toBe('Films');
    expect(pathBaseName('vps:/home6/user/downloads')).toBe('downloads');
  });

  it('falls back to the path itself for the root, and to empty for nothing', () => {
    expect(pathBaseName('/')).toBe('/');
    expect(pathBaseName(null)).toBe('');
    expect(pathBaseName('')).toBe('');
  });
});

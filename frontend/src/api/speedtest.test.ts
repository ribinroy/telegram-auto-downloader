import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { measurePing, measureDownload, measureUpload } from './speedtest';
import { API_BASE, setToken } from './index';
import { jsonResponse, stubFetch, sentRequest } from '../test/http';
import type { Sample } from '../utils/speedtest';

/** performance.now() that moves `step` ms on every call: each await costs a tick. */
function tickingClock(step: number) {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => { clock += step; return clock; });
  return { set: (ms: number) => { clock = ms; } };
}

beforeEach(() => {
  localStorage.clear();
  setToken('access');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('measurePing', () => {
  it('sends one warm-up request that is not timed, then one per sample', async () => {
    tickingClock(10);
    const fetchMock = stubFetch(jsonResponse({ ok: true }));
    const rtts = await measurePing(3);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(rtts).toHaveLength(3);
    rtts.forEach(rtt => expect(rtt).toBeGreaterThan(0));
    fetchMock.mock.calls.forEach((_c, i) => {
      const req = sentRequest(fetchMock, i);
      expect(req.url).toMatch(new RegExp(`^${API_BASE}/api/speedtest/ping\\?x=\\d+`));
      expect(req.init?.cache).toBe('no-store');
      expect(req.headers.Authorization).toBe('Bearer access');
    });
  });

  it('passes the abort signal through and fails on a bad reply', async () => {
    const ctrl = new AbortController();
    const fetchMock = stubFetch(jsonResponse({}), jsonResponse({}, 503));
    await expect(measurePing(2, ctrl.signal)).rejects.toThrow('Ping failed (503)');
    expect(sentRequest(fetchMock, 0).init?.signal).toBe(ctrl.signal);
  });
});

describe('measureDownload', () => {
  /** A fetch whose body streams `chunk`-byte blocks for ever, until the
   *  request's own signal aborts it - what the real endpoint does. */
  function streamingFetch(chunk = 1024, status = 200) {
    const mock = vi.fn<typeof fetch>((_input, init) => {
      let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(c) { ctl = c; },
        pull(c) { c.enqueue(new Uint8Array(chunk)); },
      });
      init?.signal?.addEventListener('abort', () => {
        try { ctl?.error(new DOMException('The operation was aborted.', 'AbortError')); } catch { /* already closed */ }
      });
      return Promise.resolve(new Response(body, { status }));
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('reads until the deadline, sampling every 100ms and once more at the end', async () => {
    tickingClock(150);
    const fetchMock = streamingFetch(1024);
    const onProgress = vi.fn<(s: Sample[]) => void>();
    const samples = await measureDownload(1, onProgress);

    // t0 = 150; reads at 300 ... 1200, the last one past the 1150 deadline.
    expect(samples[0]).toEqual({ t: 0, bytes: 0 });
    expect(samples[samples.length - 1].bytes).toBe(7 * 1024);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].t).toBeGreaterThan(samples[i - 1].t);
      expect(samples[i].bytes).toBeGreaterThanOrEqual(samples[i - 1].bytes);
    }
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.lastCall?.[0]).toBe(samples);
    const req = sentRequest(fetchMock);
    expect(req.url).toMatch(/\/api\/speedtest\/download\?size=\d+&x=\d+$/);
    expect(req.init?.cache).toBe('no-store');
    expect(req.init?.signal?.aborted).toBe(true);
  });

  it('stops as soon as the caller aborts', async () => {
    tickingClock(150);
    streamingFetch(1024);
    const outer = new AbortController();
    const onProgress = vi.fn(() => outer.abort());
    await expect(measureDownload(60, onProgress, outer.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('fails on a bad reply or a reply with no body', async () => {
    streamingFetch(1024, 503);
    await expect(measureDownload(1)).rejects.toThrow('Download failed (503)');
    stubFetch(new Response(null, { status: 200 }));
    await expect(measureDownload(1)).rejects.toThrow('Download failed (200)');
  });
});

describe('measureUpload', () => {
  type ProgressHandler = ((e: ProgressEvent) => void) | null;

  /** Records what the transport asks of it; the test drives the events. */
  class FakeXHR {
    static instances: FakeXHR[] = [];
    static last() { return FakeXHR.instances[FakeXHR.instances.length - 1]; }
    upload: { onloadstart: (() => void) | null; onprogress: ProgressHandler; onerror: (() => void) | null } =
      { onloadstart: null, onprogress: null, onerror: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    status = 0;
    opened: [string, string] | null = null;
    headers: Record<string, string> = {};
    sent: unknown = null;
    abort = vi.fn();
    constructor() { FakeXHR.instances.push(this); }
    open(method: string, url: string) { this.opened = [method, url]; }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    send(body: unknown) { this.sent = body; }
    progress(loaded: number) { this.upload.onprogress?.({ loaded } as ProgressEvent); }
  }

  /** The real body would be 256 MB of noise; only its size matters here. */
  class FakeBlob {
    size: number;
    type: string;
    constructor(parts: ArrayBufferView[], options?: { type?: string }) {
      this.size = parts.reduce((n, p) => n + p.byteLength, 0);
      this.type = options?.type ?? '';
    }
  }

  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    vi.stubGlobal('Blob', FakeBlob);
    vi.useFakeTimers();
  });

  it('posts a 256 MB noise body with the access token and reports what was sent', async () => {
    const clock = tickingClock(0);
    const onProgress = vi.fn<(s: Sample[]) => void>();
    const promise = measureUpload(8, onProgress);
    const xhr = FakeXHR.last();
    expect(xhr.opened?.[0]).toBe('POST');
    expect(xhr.opened?.[1]).toMatch(new RegExp(`^${API_BASE}/api/speedtest/upload\\?x=\\d+$`));
    expect(xhr.headers).toEqual({ Authorization: 'Bearer access', 'Content-Type': 'application/octet-stream' });
    expect((xhr.sent as FakeBlob).size).toBe(256 * 1024 * 1024);
    expect((xhr.sent as FakeBlob).type).toBe('application/octet-stream');

    clock.set(1000);
    xhr.upload.onloadstart?.();
    clock.set(1500);
    xhr.progress(5_000_000);
    clock.set(2000);
    xhr.progress(12_000_000);
    xhr.status = 200;
    xhr.onload?.();

    await expect(promise).resolves.toEqual([{ t: 0, bytes: 0 }, { t: 0.5, bytes: 5_000_000 }, { t: 1, bytes: 12_000_000 }]);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(xhr.abort).not.toHaveBeenCalled();
  });

  it('aborts at the deadline and resolves with the samples so far', async () => {
    const clock = tickingClock(0);
    const promise = measureUpload(3);
    const xhr = FakeXHR.last();
    xhr.upload.onloadstart?.();
    clock.set(1000);
    xhr.progress(1000);
    vi.advanceTimersByTime(3000);
    expect(xhr.abort).toHaveBeenCalledTimes(1);
    await expect(promise).resolves.toEqual([{ t: 0, bytes: 0 }, { t: 1, bytes: 1000 }]);
  });

  it('rejects with the caller\'s abort and cancels the request', async () => {
    const outer = new AbortController();
    const promise = measureUpload(8, undefined, outer.signal);
    const xhr = FakeXHR.last();
    xhr.upload.onloadstart?.();
    outer.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.abort).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 401', (xhr: FakeXHR) => { xhr.status = 401; xhr.onload?.(); }, 'Not signed in'],
    ['a server error', (xhr: FakeXHR) => { xhr.status = 500; xhr.onload?.(); }, 'Upload failed (500)'],
    ['a network error', (xhr: FakeXHR) => xhr.onerror?.(), 'Upload failed'],
    ['an upload error', (xhr: FakeXHR) => xhr.upload.onerror?.(), 'Upload failed'],
  ])('fails on %s', async (_what, trigger, message) => {
    const promise = measureUpload(8);
    const xhr = FakeXHR.last();
    xhr.upload.onloadstart?.();
    trigger(xhr);
    await expect(promise).rejects.toThrow(message);
  });
});

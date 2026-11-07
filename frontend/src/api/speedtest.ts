import { API_BASE, authFetch, getToken } from './index';
import type { Sample } from '../utils/speedtest';

export type Progress = (samples: Sample[]) => void;

// Each phase runs until its deadline, not until a fixed byte count: a gigabit
// LAN and a bad Wi-Fi corner should both get a few seconds of steady transfer.

export async function measurePing(count = 8, signal?: AbortSignal): Promise<number[]> {
  const rtts: number[] = [];
  // The first request pays for connection setup; it is sent and not counted.
  await authFetch(`/api/speedtest/ping?x=${Date.now()}`, { signal, cache: 'no-store' });
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const res = await authFetch(`/api/speedtest/ping?x=${Date.now()}-${i}`, { signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`Ping failed (${res.status})`);
    await res.json();
    rtts.push(performance.now() - t0);
  }
  return rtts;
}

export async function measureDownload(seconds = 8, onProgress?: Progress, signal?: AbortSignal): Promise<Sample[]> {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onOuterAbort);
  const res = await authFetch(`/api/speedtest/download?size=${4 * 1024 * 1024 * 1024}&x=${Date.now()}`, {
    signal: ctrl.signal, cache: 'no-store',
  });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const reader = res.body.getReader();
  const samples: Sample[] = [{ t: 0, bytes: 0 }];
  const t0 = performance.now();
  const deadline = t0 + seconds * 1000;
  let bytes = 0;
  let lastReport = t0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const now = performance.now();
      if (now - lastReport >= 100) {
        samples.push({ t: (now - t0) / 1000, bytes });
        lastReport = now;
        onProgress?.(samples);
      }
      if (now >= deadline) break;
    }
  } finally {
    ctrl.abort();
    signal?.removeEventListener('abort', onOuterAbort);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  samples.push({ t: (performance.now() - t0) / 1000, bytes });
  onProgress?.(samples);
  return samples;
}

// Noise, so nothing on the path can compress it away. crypto fills at most
// 64 KB per call; one 4 MB block is reused, since the server discards it.
function noiseBlob(totalBytes: number): Blob {
  const block = new Uint8Array(new ArrayBuffer(4 * 1024 * 1024));
  for (let off = 0; off < block.length; off += 65536) {
    crypto.getRandomValues(block.subarray(off, Math.min(off + 65536, block.length)));
  }
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let n = 0; n < totalBytes; n += block.length) parts.push(block);
  return new Blob(parts, { type: 'application/octet-stream' });
}

export function measureUpload(seconds = 8, onProgress?: Progress, signal?: AbortSignal): Promise<Sample[]> {
  return new Promise((resolve, reject) => {
    // fetch() has no upload progress; XHR does. 256 MB is a couple of seconds
    // on a gigabit link - past the warm-up window - and is aborted at the
    // deadline on anything slower; a bigger blob would just eat laptop RAM.
    const body = noiseBlob(256 * 1024 * 1024);
    const xhr = new XMLHttpRequest();
    const samples: Sample[] = [{ t: 0, bytes: 0 }];
    let t0 = 0;
    let timer = 0;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(samples);
    };
    const onAbort = () => { xhr.abort(); finish(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort);

    xhr.open('POST', `${API_BASE}/api/speedtest/upload?x=${Date.now()}`);
    xhr.setRequestHeader('Authorization', `Bearer ${getToken() ?? ''}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onloadstart = () => {
      t0 = performance.now();
      timer = window.setTimeout(() => { xhr.abort(); finish(); }, seconds * 1000);
    };
    xhr.upload.onprogress = (e) => {
      samples.push({ t: (performance.now() - t0) / 1000, bytes: e.loaded });
      onProgress?.(samples);
    };
    xhr.upload.onerror = () => finish(new Error('Upload failed'));
    xhr.onerror = () => finish(new Error('Upload failed'));
    xhr.onload = () => {
      if (xhr.status === 401) finish(new Error('Not signed in'));
      else if (xhr.status >= 400) finish(new Error(`Upload failed (${xhr.status})`));
      else finish();
    };
    xhr.send(body);
  });
}

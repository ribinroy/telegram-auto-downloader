import type { DownloadsResponse } from '../types';

const API_BASE = 'http://192.168.0.135:4444';

export async function fetchDownloads(search?: string): Promise<DownloadsResponse> {
  const url = search
    ? `${API_BASE}/api/downloads?search=${encodeURIComponent(search)}`
    : `${API_BASE}/api/downloads`;
  const response = await fetch(url);
  return response.json();
}

export async function retryDownload(id: number): Promise<void> {
  await fetch(`${API_BASE}/api/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

export async function stopDownload(file: string): Promise<void> {
  await fetch(`${API_BASE}/api/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
}

export async function deleteDownload(file: string): Promise<void> {
  await fetch(`${API_BASE}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
}

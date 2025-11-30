import type { DownloadsResponse, Stats } from '../types';

const API_BASE = 'http://192.168.0.135:4444';

export async function fetchDownloads(search?: string, filter: 'all' | 'active' = 'all'): Promise<DownloadsResponse> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  params.set('filter', filter);

  const url = `${API_BASE}/api/downloads?${params.toString()}`;
  const response = await fetch(url);
  return response.json();
}

export async function fetchStats(): Promise<Stats> {
  const response = await fetch(`${API_BASE}/api/stats`);
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

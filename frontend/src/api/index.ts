import type { DownloadsResponse, Stats } from '../types';

const API_BASE = '';

export type SortBy = 'created_at' | 'file' | 'status' | 'progress';
export type SortOrder = 'asc' | 'desc';

export async function fetchDownloads(
  search?: string,
  filter: 'all' | 'active' = 'all',
  sortBy: SortBy = 'created_at',
  sortOrder: SortOrder = 'desc'
): Promise<DownloadsResponse> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  params.set('filter', filter);
  params.set('sort_by', sortBy);
  params.set('sort_order', sortOrder);

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

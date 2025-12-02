import type { DownloadsResponse, Stats, UrlCheckResult, Download, DownloadTypeMap, AnalyticsData } from '../types';

const API_BASE = import.meta.env.DEV ? 'http://192.168.0.135:4444' : '';
const TOKEN_KEY = 'auth_token';

export type SortBy = 'created_at' | 'file' | 'status' | 'progress';
export type SortOrder = 'asc' | 'desc';

// Auth helpers
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function getAuthHeaders(): HeadersInit {
  const token = getToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// Auth API
export interface LoginResponse {
  token: string;
  user: { id: number; username: string };
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Login failed');
  }
  return response.json();
}

export async function verifyToken(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;

  const response = await fetch(`${API_BASE}/api/auth/verify`, {
    headers: getAuthHeaders(),
  });
  return response.ok;
}

export async function updatePassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update password');
  }
}

export interface FetchDownloadsOptions {
  search?: string;
  filter?: 'all' | 'active';
  sortBy?: SortBy;
  sortOrder?: SortOrder;
  limit?: number;
  offset?: number;
  excludeMappingIds?: number[];
}

export async function fetchDownloads(options: FetchDownloadsOptions = {}): Promise<DownloadsResponse> {
  const {
    search,
    filter = 'all',
    sortBy = 'created_at',
    sortOrder = 'desc',
    limit = 30,
    offset = 0,
    excludeMappingIds,
  } = options;

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  params.set('filter', filter);
  params.set('sort_by', sortBy);
  params.set('sort_order', sortOrder);
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());
  if (excludeMappingIds && excludeMappingIds.length > 0) {
    params.set('exclude_mapping_ids', excludeMappingIds.join(','));
  }

  const url = `${API_BASE}/api/downloads?${params.toString()}`;
  const response = await fetch(url, { headers: getAuthHeaders() });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function fetchStats(): Promise<Stats> {
  const response = await fetch(`${API_BASE}/api/stats`, { headers: getAuthHeaders() });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function retryDownload(id: number): Promise<void> {
  await fetch(`${API_BASE}/api/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ id }),
  });
}

export async function stopDownload(message_id: string): Promise<void> {
  await fetch(`${API_BASE}/api/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ message_id }),
  });
}

export async function deleteDownload(message_id: string): Promise<void> {
  await fetch(`${API_BASE}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ message_id }),
  });
}

export async function checkUrl(url: string): Promise<UrlCheckResult> {
  const response = await fetch(`${API_BASE}/api/url/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ url }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export interface DownloadOptions {
  url: string;
  format_id?: string;
  title?: string;
  ext?: string;
  filesize?: number;
  resolution?: string;
}

export async function downloadUrl(options: DownloadOptions): Promise<Download | { error: string }> {
  const response = await fetch(`${API_BASE}/api/url/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(options),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

// Download type mappings API
export async function fetchMappings(): Promise<DownloadTypeMap[]> {
  const response = await fetch(`${API_BASE}/api/mappings`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function fetchSecuredSources(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/api/mappings/secured`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function fetchSecuredMappingIds(): Promise<number[]> {
  const response = await fetch(`${API_BASE}/api/mappings/secured-ids`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function fetchMappingBySource(source: string): Promise<DownloadTypeMap | null> {
  const response = await fetch(`${API_BASE}/api/mappings/source/${encodeURIComponent(source)}`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function addMapping(
  downloaded_from: string,
  is_secured: boolean,
  folder: string | null,
  quality: string | null = null
): Promise<DownloadTypeMap | { error: string }> {
  const response = await fetch(`${API_BASE}/api/mappings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ downloaded_from, is_secured, folder, quality }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function updateMapping(
  id: number,
  data: Partial<{ downloaded_from: string; is_secured: boolean; folder: string | null; quality: string | null }>
): Promise<DownloadTypeMap | { error: string }> {
  const response = await fetch(`${API_BASE}/api/mappings/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function deleteMapping(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/api/mappings/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete mapping');
  }
}

// Cookies API for yt-dlp authentication
export async function fetchCookies(): Promise<string> {
  const response = await fetch(`${API_BASE}/api/settings/cookies`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const data = await response.json();
  return data.cookies || '';
}

export async function saveCookies(cookies: string): Promise<{ status?: string; error?: string }> {
  const response = await fetch(`${API_BASE}/api/settings/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ cookies }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

// Analytics API
export async function fetchAnalytics(days: number = 30, groupBy: 'day' | 'hour' = 'day'): Promise<AnalyticsData> {
  const params = new URLSearchParams();
  params.set('days', days.toString());
  params.set('group_by', groupBy);

  const response = await fetch(`${API_BASE}/api/analytics?${params.toString()}`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

// Video playback API
export interface VideoCheckResult {
  exists: boolean;
  path?: string;
  size?: number;
  name?: string;
  error?: string;
}

export async function checkVideoFile(downloadId: number): Promise<VideoCheckResult> {
  const response = await fetch(`${API_BASE}/api/video/check/${downloadId}`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export function getVideoStreamUrl(downloadId: number): string {
  const token = getToken();
  return `${API_BASE}/api/video/stream/${downloadId}?token=${token}`;
}

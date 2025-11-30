import type { DownloadsResponse, Stats } from '../types';

const API_BASE = '';
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

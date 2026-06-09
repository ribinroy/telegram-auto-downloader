import type { DownloadsResponse, Stats, UrlCheckResult, Download, SourceMapping, AnalyticsData } from '../types';

const API_BASE = import.meta.env.DEV ? (import.meta.env.VITE_API_BASE || 'http://localhost:4444') : '';
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
  includeHidden?: boolean;
  author?: string;
}

export async function fetchDownloads(options: FetchDownloadsOptions = {}): Promise<DownloadsResponse> {
  const {
    search,
    filter = 'all',
    sortBy = 'created_at',
    sortOrder = 'desc',
    limit = 30,
    offset = 0,
    includeHidden,
    author,
  } = options;

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  params.set('filter', filter);
  params.set('sort_by', sortBy);
  params.set('sort_order', sortOrder);
  params.set('limit', limit.toString());
  params.set('offset', offset.toString());
  if (includeHidden) params.set('include_hidden', 'true');
  if (author) params.set('author', author);

  const url = `${API_BASE}/api/downloads?${params.toString()}`;
  const response = await fetch(url, { headers: getAuthHeaders() });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function fetchAuthors(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/api/authors`, { headers: getAuthHeaders() });
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

export async function pauseDownload(message_id: string): Promise<void> {
  await fetch(`${API_BASE}/api/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ message_id }),
  });
}

export async function resumeDownload(message_id: string): Promise<void> {
  await fetch(`${API_BASE}/api/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ message_id }),
  });
}

export async function deleteDownload(message_id: string, delete_file: boolean = false): Promise<void> {
  await fetch(`${API_BASE}/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ message_id, delete_file }),
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

// Per-source download specs (mappings) API
export async function fetchMappings(): Promise<SourceMapping[]> {
  const response = await fetch(`${API_BASE}/api/mappings`, { headers: getAuthHeaders() });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function createMapping(
  data: { downloaded_from: string; folder?: string | null; quality?: string | null; is_secured?: boolean }
): Promise<SourceMapping | { error: string }> {
  const response = await fetch(`${API_BASE}/api/mappings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function updateMapping(
  id: number,
  data: Partial<{ downloaded_from: string; folder: string | null; quality: string | null; is_secured: boolean }>
): Promise<SourceMapping | { error: string }> {
  const response = await fetch(`${API_BASE}/api/mappings/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function deleteMapping(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/api/mappings/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
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

// VPS connection settings API
// Telegram connection & channels API
export interface TelegramUser {
  id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  is_bot?: boolean;
}

export interface TelegramChannel {
  id: number;
  title: string;
}

export interface TelegramDialog {
  id: number;
  title: string;
  type: 'channel' | 'group' | 'user';
  username: string | null;
  monitored: boolean;
}

export interface TelegramStatus {
  api_configured?: boolean;
  connected: boolean;
  authorized: boolean;
  awaiting_code: boolean;
  user: TelegramUser | null;
  channels: TelegramChannel[];
  error?: string;
}

export interface TelegramApiConfig {
  configured: boolean;
  api_id: number | null;
  has_hash: boolean;
  source: 'database' | 'env' | null;
  error?: string;
}

async function telegramRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/api/settings/telegram${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...getAuthHeaders(),
    },
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export function fetchTelegramStatus(): Promise<TelegramStatus> {
  return telegramRequest('/status');
}

export function fetchTelegramApiConfig(): Promise<TelegramApiConfig> {
  return telegramRequest('/api');
}

export function saveTelegramApiConfig(apiId: string, apiHash: string): Promise<TelegramApiConfig & { status?: string }> {
  return telegramRequest('/api', { method: 'POST', body: JSON.stringify({ api_id: apiId, api_hash: apiHash }) });
}

export function sendTelegramCode(phone: string): Promise<{ status?: string; error?: string }> {
  return telegramRequest('/send-code', { method: 'POST', body: JSON.stringify({ phone }) });
}

export function verifyTelegramCode(code: string): Promise<{ status?: string; error?: string }> {
  return telegramRequest('/verify-code', { method: 'POST', body: JSON.stringify({ code }) });
}

export function verifyTelegramPassword(password: string): Promise<{ status?: string; error?: string }> {
  return telegramRequest('/verify-password', { method: 'POST', body: JSON.stringify({ password }) });
}

export function telegramBotLogin(token: string): Promise<{ status?: string; error?: string }> {
  return telegramRequest('/bot-login', { method: 'POST', body: JSON.stringify({ token }) });
}

export function telegramLogout(): Promise<{ status?: string; error?: string }> {
  return telegramRequest('/logout', { method: 'POST', body: JSON.stringify({}) });
}

export function addTelegramChannel(chat: string): Promise<{ channels?: TelegramChannel[]; error?: string }> {
  return telegramRequest('/channels', { method: 'POST', body: JSON.stringify({ chat }) });
}

export function removeTelegramChannel(chatId: number): Promise<{ channels?: TelegramChannel[]; error?: string }> {
  return telegramRequest(`/channels/${chatId}`, { method: 'DELETE' });
}

export function fetchTelegramDialogs(): Promise<{ dialogs?: TelegramDialog[]; error?: string }> {
  return telegramRequest('/dialogs');
}

// Users (web logins + Telegram users who interacted with the bot)
export interface AppUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
  telegram_id: string | null;
  display_name: string | null;
  is_web: boolean;
  created_at: string | null;
}

export async function fetchUsers(): Promise<{ users: AppUser[] }> {
  const response = await fetch(`${API_BASE}/api/users`, { headers: getAuthHeaders() });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function syncUsers(): Promise<{ synced?: number; users?: AppUser[]; error?: string }> {
  const response = await fetch(`${API_BASE}/api/users/sync`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function updateUserRole(userId: number, role: 'admin' | 'user'): Promise<{ user?: AppUser; error?: string }> {
  const response = await fetch(`${API_BASE}/api/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ role }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

// Bot queries (key -> shell snippet triggered from Telegram)
export interface BotQuery {
  key: string;
  command: string;
}

async function queriesRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/api/settings/queries${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...getAuthHeaders(),
    },
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export function fetchBotQueries(): Promise<{ queries: BotQuery[] }> {
  return queriesRequest('');
}

export function saveBotQuery(key: string, command: string, originalKey?: string): Promise<{ queries?: BotQuery[]; error?: string }> {
  return queriesRequest('', { method: 'POST', body: JSON.stringify({ key, command, original_key: originalKey }) });
}

export function deleteBotQuery(key: string): Promise<{ queries?: BotQuery[]; error?: string }> {
  return queriesRequest(`/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

export function testBotQuery(command: string): Promise<{ output?: string; error?: string }> {
  return queriesRequest('/test', { method: 'POST', body: JSON.stringify({ command }) });
}

export interface VpsConfig {
  configured: boolean;
  host: string;
  port: number;
  username: string;
  remote_path: string;
  has_password: boolean;
}

export interface VpsConfigInput {
  host: string;
  port: number;
  username: string;
  remote_path: string;
  password?: string;
}

export async function fetchVpsConfig(): Promise<VpsConfig> {
  const response = await fetch(`${API_BASE}/api/settings/vps`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function saveVpsConfig(config: VpsConfigInput): Promise<{ status?: string; configured?: boolean; has_password?: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/api/settings/vps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(config),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function testVpsConnection(config: VpsConfigInput): Promise<{ success: boolean; message?: string; error?: string }> {
  const response = await fetch(`${API_BASE}/api/settings/vps/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(config),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function deleteVpsConfig(): Promise<{ status?: string; configured?: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/api/settings/vps`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

// Torrent client (Transmission on the VPS) API
export interface TorrentConfig {
  configured: boolean;
  url: string;
  username: string;
  has_password: boolean;
}

export async function fetchTorrentConfig(): Promise<TorrentConfig> {
  const response = await fetch(`${API_BASE}/api/settings/torrent`, { headers: getAuthHeaders() });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function saveTorrentConfig(
  config: { url: string; username: string; password?: string }
): Promise<{ status?: string; configured?: boolean; url?: string; has_password?: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/api/settings/torrent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(config),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function deleteTorrentConfig(): Promise<{ status?: string; error?: string }> {
  const response = await fetch(`${API_BASE}/api/settings/torrent`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function testTorrentConnection(
  config: { url: string; username: string; password?: string }
): Promise<{ success: boolean; message?: string; error?: string }> {
  const response = await fetch(`${API_BASE}/api/settings/torrent/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(config),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function addTorrent(
  magnet: string, downloadDir?: string | null
): Promise<{ status?: 'added' | 'duplicate'; name?: string; hash?: string; error?: string }> {
  const response = await fetch(`${API_BASE}/api/torrent/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ magnet, download_dir: downloadDir ?? null }),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export interface VpsBrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface VpsBrowseResult {
  path?: string;
  parent?: string | null;
  entries?: VpsBrowseEntry[];
  error?: string;
}

export async function browseVps(path?: string): Promise<VpsBrowseResult> {
  const response = await fetch(`${API_BASE}/api/settings/vps/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ path: path ?? '' }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

/** Browse directories on the local (home server) filesystem. Mirrors browseVps. */
export async function browseLocal(path?: string): Promise<VpsBrowseResult> {
  const response = await fetch(`${API_BASE}/api/settings/local/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ path: path ?? '' }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export interface VpsWatchFolder {
  id: number;
  path: string;
  host: string | null;
  port: number | null;
  username: string | null;
  auto_sync: boolean;
  folder: string | null;       // local destination folder for this watched folder
  is_secured: boolean;         // hide downloads from this folder in the default view
  active?: boolean;
  created_at: string | null;
}

export async function fetchVpsFolders(): Promise<VpsWatchFolder[]> {
  const response = await fetch(`${API_BASE}/api/settings/vps/folders`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const data = await response.json();
  return data.folders || [];
}

export async function addVpsFolders(paths: string[]): Promise<VpsWatchFolder[]> {
  const response = await fetch(`${API_BASE}/api/settings/vps/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ paths }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const data = await response.json();
  return data.folders || [];
}

export async function deleteVpsFolder(id: number): Promise<VpsWatchFolder[]> {
  const response = await fetch(`${API_BASE}/api/settings/vps/folders/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const data = await response.json();
  return data.folders || [];
}

export async function updateVpsFolder(
  id: number,
  data: Partial<{ auto_sync: boolean; folder: string | null; is_secured: boolean }>
): Promise<VpsWatchFolder[]> {
  const response = await fetch(`${API_BASE}/api/settings/vps/folders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const result = await response.json();
  return result.folders || [];
}

// VPS file listing (live, non-recursive contents of watched folders)
export interface VpsFileEntry {
  name: string;
  path: string;
  folder: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  downloaded: boolean;
  message_id?: string;
  status?: string;
}

export interface VpsFolderGroup {
  path: string;
  auto_sync: boolean;
  active: boolean;
  host?: string | null;
  username?: string | null;
  error?: string;
  entries: VpsFileEntry[];
}

export async function fetchVpsFiles(): Promise<VpsFolderGroup[]> {
  const response = await fetch(`${API_BASE}/api/vps/files`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const data = await response.json();
  return data.folders || [];
}

export async function downloadVpsFile(path: string, size?: number): Promise<{ error?: string; id?: number; message_id?: string }> {
  const response = await fetch(`${API_BASE}/api/vps/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ path, size: size ?? 0 }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function deleteVpsRemote(path: string): Promise<{ status?: string; error?: string }> {
  const response = await fetch(`${API_BASE}/api/vps/delete-remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ path }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

// Analytics API
export async function fetchAnalytics(days: number = 30, groupBy: 'day' | 'hour' = 'day', includeDeleted: boolean = false): Promise<AnalyticsData> {
  const params = new URLSearchParams();
  params.set('days', days.toString());
  params.set('group_by', groupBy);
  if (includeDeleted) params.set('include_deleted', 'true');

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

// Jobs API
export interface SyncThumbnailsResult {
  generated: number;
  skipped: number;
  orphan_deleted: number;
  db_count_fixed: number;
  meta_extracted: number;
  no_duration: number;
  not_video: number;
  failed: number;
}

export async function syncThumbnails(): Promise<SyncThumbnailsResult> {
  const response = await fetch(`${API_BASE}/api/jobs/sync-thumbnails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function getYtdlpVersion(): Promise<{ version: string | null; error?: string }> {
  const response = await fetch(`${API_BASE}/api/jobs/ytdlp-version`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function upgradeYtdlp(): Promise<{ old_version?: string; new_version?: string; upgraded?: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/api/jobs/ytdlp-upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
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

export function getThumbUrl(downloadId: number, filename: string): string {
  const token = getToken();
  return `${API_BASE}/api/thumbs/${downloadId}/${filename}?token=${token}`;
}


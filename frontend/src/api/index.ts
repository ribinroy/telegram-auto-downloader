import type { DownloadsResponse, Stats, UrlCheckResult, Download, SourceMapping, AnalyticsData } from '../types';

const API_BASE = import.meta.env.DEV ? (import.meta.env.VITE_API_BASE || 'http://localhost:4444') : '';
const TOKEN_KEY = 'auth_token';
const REFRESH_KEY = 'refresh_token';
const MEDIA_TOKEN_KEY = 'media_token';

export type SortBy = 'created_at' | 'file' | 'status' | 'progress';
export type SortOrder = 'asc' | 'desc';

// Auth helpers
//
// The access token is short-lived (~30 min) and sent with every request; the
// refresh token is long-lived and exchanged for a new pair by authFetch when
// the access token expires. Both are revocable server-side.
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(token: string, refreshToken?: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(MEDIA_TOKEN_KEY);
}

// --- Transparent token refresh ---------------------------------------------

/** Called when the session is truly gone, so the app can show the login page. */
let onSessionExpired: () => void = () => {
  clearToken();
  window.location.reload();
};

export function setSessionExpiredHandler(fn: () => void): void {
  onSessionExpired = fn;
}

/** In-flight refresh, shared so N concurrent 401s trigger one exchange. */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return null;
    try {
      const response = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data.token) return null;
      setTokens(data.token, data.refresh_token);
      // The media token is derived from the session; force a re-mint.
      localStorage.removeItem(MEDIA_TOKEN_KEY);
      return data.token as string;
    } catch {
      return null;
    } finally {
      // Cleared on the next tick so callers awaiting this promise still see it.
      setTimeout(() => { refreshInFlight = null; }, 0);
    }
  })();

  return refreshInFlight;
}

/**
 * fetch() with the access token attached, retrying once through a token
 * refresh if the server says the token expired. A refresh failure means the
 * session was revoked or ran out - hand off to the session-expired handler.
 */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const send = (token: string | null) => fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  let response = await send(getToken());
  if (response.status !== 401) return response;

  // Read the code without consuming the body the caller may still want.
  const code = await response.clone().json().then(d => d?.code).catch(() => undefined);
  if (code === 'password_change_required') return response;

  const fresh = await refreshAccessToken();
  if (!fresh) {
    onSessionExpired();
    return response;
  }

  response = await send(fresh);
  if (response.status === 401) onSessionExpired();
  return response;
}

// Auth API
export interface LoginResponse {
  token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: number; username: string };
  must_change_password?: boolean;
}

export interface VerifyResult {
  valid: boolean;
  mustChangePassword: boolean;
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

export async function verifyToken(): Promise<VerifyResult> {
  const token = getToken();
  if (!token) return { valid: false, mustChangePassword: false };

  const response = await authFetch(`/api/auth/verify`);
  if (!response.ok) return { valid: false, mustChangePassword: false };
  const data = await response.json().catch(() => ({}));
  return { valid: true, mustChangePassword: !!data.must_change_password };
}

export async function updatePassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await authFetch(`/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update password');
  }
  // Changing the password signs out every other device, this one included -
  // the response carries a replacement pair so the current tab stays signed in.
  const data = await response.json().catch(() => null);
  if (data?.token) {
    setTokens(data.token, data.refresh_token);
    localStorage.removeItem(MEDIA_TOKEN_KEY);
    await ensureMediaToken(true);
  }
}

/** Revoke just this device's session, then forget the tokens locally. */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (refreshToken) {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }).catch(() => {});
  }
  clearToken();
}

/** Sign out of every device (bumps the server-side token version). */
export async function logoutEverywhere(): Promise<void> {
  await authFetch(`/api/auth/logout-all`, { method: 'POST' }).catch(() => {});
  clearToken();
}

export interface AuthSession {
  id: number;
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  user_agent: string | null;
  ip: string | null;
}

export async function fetchSessions(): Promise<{ sessions: AuthSession[] }> {
  const response = await authFetch(`/api/auth/sessions`);
  if (!response.ok) throw new Error('Failed to fetch sessions');
  return response.json();
}

export async function revokeSession(sessionId: number): Promise<void> {
  const response = await authFetch(`/api/auth/sessions/${sessionId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to revoke session');
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
  const response = await authFetch(url);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function fetchAuthors(): Promise<string[]> {
  const response = await authFetch(`/api/authors`);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function fetchStats(): Promise<Stats> {
  const response = await authFetch(`/api/stats`);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function retryDownload(id: number): Promise<void> {
  await authFetch(`/api/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

export async function stopDownload(message_id: string): Promise<void> {
  await authFetch(`/api/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id }),
  });
}

export async function pauseDownload(message_id: string): Promise<void> {
  await authFetch(`/api/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id }),
  });
}

export async function resumeDownload(message_id: string): Promise<void> {
  await authFetch(`/api/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id }),
  });
}

export async function deleteDownload(message_id: string, delete_file: boolean = false): Promise<void> {
  await authFetch(`/api/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id, delete_file }),
  });
}

// Rename rules
export interface RenameRule {
  id: number;
  name: string | null;
  pattern: string;
  replacement: string;
  enabled: boolean;
  position: number;
  source: string | null;
  stop_on_match: boolean;
}

export type RenameRuleInput = Omit<RenameRule, 'id' | 'position'> & { position?: number };

export interface RenamePreviewRow {
  original: string;
  new: string;
  changed: boolean;
  applied: string[];
}

export interface RenameApplyItem {
  id: number;
  from: string;
  to: string;
  applied: string[];
  source: string | null;
  status: 'would_rename' | 'renamed' | 'missing' | 'failed';
  note?: string;
}

export interface RenameApplyResult {
  dry_run: boolean;
  total: number;
  renamed: number;
  skipped: number;
  failed: number;
  items: RenameApplyItem[];
}

const RULES = '/api/settings/rename-rules';

async function rulesRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(`${RULES}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : {},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || 'Request failed');
  return data as T;
}

export function fetchRenameRules(): Promise<{ rules: RenameRule[] }> {
  return rulesRequest('');
}

export function createRenameRule(rule: RenameRuleInput): Promise<{ rules: RenameRule[] }> {
  return rulesRequest('', { method: 'POST', body: JSON.stringify(rule) });
}

export function updateRenameRule(id: number, rule: RenameRuleInput): Promise<{ rules: RenameRule[] }> {
  return rulesRequest(`/${id}`, { method: 'PUT', body: JSON.stringify(rule) });
}

export function deleteRenameRule(id: number): Promise<{ rules: RenameRule[] }> {
  return rulesRequest(`/${id}`, { method: 'DELETE' });
}

export function reorderRenameRules(ids: number[]): Promise<{ rules: RenameRule[] }> {
  return rulesRequest('/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
}

/** Preview against real filenames. Pass `rule` to preview an unsaved draft alone. */
export function testRenameRules(rule?: RenameRuleInput | null): Promise<{
  results: RenamePreviewRow[]; changed: number; total: number;
}> {
  return rulesRequest('/test', { method: 'POST', body: JSON.stringify(rule ? { rule } : {}) });
}

export function applyRenameRules(dryRun: boolean): Promise<RenameApplyResult> {
  return rulesRequest('/apply', { method: 'POST', body: JSON.stringify({ dry_run: dryRun }) });
}

export async function checkUrl(url: string): Promise<UrlCheckResult> {
  const response = await authFetch(`/api/url/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const response = await authFetch(`/api/url/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const response = await authFetch(`/api/mappings`);
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function createMapping(
  data: { downloaded_from: string; folder?: string | null; quality?: string | null; is_secured?: boolean }
): Promise<SourceMapping | { error: string }> {
  const response = await authFetch(`/api/mappings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function updateMapping(
  id: number,
  data: Partial<{ downloaded_from: string; folder: string | null; quality: string | null; is_secured: boolean }>
): Promise<SourceMapping | { error: string }> {
  const response = await authFetch(`/api/mappings/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function deleteMapping(id: number): Promise<void> {
  const response = await authFetch(`/api/mappings/${id}`, {
    method: 'DELETE',
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete mapping');
  }
}

// Cookies API for yt-dlp authentication
export async function fetchCookies(): Promise<string> {
  const response = await authFetch(`/api/settings/cookies`);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const data = await response.json();
  return data.cookies || '';
}

export async function saveCookies(cookies: string): Promise<{ status?: string; error?: string }> {
  const response = await authFetch(`/api/settings/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  torrent_client?: TorrentClient | null;
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
  const response = await authFetch(`/api/settings/telegram${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
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

export function setChannelTorrentClient(chatId: number, client: TorrentClient | null): Promise<{ channels?: TelegramChannel[]; error?: string }> {
  return telegramRequest(`/channels/${chatId}`, { method: 'PATCH', body: JSON.stringify({ torrent_client: client }) });
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
  const response = await authFetch(`/api/users`);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function syncUsers(): Promise<{ synced?: number; users?: AppUser[]; error?: string }> {
  const response = await authFetch(`/api/users/sync`, {
    method: 'POST',
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function updateUserRole(userId: number, role: 'admin' | 'user'): Promise<{ user?: AppUser; error?: string }> {
  const response = await authFetch(`/api/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
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
  const response = await authFetch(`/api/settings/queries${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
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
  const response = await authFetch(`/api/settings/vps`);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function saveVpsConfig(config: VpsConfigInput): Promise<{ status?: string; configured?: boolean; has_password?: boolean; error?: string }> {
  const response = await authFetch(`/api/settings/vps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function testVpsConnection(config: VpsConfigInput): Promise<{ success: boolean; message?: string; error?: string }> {
  const response = await authFetch(`/api/settings/vps/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function deleteVpsConfig(): Promise<{ status?: string; configured?: boolean; error?: string }> {
  const response = await authFetch(`/api/settings/vps`, {
    method: 'DELETE',
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

// Torrent client (Transmission on the VPS) API
export type TorrentClient = 'transmission' | 'qbittorrent';

export interface TorrentClientConfig {
  configured: boolean;
  url: string;
  username: string;
  has_password: boolean;
  download_dir: string;
  incomplete_dir: string;
  local_dir: string;
}

export interface TorrentConfig {
  transmission: TorrentClientConfig;
  qbittorrent: TorrentClientConfig;
  telegram_default: TorrentClient | null;
}

export async function fetchTorrentConfig(): Promise<TorrentConfig> {
  const response = await authFetch(`/api/settings/torrent`);
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function saveTorrentConfig(
  client: TorrentClient,
  config: { url: string; username: string; password?: string; download_dir?: string; incomplete_dir?: string; local_dir?: string }
): Promise<{ status?: string; configured?: boolean; url?: string; has_password?: boolean; download_dir?: string; incomplete_dir?: string; local_dir?: string; warning?: string | null; error?: string }> {
  const response = await authFetch(`/api/settings/torrent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, ...config }),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function deleteTorrentConfig(client: TorrentClient): Promise<{ status?: string; error?: string }> {
  const response = await authFetch(`/api/settings/torrent?client=${client}`, {
    method: 'DELETE',
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function testTorrentConnection(
  client: TorrentClient,
  config: { url: string; username: string; password?: string }
): Promise<{ success: boolean; message?: string; error?: string }> {
  const response = await authFetch(`/api/settings/torrent/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, ...config }),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function setTelegramDefault(client: TorrentClient | null): Promise<{ status?: string; telegram_default?: TorrentClient | null; error?: string }> {
  const response = await authFetch(`/api/settings/torrent/telegram-default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client }),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export interface TorrentStatus {
  id: number;
  name: string;
  hash: string;
  status: 'stopped' | 'check-wait' | 'checking' | 'download-wait' | 'downloading' | 'seed-wait' | 'seeding' | 'unknown';
  percent_done: number;
  rate_download: number;
  rate_upload: number;
  total_size: number;
  eta: number | null;
  download_dir: string;
  error: string | null;
  peers_connected: number;
  seeds_connected: number;
  leeches_connected: number;
  seeds_total: number | null;
  leeches_total: number | null;
  added_date: number;
}

export async function fetchTorrentList(client: TorrentClient): Promise<{ configured: boolean; torrents?: TorrentStatus[]; error?: string }> {
  const response = await authFetch(`/api/torrent/list?client=${client}`);
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function torrentAction(
  client: TorrentClient, action: 'start' | 'stop' | 'remove' | 'verify', hashes: string[], deleteData = false
): Promise<{ status?: string; error?: string }> {
  const response = await authFetch(`/api/torrent/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, action, hashes, delete_data: deleteData }),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function addTorrent(
  magnet: string, client: TorrentClient, downloadDir?: string | null
): Promise<{ status?: 'added' | 'duplicate'; name?: string; hash?: string; error?: string }> {
  const response = await authFetch(`/api/torrent/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet, client, download_dir: downloadDir ?? null }),
  });
  if (response.status === 401) { clearToken(); window.location.reload(); }
  return response.json();
}

export async function addTorrentFile(
  file: File, client: TorrentClient, downloadDir?: string | null
): Promise<{ status?: 'added' | 'duplicate'; name?: string; hash?: string; error?: string }> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('client', client);
  if (downloadDir) fd.append('download_dir', downloadDir);
  // No Content-Type header: the browser sets the multipart boundary itself.
  const response = await authFetch(`/api/torrent/add-file`, {
    method: 'POST',
    body: fd,
  });
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
  const response = await authFetch(`/api/settings/vps/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const response = await authFetch(`/api/settings/local/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const response = await authFetch(`/api/settings/vps/folders`);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const data = await response.json();
  return data.folders || [];
}

export async function addVpsFolders(paths: string[]): Promise<VpsWatchFolder[]> {
  const response = await authFetch(`/api/settings/vps/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const response = await authFetch(`/api/settings/vps/folders/${id}`, {
    method: 'DELETE',
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
  const response = await authFetch(`/api/settings/vps/folders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
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

export async function fetchVpsFiles(includeHidden = false): Promise<VpsFolderGroup[]> {
  const response = await authFetch(`/api/vps/files${includeHidden ? '?include_hidden=true' : ''}`);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  const data = await response.json();
  return data.folders || [];
}

export async function downloadVpsFile(path: string, size?: number, client?: TorrentClient): Promise<{ error?: string; id?: number; message_id?: string }> {
  const response = await authFetch(`/api/vps/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, size: size ?? 0, ...(client ? { client } : {}) }),
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function deleteVpsRemote(path: string): Promise<{ status?: string; error?: string }> {
  const response = await authFetch(`/api/vps/delete-remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  const response = await authFetch(`/api/analytics?${params.toString()}`);
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
  const response = await authFetch(`/api/video/check/${downloadId}`);
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
  const response = await authFetch(`/api/jobs/sync-thumbnails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function getYtdlpVersion(): Promise<{ version: string | null; error?: string }> {
  const response = await authFetch(`/api/jobs/ytdlp-version`);
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

export async function upgradeYtdlp(): Promise<{ old_version?: string; new_version?: string; upgraded?: boolean; error?: string }> {
  const response = await authFetch(`/api/jobs/ytdlp-upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (response.status === 401) {
    clearToken();
    window.location.reload();
  }
  return response.json();
}

// --- Media tokens -----------------------------------------------------------
//
// <video> and <img> can't send an Authorization header, so their URLs carry a
// token in the query string. That is a separate, narrowly scoped token: valid
// only on the streaming/thumbnail routes and with its own expiry, so the API
// access token never lands in a URL, browser history or a proxy log.

let mediaTokenInFlight: Promise<string | null> | null = null;

export function getMediaToken(): string | null {
  return localStorage.getItem(MEDIA_TOKEN_KEY);
}

/** Mint (or reuse) the media token. Call before rendering media URLs. */
export async function ensureMediaToken(force = false): Promise<string | null> {
  if (!force) {
    const cached = getMediaToken();
    if (cached) return cached;
  }
  if (mediaTokenInFlight) return mediaTokenInFlight;

  mediaTokenInFlight = (async () => {
    try {
      const response = await authFetch(`/api/auth/media-token`);
      if (!response.ok) return null;
      const data = await response.json();
      if (!data.media_token) return null;
      localStorage.setItem(MEDIA_TOKEN_KEY, data.media_token);
      return data.media_token as string;
    } catch {
      return null;
    } finally {
      setTimeout(() => { mediaTokenInFlight = null; }, 0);
    }
  })();

  return mediaTokenInFlight;
}

export function getVideoStreamUrl(downloadId: number): string {
  return `${API_BASE}/api/video/stream/${downloadId}?token=${getMediaToken() ?? ''}`;
}

export function getThumbUrl(downloadId: number, filename: string): string {
  return `${API_BASE}/api/thumbs/${downloadId}/${filename}?token=${getMediaToken() ?? ''}`;
}


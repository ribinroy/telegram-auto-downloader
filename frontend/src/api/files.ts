// File explorer transport. Every call reads the host filesystem live - there
// is no server-side index, so a listing is always the drive's current state.
import { API_BASE, authFetch, getMediaToken } from './index';

export type FileKind =
  | 'folder' | 'video' | 'image' | 'audio' | 'archive' | 'document' | 'text' | 'file';

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_link: boolean;
  broken: boolean;
  hidden: boolean;
  size: number;
  modified: string | null;
  mode: string | null;
  kind: FileKind;
  ext: string;
}

export interface DiskUsage {
  total: number;
  used: number;
  free: number;
}

export interface FileListing {
  path: string;
  parent: string | null;
  name: string;
  entries: FileEntry[];
  writable: boolean;
  usage: DiskUsage | null;
  mount: string;
  /** Where a non-permanent delete parks files for this disk (null until used). */
  trash: string | null;
}

export interface FileRoot {
  path: string;
  label: string;
  kind: 'home' | 'downloads' | 'disk';
  device: string | null;
  fstype: string | null;
  usage: DiskUsage | null;
  writable: boolean;
}

export interface FileRootsResponse {
  roots: FileRoot[];
  readonly: boolean;
  home: string;
  default: string;
}

export interface FileOpResult {
  path: string;
  target?: string;
  trashed?: boolean;
  trash_path?: string;
  error?: string;
}

export interface FileOpResponse {
  results: FileOpResult[];
  errors: FileOpResult[];
}

export interface DirSize {
  path: string;
  size: number;
  files: number;
  dirs: number;
  partial: boolean;
}

export interface FileSearchResult {
  root: string;
  query: string;
  entries: FileEntry[];
  truncated: boolean;
}

async function filesRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await authFetch(`/api/files${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || 'Request failed');
  return data as T;
}

export const fetchFileRoots = () => filesRequest<FileRootsResponse>('/roots');

export const listFiles = (path?: string, showHidden = false) =>
  filesRequest<FileListing>('/list', { path: path ?? '', show_hidden: showHidden });

export const createFolder = (path: string, name: string) =>
  filesRequest<{ entry: FileEntry }>('/mkdir', { path, name });

export const renamePath = (path: string, name: string) =>
  filesRequest<{ entry: FileEntry }>('/rename', { path, name });

/** Default is a move to the mount's trash; `permanent` unlinks for real. */
export const deletePaths = (paths: string[], permanent = false) =>
  filesRequest<FileOpResponse>('/delete', { paths, permanent });

export const transferPaths = (paths: string[], dest: string, move: boolean) =>
  filesRequest<FileOpResponse>('/transfer', { paths, dest, move });

export const searchFiles = (path: string, query: string, showHidden = false) =>
  filesRequest<FileSearchResult>('/search', { path, query, show_hidden: showHidden });

export const dirSize = (path: string) => filesRequest<DirSize>('/size', { path });

export const readTextFile = (path: string) =>
  filesRequest<{ path: string; text: string; truncated: boolean; size: number }>('/text', { path });

export async function uploadFiles(dest: string, files: File[]): Promise<FileOpResponse & { entries: FileEntry[] }> {
  const form = new FormData();
  form.append('path', dest);
  files.forEach(f => form.append('files', f));
  const response = await authFetch('/api/files/upload', { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || 'Upload failed');
  return data as FileOpResponse & { entries: FileEntry[] };
}

// URL builders - these end up in <video>/<img> src and in link hrefs, so they
// carry the scoped media token rather than the API access token.
const mediaUrl = (route: string, path: string) =>
  `${API_BASE}/api/files/${route}?path=${encodeURIComponent(path)}&token=${getMediaToken() ?? ''}`;

export const getFileStreamUrl = (path: string) => mediaUrl('stream', path);
export const getFileDownloadUrl = (path: string) => mediaUrl('download', path);
export const getFileThumbUrl = (path: string) => mediaUrl('thumb', path);

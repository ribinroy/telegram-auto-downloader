export interface Download {
  id: number;
  message_id: string | null;  // UUID for yt-dlp or Telegram message ID as string
  file: string;
  status: 'downloading' | 'done' | 'failed' | 'stopped';
  progress: number;
  speed: number;
  error: string | null;
  updated_at: string;
  created_at: string;
  downloaded_bytes: number;
  total_bytes: number;
  pending_time: number | null;
  downloaded_from: string;  // 'telegram' or domain name
  url: string | null;  // Source URL for yt-dlp downloads
}

export interface VideoFormat {
  format_id: string;
  ext: string;
  resolution: string;
  height: number | null;
  width?: number;
  filesize: number | null;
  has_audio: boolean;
  tbr?: number;
  label: string;
}

export interface UrlCheckResult {
  supported: boolean;
  error?: string;
  title?: string;
  duration?: number;
  filesize?: number;
  ext?: string;
  uploader?: string;
  formats?: VideoFormat[];
  best_format_id?: string;
}

export interface Stats {
  total_downloaded: number;
  total_size: number;
  pending_bytes: number;
  total_speed: number;
  downloaded_count: number;
  total_count: number;
  all_count: number;
  active_count: number;
}

export interface DownloadsResponse {
  downloads: Download[];
  stats: Stats;
}

export interface DownloadTypeMap {
  id: number;
  downloaded_from: string;
  is_secured: boolean;
  folder: string | null;
  quality: string | null;
  created_at: string;
  updated_at: string;
}

export interface Download {
  id: number;
  message_id: number | null;
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
  downloaded_from: string;
  url: string | null;
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

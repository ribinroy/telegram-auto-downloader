export interface Download {
  id: number;
  file: string;
  status: 'downloading' | 'done' | 'failed' | 'stopped';
  progress: number;
  speed: number;
  error: string | null;
  timestamp: string;
  downloaded_bytes: number;
  total_bytes: number;
  pending_time: number | null;
}

export interface Stats {
  total_downloaded: number;
  total_size: number;
  pending_bytes: number;
  total_speed: number;
  downloaded_count: number;
  total_count: number;
}

export interface DownloadsResponse {
  downloads: Download[];
  stats: Stats;
}

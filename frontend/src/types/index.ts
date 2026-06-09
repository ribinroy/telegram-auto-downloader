export interface FileMeta {
  video?: {
    codec: string;
    width: number;
    height: number;
    bitrate?: number;
    fps?: number;
    bit_depth?: number;
  };
  audio?: {
    codec: string;
    channels?: number;
    sample_rate?: number;
    bitrate?: number;
  };
  duration?: number;
  format?: string;
}

export interface Download {
  id: number;
  message_id: string | null;  // UUID for yt-dlp or Telegram message ID as string
  file: string;
  status: 'downloading' | 'done' | 'failed' | 'stopped' | 'paused';
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
  file_deleted: boolean;  // True if physical file was deleted from disk
  author: string | null;  // username:id for telegram, username for downlee
  file_meta: FileMeta | null;  // Video/audio metadata for video files
  thumb_count: number;  // Number of thumbnail images available
  label_id?: number | null;  // Label this download is connected to
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
  has_more: boolean;
  total: number;
}

export interface Label {
  id: number;
  name: string;
  folder: string | null;
  quality: string | null;
  is_hidden: boolean;
  is_system: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface SourceLabel {
  id?: number;
  source: string;
  /** null = source-wide default; set = per-path override (e.g. a VPS folder). */
  path?: string | null;
  label_id: number | null;
}

// Analytics types
export interface TimeSeriesPoint {
  label: string;
  count: number;
  size: number;
}

export interface SourceData {
  source: string;
  count: number;
  size: number;
}

export interface AuthorData {
  author: string;
  count: number;
  size: number;
}

export interface HourlyData {
  hour: number;
  count: number;
}

export interface AnalyticsSummary {
  total_downloads: number;
  total_size: number;
  completed: number;
  failed: number;
  success_rate: number;
}

export interface AnalyticsData {
  time_series: TimeSeriesPoint[];
  by_source: SourceData[];
  by_author: AuthorData[];
  by_status: Record<string, number>;
  hourly_distribution: HourlyData[];
  summary: AnalyticsSummary;
  period_days: number;
  group_by: 'day' | 'hour';
}

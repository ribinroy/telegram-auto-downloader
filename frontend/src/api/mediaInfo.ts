import { authFetch } from './index';
import type { SubtitleSource } from './subtitles';

// Same two sources as the subtitle tracks: a download record or an explorer path.
export type MediaSource = SubtitleSource;

export interface MediaStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'attachment' | 'data' | string;
  codec: string | null;
  codec_long: string | null;
  profile: string | null;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  bitrate: number | null;
  // video
  width?: number | null;
  height?: number | null;
  aspect?: string | null;
  fps?: number | null;
  pix_fmt?: string | null;
  bit_depth?: number | null;
  color_space?: string | null;
  color_primaries?: string | null;
  color_transfer?: string | null;
  hdr?: string | null;
  attached_pic?: boolean;
  // audio
  channels?: number | null;
  channel_layout?: string | null;
  sample_rate?: number | null;
}

export interface MediaInfo {
  file: { name: string; path: string; size: number | null; modified: number | null };
  container: {
    format: string | null;
    format_long: string | null;
    duration: number | null;
    bitrate: number | null;
    tags: Record<string, string>;
  };
  streams: MediaStream[];
  chapters: { start: number | null; end: number | null; title: string | null }[];
}

export async function fetchMediaInfo(source: MediaSource): Promise<MediaInfo> {
  const response = 'downloadId' in source
    ? await authFetch(`/api/video/info/${source.downloadId}`)
    : await authFetch('/api/files/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: source.path }),
      });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || 'Failed to load video details');
  return data as MediaInfo;
}

import { API_BASE, authFetch, getMediaToken } from './index';

// Where a video's subtitles come from: the download record, or a path in
// the file explorer. The two routes return the same track shape.
export type SubtitleSource = { downloadId: number } | { path: string };

export interface SubtitleTrack {
  id: string;
  label: string;
  lang: string | null;
  kind: 'sidecar' | 'embedded';
  format: string;
  forced: boolean;
  default: boolean;
}

export const subtitleSourceKey = (s: SubtitleSource) =>
  'downloadId' in s ? `d:${s.downloadId}` : `p:${s.path}`;

export async function listSubtitleTracks(source: SubtitleSource): Promise<SubtitleTrack[]> {
  const response = 'downloadId' in source
    ? await authFetch(`/api/video/subtitles/${source.downloadId}`)
    : await authFetch('/api/files/subtitles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: source.path }),
      });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { error?: string }).error || 'Failed to list subtitles');
  return (data as { tracks: SubtitleTrack[] }).tracks;
}

// Ends up in a <track src>, which can't send a header - hence the media token.
export function getSubtitleUrl(source: SubtitleSource, trackId: string): string {
  const token = getMediaToken() ?? '';
  const track = encodeURIComponent(trackId);
  return 'downloadId' in source
    ? `${API_BASE}/api/video/subtitle/${source.downloadId}?track=${track}&token=${token}`
    : `${API_BASE}/api/files/subtitle?path=${encodeURIComponent(source.path)}&track=${track}&token=${token}`;
}

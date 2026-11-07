import type { MediaInfo, MediaStream } from '../api/mediaInfo';
import { formatBytes } from './format';

// Pure formatting for the player's info modal - kept out of the JSX so it
// can be tested directly.

export type Row = [label: string, value: string];

/** 1:02:05 / 4:07 - a clock, unlike formatTime's "1h 2m 5s". */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '-';
  const t = Math.floor(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatBitrate(bps: number | null | undefined): string | null {
  if (!bps || bps <= 0) return null;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(bps >= 10_000_000 ? 0 : 1)} Mb/s`;
  return `${Math.round(bps / 1000)} kb/s`;
}

/** 3840x2160 -> "4K", 1920x1080 -> "1080p"; by the larger side, so VR SBS frames read right. */
export function resolutionLabel(width?: number | null, height?: number | null): string | null {
  if (!width || !height) return null;
  const long = Math.max(width, height);
  if (long >= 7600) return '8K';
  if (long >= 5600) return '6K';
  if (long >= 3800) return '4K';
  if (long >= 2500) return '1440p';
  if (long >= 1900) return '1080p';
  if (long >= 1260) return '720p';
  if (long >= 840) return '480p';
  return `${Math.min(width, height)}p`;
}

const LAYOUTS: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };

export function channelsLabel(s: Pick<MediaStream, 'channels' | 'channel_layout'>): string | null {
  if (!s.channels) return null;
  return LAYOUTS[s.channels] ?? s.channel_layout ?? `${s.channels} ch`;
}

const kept = (rows: [string, string | null | undefined | false][]): Row[] =>
  rows.filter((r): r is Row => !!r[1]);

const codecLine = (s: MediaStream) =>
  [s.codec?.toUpperCase(), s.profile].filter(Boolean).join(' · ') || null;

export function streamRows(s: MediaStream): Row[] {
  const common: [string, string | null | undefined | false][] = [
    ['Codec', codecLine(s)],
    ['Language', s.language],
    ['Title', s.title],
    ['Bitrate', formatBitrate(s.bitrate)],
  ];
  if (s.type === 'video') {
    const res = s.width && s.height ? `${s.width} × ${s.height}` : null;
    const label = resolutionLabel(s.width, s.height);
    return kept([
      ...common.slice(0, 1),
      ['Resolution', res && (label ? `${res} (${label})` : res)],
      ['Aspect', s.aspect],
      ['Frame rate', s.fps ? `${s.fps} fps` : null],
      ['Bit depth', s.bit_depth ? `${s.bit_depth}-bit` : null],
      ['HDR', s.hdr],
      ['Pixel format', s.pix_fmt],
      ['Color', [s.color_primaries, s.color_transfer, s.color_space].filter(Boolean).join(' / ') || null],
      ...common.slice(1),
    ]);
  }
  if (s.type === 'audio') {
    return kept([
      ...common.slice(0, 1),
      ['Channels', channelsLabel(s)],
      ['Sample rate', s.sample_rate ? `${(s.sample_rate / 1000).toFixed(1)} kHz` : null],
      ...common.slice(1),
    ]);
  }
  return kept(common);
}

/** The headline under the filename: "4K · HEVC 10-bit HDR10 · 2:04:11 · 23.4 GB". */
export function summaryLine(info: MediaInfo): string {
  const v = info.streams.find(s => s.type === 'video' && !s.attached_pic);
  const parts = [
    v && resolutionLabel(v.width, v.height),
    v && [v.codec?.toUpperCase(), v.bit_depth && v.bit_depth > 8 ? `${v.bit_depth}-bit` : null, v.hdr]
      .filter(Boolean).join(' '),
    info.container.duration ? formatClock(info.container.duration) : null,
    info.file.size != null ? formatBytes(info.file.size) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function fileRows(info: MediaInfo): Row[] {
  const c = info.container;
  return kept([
    ['Path', info.file.path],
    ['Size', info.file.size != null ? `${formatBytes(info.file.size)} (${info.file.size.toLocaleString()} bytes)` : null],
    ['Modified', info.file.modified ? new Date(info.file.modified * 1000).toLocaleString() : null],
    ['Container', c.format_long || c.format],
    ['Duration', c.duration ? formatClock(c.duration) : null],
    ['Overall bitrate', formatBitrate(c.bitrate)],
    ...Object.entries(c.tags).map(([k, v]) => [k[0].toUpperCase() + k.slice(1).replace('_', ' '), v] as Row),
  ]);
}

const TYPE_LABEL: Record<string, string> = { video: 'Video', audio: 'Audio', subtitle: 'Subtitle', attachment: 'Attachment', data: 'Data' };

/** "Audio 2 · English · Default" - numbered within its type. */
export function streamHeading(s: MediaStream, all: MediaStream[]): string {
  const same = all.filter(o => o.type === s.type);
  const label = TYPE_LABEL[s.type] ?? s.type;
  const n = same.length > 1 ? ` ${same.indexOf(s) + 1}` : '';
  const flags = [s.attached_pic && 'Cover art', s.default && 'Default', s.forced && 'Forced'].filter(Boolean);
  return [`${label}${n}`, ...flags].join(' · ');
}

import type { Stats } from '../types';
import { formatBytes } from './format';

/** Bytes still to download across the queue - running + waiting. Falls back
 *  to the older `pending_bytes` from a server that predates the split. */
export function toDownloadBytes(stats: Stats): number {
  return stats.remaining_bytes ?? stats.pending_bytes ?? 0;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Tooltip lines for the header's "to download" pill. */
export function toDownloadDetail(stats: Stats): string[] {
  const lines = ['To download (running + waiting)'];
  const running = stats.running_count ?? 0;
  const waiting = stats.waiting_count ?? 0;
  if (running) lines.push(`${plural(running, 'running')}: ${formatBytes(stats.running_bytes ?? 0)} left`);
  if (waiting) lines.push(`${waiting} waiting: ${formatBytes(stats.waiting_bytes ?? 0)}`);
  if (stats.unsized_count) lines.push(`${plural(stats.unsized_count, 'download')} of unknown size not counted`);
  return lines;
}

/** Tooltip lines for the header's ETA pill. */
export function etaDetail(stats: Stats): string[] {
  const lines = ['Time left for the whole queue'];
  const remaining = toDownloadBytes(stats);
  if (remaining) lines.push(`${formatBytes(remaining)} to go, waiting downloads included`);
  if (stats.unsized_count) lines.push(`Not counting ${plural(stats.unsized_count, 'download')} of unknown size`);
  if (remaining && stats.eta_seconds == null) lines.push('Nothing is moving right now');
  return lines;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

export function formatTime(seconds: number | null): string {
  if (!seconds) return '-';
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatSpeed(speedKBps: number): string {
  if (speedKBps === 0) return '-';
  if (speedKBps >= 1024) {
    return `${(speedKBps / 1024).toFixed(1)} MB/s`;
  }
  return `${speedKBps.toFixed(1)} KB/s`;
}

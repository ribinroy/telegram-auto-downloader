import { describe, expect, it } from 'vitest';
import { queueSourceOf } from './useQueue';

describe('queueSourceOf', () => {
  it('matches the backend: vps and telegram by name, anything with a URL is yt-dlp', () => {
    expect(queueSourceOf({ downloaded_from: 'vps', url: '/home/u/a.mkv' })).toBe('vps');
    expect(queueSourceOf({ downloaded_from: 'telegram', url: null })).toBe('telegram');
    expect(queueSourceOf({ downloaded_from: 'youtube.com', url: 'https://youtu.be/x' })).toBe('ytdlp');
  });

  it('treats an unknown source with no URL as Telegram, as the backend does', () => {
    expect(queueSourceOf({ downloaded_from: 'legacy', url: null })).toBe('telegram');
  });
});

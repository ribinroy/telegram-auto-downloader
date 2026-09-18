import { describe, it, expect } from 'vitest';
import { isMagnetLink, magnetName } from './AddUrlModal';
import { isTorrentFile } from '../pages/DownloadsPage';

describe('isMagnetLink', () => {
  it('matches regardless of case and surrounding space', () => {
    expect(isMagnetLink('  MAGNET:?xt=urn:btih:abc  ')).toBe(true);
    expect(isMagnetLink('https://example.com/x.torrent')).toBe(false);
    expect(isMagnetLink('')).toBe(false);
  });
});

describe('magnetName', () => {
  it('reads the display name and decodes it', () => {
    expect(magnetName('magnet:?xt=urn:btih:abc&dn=My%20Movie')).toBe('My Movie');
    expect(magnetName('magnet:?dn=A+B')).toBe('A B');
  });

  it('returns null when the magnet carries no name', () => {
    expect(magnetName('magnet:?xt=urn:btih:abc')).toBeNull();
  });

  it('survives a malformed escape rather than throwing', () => {
    expect(magnetName('magnet:?dn=%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('isTorrentFile - what a drop accepts', () => {
  const file = (name: string, type = '') => new File([''], name, { type });

  it('accepts by extension, case-insensitively', () => {
    expect(isTorrentFile(file('ubuntu.torrent'))).toBe(true);
    expect(isTorrentFile(file('UBUNTU.TORRENT'))).toBe(true);
  });

  it('accepts by MIME type when the name has no extension', () => {
    expect(isTorrentFile(file('download', 'application/x-bittorrent'))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isTorrentFile(file('movie.mkv'))).toBe(false);
    expect(isTorrentFile(file('torrent.txt'))).toBe(false);
    expect(isTorrentFile(file('notes'))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { qk } from './queryKeys';

/** What `invalidateQueries({ queryKey: prefix })` matches: the key starts with the prefix. */
const under = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((part, i) => key[i] === part);

describe('query keys', () => {
  it('put every torrent key under the torrent prefix', () => {
    for (const key of [qk.torrentConfig(), qk.torrentList('transmission'), qk.torrentDetails('qbittorrent', 'abc')]) {
      expect(under(key, ['torrent'])).toBe(true);
    }
  });

  it('put every VPS key under the vps prefix', () => {
    for (const key of [qk.vpsConfig(), qk.vpsFolders(), qk.vpsFiles(true), qk.vpsUsage()]) {
      expect(under(key, ['vps'])).toBe(true);
    }
  });

  it('put every explorer key under the files prefix', () => {
    const keys = [
      qk.fileRoots(false), qk.fileList('/mnt', false), qk.fileSearch('/mnt', 'x', false),
      qk.fileSize('/mnt'), qk.fileText('/a.txt'), qk.fileTransfers(), qk.fileTransferFiles('j1'),
    ];
    for (const key of keys) expect(under(key, ['files'])).toBe(true);
  });

  it('put every Telegram key under the telegram prefix', () => {
    for (const key of [qk.telegramStatus(), qk.telegramApiConfig(), qk.telegramDialogs()]) {
      expect(under(key, ['telegram'])).toBe(true);
    }
  });

  it('group the speed-test and VR keys under their own prefixes', () => {
    expect(under(qk.internetSpeed(), ['speedtest'])).toBe(true);
    expect(under(qk.speedResults('browser'), ['speedtest', 'results'])).toBe(true);
    expect(under(qk.vrSettings(), ['vr'])).toBe(true);
    expect(under(qk.downloadProjection(3), ['vr'])).toBe(true);
  });

  it('keep the downloads list under the downloads prefix, with its filters in the key', () => {
    const a = qk.downloads({ search: 'cat' });
    const b = qk.downloads({ search: 'dog' });
    expect(under(a, ['downloads'])).toBe(true);
    expect(a).not.toEqual(b);
    expect(qk.downloads({ search: 'cat' })).toEqual(a);
  });

  it('keep a pull\'s file listing out of the downloads prefix the realtime layer patches', () => {
    expect(under(qk.transferFiles(5), ['downloads'])).toBe(false);
    expect(under(qk.fileTransferFiles('j'), ['downloads'])).toBe(false);
  });

  it('make a job\'s file listing a child of the transfers key', () => {
    expect(under(qk.fileTransferFiles('j1'), qk.fileTransfers())).toBe(true);
  });

  it('give every single-resource key its own top-level name', () => {
    const singles = {
      authors: qk.authors(), stats: qk.stats(), queue: qk.queue(), mappings: qk.mappings(), cookies: qk.cookies(),
      ytdlp: qk.ytdlpVersion(), jobs: qk.jobSchedules(), users: qk.users(), bot: qk.botQueries(), 'rename-rules': qk.renameRules(),
    };
    for (const [name, key] of Object.entries(singles)) expect(key[0]).toBe(name);
    const tops = Object.values(singles).map(k => k[0]);
    expect(new Set(tops).size).toBe(tops.length);
  });

  it('tell keys with different parameters apart', () => {
    expect(qk.torrentList('transmission')).not.toEqual(qk.torrentList('qbittorrent'));
    expect(qk.fileList('/a', false)).not.toEqual(qk.fileList('/a', true));
    expect(qk.analytics(7, 'day', false)).not.toEqual(qk.analytics(30, 'day', false));
    expect(qk.subtitles('d:1')).not.toEqual(qk.subtitles('p:/x'));
  });

  it('never let one domain\'s prefix match another\'s keys', () => {
    expect(under(qk.transferFiles(1), ['files'])).toBe(false);
    expect(under(qk.vpsFiles(false), ['files'])).toBe(false);
    expect(under(qk.torrentConfig(), ['vps'])).toBe(false);
  });
});

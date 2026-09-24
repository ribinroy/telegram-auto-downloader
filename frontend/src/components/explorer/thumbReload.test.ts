import { describe, expect, it } from 'vitest';
import { thumbsToReload } from './thumbReload';

describe('thumbsToReload', () => {
  it('reloads nothing on the first poll', () => {
    expect(thumbsToReload(null, { '/a.mp4': 'quick' })).toEqual([]);
  });

  it('reloads a first-pass preview once its sheet is ready', () => {
    expect(thumbsToReload({ '/a.mp4': 'quick' }, { '/a.mp4': 'ready' })).toEqual(['/a.mp4']);
  });

  it('rescues a cell that was still waiting on the server', () => {
    expect(thumbsToReload({ '/a.mp4': 'pending', '/b.mp4': 'waiting' },
      { '/a.mp4': 'quick', '/b.mp4': 'ready' })).toEqual(['/a.mp4', '/b.mp4']);
  });

  it('leaves unchanged and unservable previews alone', () => {
    expect(thumbsToReload({ '/a.mp4': 'quick', '/b.mp4': 'waiting' },
      { '/a.mp4': 'quick', '/b.mp4': 'none' })).toEqual([]);
  });
});

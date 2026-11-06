import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectProjection, splitProjection, wrapSubtitle, recallProjection, rememberProjection,
} from './vr';

describe('detectProjection', () => {
  it('leaves an untagged file flat, whatever its shape', () => {
    expect(detectProjection('Holiday 2024.mp4')).toBe('flat');
    expect(detectProjection('square-clip.mp4', 1)).toBe('flat');
    expect(detectProjection('wide.mkv', 2)).toBe('flat');
    expect(detectProjection('/Movies/Some.Film.2023.1080p.mkv', 16 / 9)).toBe('flat');
  });

  it('reads the common 180° tags', () => {
    expect(detectProjection('Scene_180_sbs.mp4')).toBe('180-sbs');
    expect(detectProjection('Scene_LR_180.mp4')).toBe('180-sbs');
    expect(detectProjection('Scene_180_TB.mp4')).toBe('180-tb');
    expect(detectProjection('Scene.180x180.3dh.mp4')).toBe('180-sbs');
    expect(detectProjection('Scene_MKX200.mp4')).toBe('180-sbs');
    expect(detectProjection('Scene_FISHEYE190_LR.mp4')).toBe('180-sbs');
    expect(detectProjection('Scene_180_mono.mp4')).toBe('180-mono');
  });

  it('reads 360° tags and defaults them to mono', () => {
    expect(detectProjection('Tour_360.mp4')).toBe('360-mono');
    expect(detectProjection('Tour_360_TB.mp4')).toBe('360-tb');
    expect(detectProjection('Tour_360_sbs.mp4')).toBe('360-sbs');
  });

  it('lets the aspect ratio settle the layout once the name says VR', () => {
    expect(detectProjection('Scene_180.mp4', 2)).toBe('180-sbs');
    expect(detectProjection('Scene_180.mp4', 1)).toBe('180-mono');
    expect(detectProjection('Scene_VR.mp4', 2)).toBe('180-sbs');
    expect(detectProjection('Scene_VR.mp4', 4)).toBe('360-sbs');
    expect(detectProjection('Tour_360.mp4', 1)).toBe('360-tb');
    expect(detectProjection('Tour_360.mp4', 2)).toBe('360-mono');
  });

  it('does not take a tag out of the middle of a word', () => {
    expect(detectProjection('Album180x.mp4')).toBe('flat');
    expect(detectProjection('Dialrbuddy.mp4')).toBe('flat');
    expect(detectProjection('Clubbing.mp4')).toBe('flat');
  });
});

describe('splitProjection', () => {
  it('splits layout and stereo', () => {
    expect(splitProjection('flat')).toEqual({ layout: 'flat', stereo: 'mono' });
    expect(splitProjection('180-sbs')).toEqual({ layout: '180', stereo: 'sbs' });
    expect(splitProjection('360-tb')).toEqual({ layout: '360', stereo: 'tb' });
  });
});

describe('remembered projection', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a manual pick per filename and forgets on null', () => {
    expect(recallProjection('a.mp4')).toBeNull();
    rememberProjection('a.mp4', '180-tb');
    expect(recallProjection('a.mp4')).toBe('180-tb');
    expect(recallProjection('b.mp4')).toBeNull();
    rememberProjection('a.mp4', null);
    expect(recallProjection('a.mp4')).toBeNull();
  });

  it('ignores a stored value that is not a projection', () => {
    localStorage.setItem('downlee:projection:a.mp4', 'bogus');
    expect(recallProjection('a.mp4')).toBeNull();
  });
});

describe('wrapSubtitle', () => {
  it('keeps explicit line breaks and wraps long ones', () => {
    expect(wrapSubtitle('one\ntwo')).toEqual(['one', 'two']);
    const long = 'the quick brown fox jumps over the lazy dog again and again and again';
    const lines = wrapSubtitle(long, 20);
    expect(lines.every(l => l.length <= 20)).toBe(true);
    expect(lines.join(' ')).toBe(long);
  });

  it('drops blank lines and collapses whitespace', () => {
    expect(wrapSubtitle('  a   b \n\n  \n c ')).toEqual(['a b', 'c']);
    expect(wrapSubtitle('')).toEqual([]);
  });
});

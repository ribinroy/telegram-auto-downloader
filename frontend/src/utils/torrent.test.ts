import { describe, expect, it } from 'vitest';
import { commonRoot } from './torrent';

describe('commonRoot', () => {
  it('finds the folder every file shares, whatever the torrent is called', () => {
    expect(commonRoot(['JUVR-281.8K/part1.mp4', 'JUVR-281.8K/part2.mp4'])).toBe('JUVR-281.8K');
    expect(commonRoot(['Show S01/Season/e01.mkv', 'Show S01/e02.mkv'])).toBe('Show S01');
  });

  it('has none for a single-file torrent or files in different folders', () => {
    expect(commonRoot(['movie.mkv'])).toBeNull();
    expect(commonRoot(['a/x.mkv', 'b/y.mkv'])).toBeNull();
    expect(commonRoot([])).toBeNull();
  });

  it('does not mistake a shared name prefix for a shared folder', () => {
    expect(commonRoot(['Show/e01.mkv', 'Show Extras/e02.mkv'])).toBeNull();
  });
});

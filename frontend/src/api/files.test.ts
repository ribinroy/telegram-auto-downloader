import { describe, it, expect } from 'vitest';
import { isRemotePath } from './files';

describe('isRemotePath', () => {
  it('only matches the vps: scheme', () => {
    expect(isRemotePath('vps:/home6/user')).toBe(true);
    expect(isRemotePath('vps:~')).toBe(true);
    expect(isRemotePath('/mnt/newhdd')).toBe(false);
    expect(isRemotePath('')).toBe(false);
    expect(isRemotePath(null)).toBe(false);
    expect(isRemotePath(undefined)).toBe(false);
  });

  it('does not match a local path that merely contains vps', () => {
    expect(isRemotePath('/mnt/vps:backup')).toBe(false);
  });
});

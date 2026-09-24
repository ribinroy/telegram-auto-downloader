import { describe, it, expect } from 'vitest';
import { splitPrefix, buildCrumbs } from './ExplorerToolbar';

const HOME = 'vps:/home6/tester';

describe('splitPrefix', () => {
  it('separates the vps scheme from the bare path', () => {
    expect(splitPrefix('vps:/home6/x')).toEqual(['vps:', '/home6/x']);
    expect(splitPrefix('/mnt/disk')).toEqual(['', '/mnt/disk']);
  });
});

describe('buildCrumbs - local paths', () => {
  it('is unchanged from the plain filesystem behaviour', () => {
    const { rootLabel, rootTarget, crumbs } = buildCrumbs('/mnt/newhdd/Downloads');
    expect(rootLabel).toBe('/');
    expect(rootTarget).toBe('/');
    expect(crumbs.map(c => c.target)).toEqual([
      '/mnt', '/mnt/newhdd', '/mnt/newhdd/Downloads',
    ]);
  });

  it('has no crumbs at the filesystem root', () => {
    expect(buildCrumbs('/').crumbs).toEqual([]);
  });
});

describe('buildCrumbs - the VPS drive', () => {
  it('keeps the vps: prefix on every target', () => {
    // Regression: split('/') used to yield targets like /vps:/home6, sending
    // a click to the local filesystem instead of the seedbox.
    const { crumbs } = buildCrumbs(`${HOME}/downloads/Show`, HOME);
    expect(crumbs.map(c => c.target)).toEqual([
      `${HOME}/downloads`,
      `${HOME}/downloads/Show`,
    ]);
    expect(crumbs.every(c => c.target.startsWith('vps:'))).toBe(true);
  });

  it('points the root button at the login home, not the local root', () => {
    const { rootLabel, rootTarget } = buildCrumbs(`${HOME}/downloads`, HOME);
    expect(rootTarget).toBe(HOME);
    expect(rootLabel).toBe('tester');
  });

  it('shows no crumbs at the home directory itself', () => {
    expect(buildCrumbs(HOME, HOME).crumbs).toEqual([]);
  });

  it('never offers a crumb above the home directory', () => {
    // /home6 is the provider's shared dir; the account cannot list it.
    const { crumbs } = buildCrumbs(`${HOME}/downloads`, HOME);
    expect(crumbs.some(c => c.target === 'vps:/home6')).toBe(false);
  });

  it('falls back to full crumbs for a path outside the home', () => {
    const { rootLabel, rootTarget, crumbs } = buildCrumbs('vps:/opt', HOME);
    expect(rootTarget).toBe('vps:/');
    expect(rootLabel).toBe('/');
    expect(crumbs.map(c => c.target)).toEqual(['vps:/opt']);
  });
});

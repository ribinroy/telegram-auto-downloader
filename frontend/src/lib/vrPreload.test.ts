import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real chunk pulls in three.js; what matters here is that the chunk is
// fetched, that a failed fetch is retried next time rather than remembered as
// done, and that nothing surfaces to the caller either way.
const chunk = { fail: false, loads: 0 };

/** A fresh copy of the module, with the player chunk mocked to `chunk`'s wishes. */
async function freshModule() {
  vi.resetModules();
  vi.doMock('../components/VRVideoPlayer', () => {
    chunk.loads += 1;
    if (chunk.fail) throw new Error('chunk failed to load');
    return { VRVideoPlayer: () => null };
  });
  return import('./vrPreload');
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  chunk.fail = false;
  chunk.loads = 0;
});

describe('loadVRPlayer', () => {
  it('resolves to the player module', async () => {
    const { loadVRPlayer } = await freshModule();
    const mod = await loadVRPlayer();
    expect(typeof mod.VRVideoPlayer).toBe('function');
    expect(chunk.loads).toBe(1);
  });
});

describe('preloadVRPlayer', () => {
  it('fetches the chunk once, however often it is called', async () => {
    const { preloadVRPlayer } = await freshModule();
    preloadVRPlayer();
    preloadVRPlayer();
    await settle();
    preloadVRPlayer();
    await settle();
    expect(chunk.loads).toBe(1);
  });

  it('swallows a failed fetch and tries again on the next call', async () => {
    chunk.fail = true;
    const { preloadVRPlayer } = await freshModule();
    expect(() => preloadVRPlayer()).not.toThrow();
    await settle();
    expect(chunk.loads).toBe(1);

    chunk.fail = false;
    preloadVRPlayer();
    await settle();
    expect(chunk.loads).toBe(2);
  });
});

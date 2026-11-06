// three.js is its own chunk (~0.5 MB) that the login page and the list never
// pay for. The split only hurts if the fetch happens when VR is switched on -
// that is the "Loading VR player" screen - so the chunk is fetched early
// instead: once the app is idle after sign-in, and again when a player mounts.
export const loadVRPlayer = () => import('../components/VRVideoPlayer');

let preloaded = false;
export function preloadVRPlayer() {
  if (preloaded) return;
  preloaded = true;
  void loadVRPlayer().catch(() => { preloaded = false; });
}

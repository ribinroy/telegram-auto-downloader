/**
 * Service worker registration.
 *
 * The worker is only emitted by production builds, so registration is skipped
 * in dev - a stale SW intercepting the Vite dev server is a common source of
 * "why isn't my change showing up".
 *
 * Updates are not forced on the user: a new worker installs in the background
 * and `onUpdateReady` fires so the UI can offer a reload. Until then the
 * current version keeps running, which matters on a page that may be watching
 * a download in progress.
 */
let waitingWorker: ServiceWorker | null = null;

export function registerServiceWorker(onUpdateReady?: () => void): void {
  if (import.meta.env.DEV) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

      // A worker already waiting from a previous visit.
      if (registration.waiting && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting;
        onUpdateReady?.();
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // `controller` is null on the very first install - that's a fresh
          // page, not an update, and must not prompt.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = installing;
            onUpdateReady?.();
          }
        });
      });

      // Look for a new build when the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {});
      });
    } catch {
      // A failed registration must never break the app.
    }
  });
}

/** Activate the waiting worker and reload once it has taken over. */
export function applyUpdate(): void {
  if (!waitingWorker) {
    window.location.reload();
    return;
  }
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  waitingWorker.postMessage('SKIP_WAITING');
}

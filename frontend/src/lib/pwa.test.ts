import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stubReload } from '../test/http';

// A fake navigator.serviceWorker: register() answers with a registration the
// test can drive (a waiting worker, an `updatefound` with an installing one),
// and `controller` says whether this page already had a worker.
type Listener = (ev?: unknown) => void;

function fakeWorker() {
  const listeners: Record<string, Listener[]> = {};
  return {
    state: 'installing',
    postMessage: vi.fn(),
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
    fire: (type: string) => (listeners[type] ?? []).forEach(fn => fn()),
  };
}

function fakeRegistration(over: { waiting?: ReturnType<typeof fakeWorker> | null } = {}) {
  const listeners: Record<string, Listener[]> = {};
  return {
    waiting: over.waiting ?? null,
    installing: null as ReturnType<typeof fakeWorker> | null,
    update: vi.fn(() => Promise.resolve()),
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
    fire: (type: string) => (listeners[type] ?? []).forEach(fn => fn()),
  };
}

function installFakeServiceWorker(registration: ReturnType<typeof fakeRegistration> | Error, controller: object | null) {
  const listeners: Record<string, Listener[]> = {};
  const sw = {
    controller,
    register: vi.fn(() => (registration instanceof Error ? Promise.reject(registration) : Promise.resolve(registration))),
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
    fire: (type: string) => (listeners[type] ?? []).forEach(fn => fn()),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
  return sw;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// registerServiceWorker waits for the window's `load`. Dispatching that event
// would also re-run every listener earlier tests left on the shared window, so
// the listener is captured and called directly instead.
function captureLoad() {
  const spy = vi.spyOn(window, 'addEventListener');
  return async () => {
    const call = spy.mock.calls.find(([type]) => type === 'load');
    if (!call) throw new Error('no load listener registered');
    await (call[1] as () => Promise<void>)();
    await flush();
  };
}

// The module keeps the waiting worker in module state, so each test gets a
// fresh copy of it.
async function loadPwa() {
  vi.resetModules();
  return await import('./pwa');
}

beforeEach(() => {
  vi.stubEnv('DEV', false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe('registerServiceWorker', () => {
  it('does nothing in dev - a stale worker over the Vite server is a classic trap', async () => {
    vi.stubEnv('DEV', true);
    const sw = installFakeServiceWorker(fakeRegistration(), null);
    const { registerServiceWorker } = await loadPwa();
    const load = captureLoad();
    registerServiceWorker();
    await expect(load()).rejects.toThrow('no load listener registered');
    expect(sw.register).not.toHaveBeenCalled();
  });

  it('does nothing when the browser has no service workers', async () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    const { registerServiceWorker } = await loadPwa();
    const load = captureLoad();
    expect(() => registerServiceWorker()).not.toThrow();
    await expect(load()).rejects.toThrow('no load listener registered');
  });

  it('registers /sw.js on load and reports a worker already waiting from a previous visit', async () => {
    const waiting = fakeWorker();
    const registration = fakeRegistration({ waiting });
    const sw = installFakeServiceWorker(registration, {});
    const { registerServiceWorker } = await loadPwa();
    const load = captureLoad();
    const onUpdateReady = vi.fn();
    registerServiceWorker(onUpdateReady);
    expect(sw.register).not.toHaveBeenCalled();   // only once the page has loaded
    await load();
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('a waiting worker on a page with no controller is a first install, not an update', async () => {
    const registration = fakeRegistration({ waiting: fakeWorker() });
    installFakeServiceWorker(registration, null);
    const { registerServiceWorker } = await loadPwa();
    const load = captureLoad();
    const onUpdateReady = vi.fn();
    registerServiceWorker(onUpdateReady);
    await load();
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('fires update-ready once a newly found worker has installed behind a controlled page', async () => {
    const registration = fakeRegistration();
    installFakeServiceWorker(registration, {});
    const { registerServiceWorker } = await loadPwa();
    const load = captureLoad();
    const onUpdateReady = vi.fn();
    registerServiceWorker(onUpdateReady);
    await load();

    // updatefound with nothing installing is ignored
    registration.fire('updatefound');
    const installing = fakeWorker();
    registration.installing = installing;
    registration.fire('updatefound');
    installing.fire('statechange');             // still 'installing'
    expect(onUpdateReady).not.toHaveBeenCalled();
    installing.state = 'installed';
    installing.fire('statechange');
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('a first install (no controller) never prompts', async () => {
    const registration = fakeRegistration();
    installFakeServiceWorker(registration, null);
    const { registerServiceWorker } = await loadPwa();
    const load = captureLoad();
    const onUpdateReady = vi.fn();
    registerServiceWorker(onUpdateReady);
    await load();
    const installing = fakeWorker();
    registration.installing = installing;
    registration.fire('updatefound');
    installing.state = 'installed';
    installing.fire('statechange');
    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('checks for a new build when the tab becomes visible again', async () => {
    const registration = fakeRegistration();
    registration.update.mockImplementation(() => Promise.reject(new Error('offline')));
    installFakeServiceWorker(registration, {});
    const { registerServiceWorker } = await loadPwa();
    const load = captureLoad();
    registerServiceWorker();
    await load();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).toHaveBeenCalledTimes(1);
    await flush();   // the rejected update() is swallowed
  });

  it('a failed registration is swallowed', async () => {
    installFakeServiceWorker(new Error('no sw'), {});
    const { registerServiceWorker } = await loadPwa();
    const load = captureLoad();
    const onUpdateReady = vi.fn();
    registerServiceWorker(onUpdateReady);
    await load();
    expect(onUpdateReady).not.toHaveBeenCalled();
  });
});

describe('applyUpdate', () => {
  it('with no waiting worker it just reloads', async () => {
    installFakeServiceWorker(fakeRegistration(), {});
    const { reload, restore } = stubReload();
    try {
      const { applyUpdate } = await loadPwa();
      applyUpdate();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  it('tells the waiting worker to take over and reloads once when it does', async () => {
    const waiting = fakeWorker();
    const sw = installFakeServiceWorker(fakeRegistration({ waiting }), {});
    const { reload, restore } = stubReload();
    try {
      const { registerServiceWorker, applyUpdate } = await loadPwa();
      const load = captureLoad();
      registerServiceWorker();
      await load();
      applyUpdate();
      expect(reload).not.toHaveBeenCalled();
      expect(waiting.postMessage).toHaveBeenCalledWith('SKIP_WAITING');
      sw.fire('controllerchange');
      sw.fire('controllerchange');   // the browser can fire it more than once
      expect(reload).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });
});

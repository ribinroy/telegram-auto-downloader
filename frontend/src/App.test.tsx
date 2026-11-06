import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Outlet } from 'react-router-dom';
import * as api from './api';
import { preloadVRPlayer } from './lib/vrPreload';
import App from './App';

vi.mock('./api', () => ({
  verifyToken: vi.fn(), clearToken: vi.fn(), getToken: vi.fn(), logout: vi.fn(),
  ensureMediaToken: vi.fn(), setSessionExpiredHandler: vi.fn(), startMediaTokenKeeper: vi.fn(),
}));
vi.mock('./lib/vrPreload', () => ({ preloadVRPlayer: vi.fn() }));
vi.mock('./components/LoginPage', () => ({
  LoginPage: ({ onLogin }: { onLogin: () => void }) => <button onClick={onLogin}>fake-login</button>,
}));
vi.mock('./components/Layout', () => ({
  Layout: ({ onLogout }: { onLogout: () => void }) => (
    <div data-testid="layout"><button onClick={onLogout}>fake-logout</button><Outlet /></div>
  ),
}));
vi.mock('./pages/DownloadsPage', () => ({ DownloadsPage: () => <div>downloads-page</div> }));
vi.mock('./pages/AnalyticsPage', () => ({ AnalyticsPage: () => <div>analytics-page</div> }));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => <div>settings-page</div> }));
vi.mock('./pages/VpsPage', () => ({ VpsPage: () => <div>vps-page</div> }));
vi.mock('./pages/ExplorerPage', () => ({ ExplorerPage: () => <div>explorer-page</div> }));

const renderApp = (path = '/') => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

const stopKeeper = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getToken).mockReturnValue('tok');
  vi.mocked(api.verifyToken).mockResolvedValue({ valid: true, mustChangePassword: false });
  vi.mocked(api.ensureMediaToken).mockResolvedValue('media');
  vi.mocked(api.startMediaTokenKeeper).mockReturnValue(stopKeeper);
  vi.mocked(api.logout).mockResolvedValue(undefined);
  // Run idle callbacks at once, so the preload is observable without timers
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true, writable: true,
    value: vi.fn((cb: () => void) => { cb(); return 7; }),
  });
  Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
  delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
});

describe('App - auth bootstrap', () => {
  it('shows a spinner, then the app once the token verifies, minting a media token first', async () => {
    renderApp();
    expect(screen.queryByTestId('layout')).toBeNull();
    expect(screen.queryByText('fake-login')).toBeNull();
    expect(await screen.findByTestId('layout')).toBeInTheDocument();
    expect(screen.getByText('downloads-page')).toBeInTheDocument();
    expect(api.verifyToken).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.ensureMediaToken).toHaveBeenCalled());
    expect(api.clearToken).not.toHaveBeenCalled();
  });

  it('with no stored token goes straight to the login page without verifying', async () => {
    vi.mocked(api.getToken).mockReturnValue(null);
    renderApp();
    expect(await screen.findByText('fake-login')).toBeInTheDocument();
    expect(api.verifyToken).not.toHaveBeenCalled();
    expect(api.startMediaTokenKeeper).not.toHaveBeenCalled();
    expect(preloadVRPlayer).not.toHaveBeenCalled();
  });

  it('an invalid token is cleared and the login page shown', async () => {
    vi.mocked(api.verifyToken).mockResolvedValue({ valid: false, mustChangePassword: false });
    renderApp();
    expect(await screen.findByText('fake-login')).toBeInTheDocument();
    expect(api.clearToken).toHaveBeenCalledTimes(1);
    expect(api.ensureMediaToken).not.toHaveBeenCalled();
  });

  it('a pending forced password change drops the token so the login flow asks for it', async () => {
    vi.mocked(api.verifyToken).mockResolvedValue({ valid: true, mustChangePassword: true });
    renderApp();
    expect(await screen.findByText('fake-login')).toBeInTheDocument();
    expect(api.clearToken).toHaveBeenCalledTimes(1);
    expect(api.ensureMediaToken).not.toHaveBeenCalled();
  });

  it('the login page\'s callback signs the user in', async () => {
    vi.mocked(api.getToken).mockReturnValue(null);
    renderApp();
    fireEvent.click(await screen.findByText('fake-login'));
    expect(await screen.findByTestId('layout')).toBeInTheDocument();
  });

  it('logout revokes the session server-side and returns to the login page', async () => {
    renderApp();
    fireEvent.click(await screen.findByText('fake-logout'));
    expect(await screen.findByText('fake-login')).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalledTimes(1);
  });
});

describe('App - while signed in', () => {
  it('runs the media token keeper and stops it on sign-out', async () => {
    renderApp();
    await screen.findByTestId('layout');
    expect(api.startMediaTokenKeeper).toHaveBeenCalledTimes(1);
    expect(stopKeeper).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('fake-logout'));
    await screen.findByText('fake-login');
    expect(stopKeeper).toHaveBeenCalledTimes(1);
  });

  it('preloads the VR player on an idle callback and cancels it on sign-out', async () => {
    renderApp();
    await screen.findByTestId('layout');
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(preloadVRPlayer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('fake-logout'));
    await screen.findByText('fake-login');
    expect(window.cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it('falls back to a 2s timer where requestIdleCallback is missing', async () => {
    delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    renderApp();
    await screen.findByTestId('layout');
    vi.useFakeTimers();
    try {
      // The effect re-runs only on auth changes, so the timer was armed with
      // real timers; force a re-arm by signing out and back in under fake ones.
      act(() => { fireEvent.click(screen.getByText('fake-logout')); });
      await act(async () => { await Promise.resolve(); });
      act(() => { fireEvent.click(screen.getByText('fake-login')); });
      vi.mocked(preloadVRPlayer).mockClear();
      act(() => { vi.advanceTimersByTime(1999); });
      expect(preloadVRPlayer).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(preloadVRPlayer).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the session-expired handler clears the token and shows the login page', async () => {
    renderApp();
    await screen.findByTestId('layout');
    const handler = vi.mocked(api.setSessionExpiredHandler).mock.calls.at(-1)?.[0];
    expect(handler).toBeTypeOf('function');
    act(() => { handler!(); });
    expect(await screen.findByText('fake-login')).toBeInTheDocument();
    expect(api.clearToken).toHaveBeenCalled();
    expect(api.logout).not.toHaveBeenCalled();   // the session is already gone
  });

  it('routes the settings and vps tabs, the explorer and analytics', async () => {
    renderApp('/settings/vps');
    expect(await screen.findByText('settings-page')).toBeInTheDocument();
  });

  it.each([
    ['/files', 'explorer-page'],
    ['/analytics', 'analytics-page'],
    ['/vps/transmission', 'vps-page'],
    ['/settings', 'settings-page'],
  ])('renders %s', async (path, text) => {
    renderApp(path);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});

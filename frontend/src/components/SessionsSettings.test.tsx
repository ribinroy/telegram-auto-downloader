import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as api from '../api';
import { captureToasts } from '../test/toasts';
import { SessionsSettings } from './SessionsSettings';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()), fetchSessions: vi.fn(), revokeSession: vi.fn(), logoutEverywhere: vi.fn(),
}));

const NOW = new Date('2026-11-06T12:00:00Z').getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const session = (over: Partial<api.AuthSession> = {}): api.AuthSession => ({
  id: 1, created_at: minutesAgo(600), last_used_at: minutesAgo(0), expires_at: null,
  user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  ip: '10.0.0.2', ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('SessionsSettings', () => {
  it('loads the devices and names each from its user agent', async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [
      session(),
      session({ id: 2, user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', ip: null, last_used_at: minutesAgo(5) }),
      session({ id: 3, user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0', last_used_at: minutesAgo(3 * 60) }),
      session({ id: 4, user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0', last_used_at: minutesAgo(3 * 24 * 60) }),
      session({ id: 5, user_agent: 'Mozilla/5.0 (Android 14; Mobile) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 OPR/80.0', last_used_at: null }),
      session({ id: 6, user_agent: null, last_used_at: 'not a date' }),
      session({ id: 7, user_agent: 'curl/8.0', last_used_at: minutesAgo(30) }),
    ] });
    render(<SessionsSettings onSignedOut={() => {}} />);
    expect(screen.getByText('Loading sessions...')).toBeInTheDocument();
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
    expect(screen.getByText('Firefox on Windows')).toBeInTheDocument();
    expect(screen.getByText('Edge on Linux')).toBeInTheDocument();
    expect(screen.getByText('Opera on Android')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown device')).toHaveLength(2);
    expect(screen.getByText('10.0.0.2 · last used just now')).toBeInTheDocument();
    expect(screen.getByText('unknown IP · last used 5m ago')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.2 · last used 3h ago')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.2 · last used 3d ago')).toBeInTheDocument();
    expect(screen.getAllByText('10.0.0.2 · last used unknown')).toHaveLength(2);
    expect(screen.getByText('10.0.0.2 · last used 30m ago')).toBeInTheDocument();
  });

  it('says so when there are no sessions', async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [] });
    render(<SessionsSettings onSignedOut={() => {}} />);
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('a failed load is a toast', async () => {
    vi.mocked(api.fetchSessions).mockRejectedValue(new Error('boom'));
    const capture = captureToasts();
    render(<SessionsSettings onSignedOut={() => {}} />);
    await waitFor(() => expect(capture.titles()).toContain('Sessions'));
    expect(capture.toasts[0].message).toBe('Could not load your active sessions');
    capture.stop();
  });

  it('signing one device out revokes it and reloads the list', async () => {
    vi.mocked(api.fetchSessions)
      .mockResolvedValueOnce({ sessions: [session(), session({ id: 2, ip: '10.0.0.3' })] })
      .mockResolvedValueOnce({ sessions: [session()] });
    vi.mocked(api.revokeSession).mockResolvedValue(undefined);
    render(<SessionsSettings onSignedOut={() => {}} />);
    const buttons = await screen.findAllByTitle('Sign this device out');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(api.revokeSession).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.getAllByTitle('Sign this device out')).toHaveLength(1));
    expect(api.fetchSessions).toHaveBeenCalledTimes(2);
  });

  it('a revoke that fails toasts and re-enables the buttons', async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [session()] });
    vi.mocked(api.revokeSession).mockRejectedValue(new Error('nope'));
    const capture = captureToasts();
    render(<SessionsSettings onSignedOut={() => {}} />);
    const button = await screen.findByTitle('Sign this device out');
    fireEvent.click(button);
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Could not sign that device out'));
    expect(button).toBeEnabled();
    capture.stop();
  });

  it('"sign out everywhere" revokes every session, this one included', async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [session()] });
    vi.mocked(api.logoutEverywhere).mockResolvedValue(undefined);
    const onSignedOut = vi.fn();
    render(<SessionsSettings onSignedOut={onSignedOut} />);
    await screen.findByText('Chrome on macOS');
    fireEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }));
    await waitFor(() => expect(api.logoutEverywhere).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { deferred } from '../test/fixtures';
import { LoginPage } from './LoginPage';

vi.mock('../api', () => ({
  login: vi.fn(), updatePassword: vi.fn(), setTokens: vi.fn(), ensureMediaToken: vi.fn(),
}));

const loginResponse = (over: Partial<api.LoginResponse> = {}): api.LoginResponse => ({
  token: 'acc', refresh_token: 'ref', expires_in: 1800, user: 'admin', must_change_password: false, ...over,
} as api.LoginResponse);

const fillAndSubmit = (username = 'admin', password = 'secret') => {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.ensureMediaToken).mockResolvedValue('media');
});

describe('LoginPage - sign in', () => {
  it('shows the branding and a login form with no error', () => {
    renderWithClient(<LoginPage onLogin={() => {}} />);
    expect(screen.getByRole('heading', { name: 'DownLee' })).toBeInTheDocument();
    expect(screen.getByAltText('DownLee logo')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveFocus();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it('stores the token pair, mints a media token and signs in', async () => {
    const gate = deferred<api.LoginResponse>();
    vi.mocked(api.login).mockReturnValue(gate.promise);
    const onLogin = vi.fn();
    renderWithClient(<LoginPage onLogin={onLogin} />);
    fillAndSubmit('admin', 'hunter2');
    await waitFor(() => expect(api.login).toHaveBeenCalledWith('admin', 'hunter2'));
    // Pending: the button is disabled and reads "Signing in..."
    expect(await screen.findByRole('button', { name: /signing in/i })).toBeDisabled();
    gate.resolve(loginResponse());
    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(api.setTokens).toHaveBeenCalledWith('acc', 'ref');
    expect(api.ensureMediaToken).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows the server\'s error inline and keeps the form', async () => {
    vi.mocked(api.login).mockRejectedValue(new Error('Invalid credentials'));
    const onLogin = vi.fn();
    renderWithClient(<LoginPage onLogin={onLogin} />);
    fillAndSubmit();
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
    expect(api.setTokens).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });

  it('falls back to a generic message when the failure is not an Error', async () => {
    vi.mocked(api.login).mockRejectedValue('boom');
    renderWithClient(<LoginPage onLogin={() => {}} />);
    fillAndSubmit();
    expect(await screen.findByText('Login failed')).toBeInTheDocument();
    // A new attempt clears the old error first
    vi.mocked(api.login).mockRejectedValue(new Error('Locked out'));
    fillAndSubmit();
    expect(await screen.findByText('Locked out')).toBeInTheDocument();
    expect(screen.queryByText('Login failed')).toBeNull();
  });
});

describe('LoginPage - forced password change', () => {
  const signInWithDefault = async () => {
    vi.mocked(api.login).mockResolvedValue(loginResponse({ must_change_password: true }));
    const onLogin = vi.fn();
    renderWithClient(<LoginPage onLogin={onLogin} />);
    fillAndSubmit('admin', 'admin');
    expect(await screen.findByText(/using the default password/i)).toBeInTheDocument();
    return onLogin;
  };

  const setNew = (newPassword: string, confirm = newPassword) => {
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: newPassword } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: confirm } });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
  };

  it('switches to the change-password step without signing in, tokens stored', async () => {
    const onLogin = await signInWithDefault();
    expect(onLogin).not.toHaveBeenCalled();
    expect(api.setTokens).toHaveBeenCalledWith('acc', 'ref');
    expect(api.ensureMediaToken).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });

  it('validates the new password before calling the server', async () => {
    await signInWithDefault();
    setNew('longenough1', 'different');
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
    setNew('admin');
    expect(screen.getByText("The default password 'admin' is not allowed")).toBeInTheDocument();
    setNew('short');
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
    expect(api.updatePassword).not.toHaveBeenCalled();
  });

  it('changes the password with the one just used to sign in, then signs in', async () => {
    vi.mocked(api.updatePassword).mockResolvedValue(undefined);
    const onLogin = await signInWithDefault();
    setNew('correct horse battery');
    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(api.updatePassword).toHaveBeenCalledWith('admin', 'correct horse battery');
    expect(api.ensureMediaToken).toHaveBeenCalledWith(true);
  });

  it('reports a failed change and stays on the step', async () => {
    vi.mocked(api.updatePassword).mockRejectedValue(new Error('Too weak'));
    const onLogin = await signInWithDefault();
    setNew('correct horse battery');
    expect(await screen.findByText('Too weak')).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
    vi.mocked(api.updatePassword).mockRejectedValue(42);
    setNew('correct horse battery');
    expect(await screen.findByText('Failed to update password')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
  });
});

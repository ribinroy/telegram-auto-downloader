import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import * as api from '../api';
import { renderWithClient } from '../test/queryWrapper';
import { captureToasts } from '../test/toasts';
import { qk } from '../api/queryKeys';
import { UsersSettings } from './UsersSettings';

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof api>()), fetchUsers: vi.fn(), syncUsers: vi.fn(), updateUserRole: vi.fn(),
}));

const user = (over: Partial<api.AppUser> = {}): api.AppUser => ({
  id: 1, username: 'admin', role: 'admin', telegram_id: null, display_name: null, is_web: true, created_at: null, ...over,
});
const web = user();
const tg = user({ id: 2, username: 'alice', role: 'user', telegram_id: '4242', display_name: 'Alice A', is_web: false });

beforeEach(() => { vi.resetAllMocks(); });

describe('UsersSettings', () => {
  it('spins while loading, then lists web and Telegram users differently', async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [web, tg] });
    const { container } = renderWithClient(<UsersSettings />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    expect(await screen.findByText('Alice A')).toBeInTheDocument();
    expect(screen.getByText('@alice · 4242')).toBeInTheDocument();
    expect(screen.getByText('@admin')).toBeInTheDocument();
    expect(screen.getByTitle('Web login account')).toBeInTheDocument();
    expect(screen.getByTitle('Telegram user')).toBeInTheDocument();
    // A web login is always an admin - a label, not a picker
    expect(screen.getByTitle('Web login users are always admins')).toHaveTextContent('admin');
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getByRole('combobox')).toHaveValue('user');
    expect(screen.queryByText(/appear here automatically/)).toBeNull();
  });

  it('with only web accounts, explains where Telegram users come from', async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [web] });
    renderWithClient(<UsersSettings />);
    expect(await screen.findByText(/Telegram users appear here automatically/)).toBeInTheDocument();
  });

  it('changing a role saves it and refreshes the list', async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [web, tg] });
    vi.mocked(api.updateUserRole).mockResolvedValue({ user: { ...tg, role: 'admin' } });
    const { client } = renderWithClient(<UsersSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'admin' } });
    await waitFor(() => expect(api.updateUserRole).toHaveBeenCalledWith(2, 'admin'));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.users() }));
  });

  it('a refused role change is a toast', async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [tg] });
    vi.mocked(api.updateUserRole).mockResolvedValue({ error: 'Cannot demote the last admin' });
    const capture = captureToasts();
    renderWithClient(<UsersSettings />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'admin' } });
    await waitFor(() => expect(capture.titles()).toContain('Users'));
    expect(capture.toasts[0].message).toBe('Cannot demote the last admin');
    capture.stop();
  });

  it('a network failure on the role change toasts too', async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [tg] });
    vi.mocked(api.updateUserRole).mockRejectedValue(new Error('offline'));
    const capture = captureToasts();
    renderWithClient(<UsersSettings />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'admin' } });
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to update role'));
    capture.stop();
  });

  it('syncing group members reports the count', async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [web] });
    vi.mocked(api.syncUsers).mockResolvedValue({ synced: 3, users: [web, tg] });
    const { client } = renderWithClient(<UsersSettings />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: /sync members/i }));
    expect(await screen.findByText('Synced 3 group member(s)')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.users() });
  });

  it('a sync the bot cannot do is a toast', async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [web] });
    vi.mocked(api.syncUsers).mockResolvedValue({ error: 'Not signed in to Telegram' });
    const capture = captureToasts();
    renderWithClient(<UsersSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /sync members/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Not signed in to Telegram'));
    expect(screen.queryByText(/Synced/)).toBeNull();
    capture.stop();
  });

  it('a sync that throws is a generic toast', async () => {
    vi.mocked(api.fetchUsers).mockResolvedValue({ users: [web] });
    vi.mocked(api.syncUsers).mockRejectedValue(new Error('boom'));
    const capture = captureToasts();
    renderWithClient(<UsersSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /sync members/i }));
    await waitFor(() => expect(capture.toasts.map(t => t.message)).toContain('Failed to sync group members'));
    capture.stop();
  });
});
